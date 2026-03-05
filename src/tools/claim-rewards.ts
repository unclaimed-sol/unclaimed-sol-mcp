import { z } from 'zod';
import { Transaction } from '@solana/web3.js';
import { Config } from '../config.js';
import {
  ScannerService,
  RewardsBuildTxResponse,
} from '../services/scanner.js';
import {
  TransactionValidationError,
  validateTransactionPrograms,
} from '../services/transaction.js';
import { SignerService } from '../services/signer.js';
import {
  validateWalletAddress,
  verifyWalletMatchesKeypair,
  WalletValidationError,
} from '../validation.js';
import { formatSol, formatSolFromLamports } from '../formatter.js';
import { WEBSITE_URL, REWARDS_FEE_BPS } from '../constants.js';
import {
  ExecutionTokenStore,
  ExecutionTokenError,
} from '../execution-token-store.js';

// ---- Execution Token Store ----

const tokenStore = new ExecutionTokenStore<RewardsBuildTxResponse>(
  'claim_rewards',
);

// ---- Tool Definition ----

export function getClaimRewardsToolDefinition(keypairWallet?: string) {
  const walletDesc = keypairWallet
    ? `Solana wallet address. Must match configured keypair. Defaults to ${keypairWallet}`
    : 'Solana wallet address. Must match configured keypair.';

  return {
    name: 'claim_rewards',
    description:
      'Claim uncollected DeFi rewards (cashback, creator fees, and more) for a Solana wallet. ' +
      'Signs and broadcasts locally (15% fee). ' +
      'Call with dry_run (default) first, then with execution_token to execute.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet_address: {
          type: 'string',
          description: walletDesc,
        },
        dry_run: {
          type: 'boolean',
          description:
            'Default true. Shows plan + returns execution_token.',
          default: true,
        },
        execution_token: {
          type: 'string',
          description:
            'Token from dry_run. Required when dry_run is false.',
        },
      },
      ...(keypairWallet ? {} : { required: ['wallet_address'] }),
    },
  };
}

// ---- Handler ----

const InputSchema = z.object({
  wallet_address: z.string().optional(),
  dry_run: z.boolean().default(true),
  execution_token: z.string().optional(),
});

export async function handleClaimRewards(
  args: unknown,
  config: Config,
  scanner: ScannerService,
  signer: SignerService,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    const { wallet_address, dry_run, execution_token } =
      InputSchema.parse(args ?? {});
    const resolvedAddress =
      wallet_address || config.keypair?.publicKey.toBase58();
    if (!resolvedAddress) {
      return {
        content: [{ type: 'text', text: 'wallet_address is required.' }],
        isError: true,
      };
    }
    const { pubkey: walletPubkey } =
      await validateWalletAddress(resolvedAddress);
    const wallet = walletPubkey.toBase58();

    verifyWalletMatchesKeypair(walletPubkey, config.keypair!.publicKey);

    // ---- DRY RUN ----
    if (dry_run) {
      const buildTxResp = await scanner.buildRewardsTx(wallet);

      if (buildTxResp.transactions.length === 0) {
        return {
          content: [
            { type: 'text', text: 'No claimable rewards found for this wallet.' },
          ],
        };
      }

      const token = tokenStore.generate(wallet, buildTxResp);
      const { rewardsSummary: s } = buildTxResp;

      let text =
        `Dry run — no transactions sent.\n\n` +
        `Rewards summary:\n` +
        `  Pump cashback: ${formatSolFromLamports(s.pumpCashback)}\n` +
        `  PumpSwap cashback: ${formatSolFromLamports(s.pumpSwapCashback)}\n` +
        `  Pump creator fees: ${formatSolFromLamports(s.pumpCreatorFee)}\n` +
        `  PumpSwap creator fees: ${formatSolFromLamports(s.pumpSwapCreatorFee)}\n` +
        `  Total: ${formatSolFromLamports(s.totalLamports)}\n` +
        `  Fee (15%): ${formatSolFromLamports(s.estimatedFeeLamports)}\n` +
        `  Estimated net: ${formatSolFromLamports(s.estimatedNetLamports)}\n` +
        `  Transactions: ${buildTxResp.transactions.length}`;

      text +=
        `\n\nExecution token: ${token}\n` +
        `Expires in 60 seconds.\n\n` +
        `To execute: call claim_rewards with dry_run: false and execution_token: "${token}"`;

      return { content: [{ type: 'text', text }] };
    }

    // ---- EXECUTION ----
    if (!execution_token) {
      return {
        content: [
          {
            type: 'text',
            text: 'Run claim_rewards with dry_run first to get an execution token.',
          },
        ],
        isError: true,
      };
    }

    const buildTxResponse = tokenStore.validate(execution_token, wallet);

    // Deserialize transactions
    const transactions = buildTxResponse.transactions.map((b64) =>
      Transaction.from(Buffer.from(b64, 'base64')),
    );

    // Independent rewards scan — do not trust the build-tx summary alone.
    // Pump/PumpSwap claim amounts are determined on-chain (not in tx data),
    // so we fetch the current on-chain totals and use the lower of the two
    // as the fee cap basis.
    const independentScan = await scanner.getRewardsScan(wallet);
    const feeBasis = Math.min(
      independentScan.total,
      buildTxResponse.rewardsSummary.totalLamports,
    );

    // Pre-sign validation
    validateTransactionPrograms(
      transactions,
      walletPubkey,
      REWARDS_FEE_BPS,
      feeBasis,
    );

    // Balance snapshot (pre)
    const preBal = await signer.getBalance(walletPubkey);

    // Sign + send + confirm
    const results = await signer.signAndSendBatch(
      transactions,
      config.keypair!,
    );

    // Balance snapshot (post)
    const postBal = await signer.getBalance(walletPubkey);

    // Consume token
    tokenStore.consume(execution_token, wallet);

    const confirmed = results.filter((r) => r.status === 'confirmed');
    const failed = results.filter((r) => r.status === 'failed');
    const netSol = (postBal - preBal) / 1e9;

    let text: string;

    if (failed.length === 0) {
      text =
        `Rewards claimed across ${confirmed.length} transaction(s).\n\n` +
        `Confirmed net: ${formatSol(Math.max(0, netSol))} (wallet balance change, inclusive of fees)\n\n` +
        `Signatures:\n${confirmed.map((r, i) => `${i + 1}. ${r.signature}`).join('\n')}`;
    } else if (confirmed.length > 0) {
      text =
        `Partial claim: ${confirmed.length}/${results.length} txs confirmed.\n\n` +
        `Confirmed net so far: ${formatSol(Math.max(0, netSol))} (wallet balance change)\n\n` +
        `Successful:\n${confirmed.map((r, i) => `${i + 1}. ${r.signature}`).join('\n')}\n\n` +
        `Failed:\n${failed.map((r, i) => `${i + 1}. ${r.error || 'unknown'}`).join('\n')}\n\n` +
        `Run claim_rewards again (dry_run first) to retry.`;
    } else {
      text =
        `All ${results.length} transaction(s) failed.\n\n` +
        `${failed.map((r, i) => `${i + 1}. ${r.error || 'unknown'}`).join('\n')}\n\n` +
        `Run claim_rewards again (dry_run first) to retry.`;
    }

    text += `\n\nWallet: https://solscan.io/account/${wallet}`;

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (
      err instanceof WalletValidationError ||
      err instanceof ExecutionTokenError
    ) {
      return {
        content: [{ type: 'text', text: err.message }],
        isError: true,
      };
    }
    if (err instanceof TransactionValidationError) {
      return {
        content: [
          {
            type: 'text',
            text: `Transaction validation failed: ${err.message}. Aborting. Visit ${WEBSITE_URL} directly.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text:
            (err as Error).message ||
            `Unexpected error. Visit ${WEBSITE_URL} directly.`,
        },
      ],
      isError: true,
    };
  }
}

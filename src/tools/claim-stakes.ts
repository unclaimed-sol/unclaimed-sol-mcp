import { z } from 'zod';
import { Transaction } from '@solana/web3.js';
import { Config } from '../config.js';
import {
  ScannerService,
  StakesBuildTxResponse,
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
import { WEBSITE_URL, STAKES_FEE_BPS } from '../constants.js';
import {
  ExecutionTokenStore,
  ExecutionTokenError,
} from '../execution-token-store.js';

// ---- Execution Token Store ----

const tokenStore = new ExecutionTokenStore<StakesBuildTxResponse>(
  'claim_stakes',
);

// ---- Tool Definition ----

export function getClaimStakesToolDefinition(keypairWallet?: string) {
  const walletDesc = keypairWallet
    ? `Solana wallet address. Must match configured keypair. Defaults to ${keypairWallet}`
    : 'Solana wallet address. Must match configured keypair.';

  return {
    name: 'claim_stakes',
    description:
      'Claim SOL from deactivated stake accounts. ' +
      'Signs and broadcasts locally via UnclaimedSOL on-chain program (fee applies). ' +
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
        stake_accounts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of specific stake account addresses to claim. If omitted, claims all deactivated stakes.',
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
  stake_accounts: z.array(z.string()).optional(),
});

export async function handleClaimStakes(
  args: unknown,
  config: Config,
  scanner: ScannerService,
  signer: SignerService,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    const { wallet_address, dry_run, execution_token, stake_accounts } =
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
      const buildTxResp = await scanner.buildStakesTx(
        wallet,
        stake_accounts,
      );

      if (buildTxResp.transactions.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No claimable stake accounts found for this wallet.',
            },
          ],
        };
      }

      const token = tokenStore.generate(wallet, buildTxResp);

      let text =
        `Dry run — no transactions sent.\n\n` +
        `Stake accounts: ${buildTxResp.stakeCount}\n` +
        `Total withdrawable: ${formatSolFromLamports(buildTxResp.totalWithdrawableLamports)}\n` +
        `Fee: ${formatSolFromLamports(buildTxResp.totalFeeLamports)}\n` +
        `Estimated net: ${formatSolFromLamports(buildTxResp.totalNetLamports)}\n` +
        `Transactions: ${buildTxResp.transactions.length}`;

      text +=
        `\n\nExecution token: ${token}\n` +
        `Expires in 60 seconds.\n\n` +
        `To execute: call claim_stakes with dry_run: false and execution_token: "${token}"`;

      return { content: [{ type: 'text', text }] };
    }

    // ---- EXECUTION ----
    if (!execution_token) {
      return {
        content: [
          {
            type: 'text',
            text: 'Run claim_stakes with dry_run first to get an execution token.',
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

    // Pre-sign validation — fee cap for stakes is derived from on-chain
    // withdraw amounts in instruction data, not backend-reported totals.
    // backendReportedTotalLamports is passed but ignored when stake
    // withdrawals are present.
    validateTransactionPrograms(
      transactions,
      walletPubkey,
      STAKES_FEE_BPS,
      buildTxResponse.totalWithdrawableLamports,
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
        `Stakes claimed across ${confirmed.length} transaction(s) from ${buildTxResponse.stakeCount} stake account(s).\n\n` +
        `Confirmed net: ${formatSol(Math.max(0, netSol))} (wallet balance change, inclusive of fees)\n\n` +
        `Signatures:\n${confirmed.map((r, i) => `${i + 1}. ${r.signature}`).join('\n')}`;
    } else if (confirmed.length > 0) {
      text =
        `Partial claim: ${confirmed.length}/${results.length} txs confirmed.\n\n` +
        `Confirmed net so far: ${formatSol(Math.max(0, netSol))} (wallet balance change)\n\n` +
        `Successful:\n${confirmed.map((r, i) => `${i + 1}. ${r.signature}`).join('\n')}\n\n` +
        `Failed:\n${failed.map((r, i) => `${i + 1}. ${r.error || 'unknown'}`).join('\n')}\n\n` +
        `Run claim_stakes again (dry_run first) to retry.`;
    } else {
      text =
        `All ${results.length} transaction(s) failed.\n\n` +
        `${failed.map((r, i) => `${i + 1}. ${r.error || 'unknown'}`).join('\n')}\n\n` +
        `Run claim_stakes again (dry_run first) to retry.`;
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

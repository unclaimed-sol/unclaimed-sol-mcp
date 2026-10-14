import { z } from 'zod';
import { Transaction } from '@solana/web3.js';
import { Config } from '../config.js';
import {
  ScannerService,
  RewardsBuildTxResponse,
  RewardsScanResponse,
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
import {
  WEBSITE_URL,
  REWARDS_FEE_BPS,
  PUMP_REWARDS_FEE_BPS,
  PUMP_REWARDS_FEE_CAP_LAMPORTS,
  PUMP_REWARDS_USDC_FEE_CAP_BASE_UNITS,
} from '../constants.js';
import {
  ExecutionTokenStore,
  ExecutionTokenError,
} from '../execution-token-store.js';

// ---- Execution Token Store ----

const tokenStore = new ExecutionTokenStore<RewardsBuildTxResponse>(
  'claim_rewards',
);

type RewardsFeeCapSource =
  | RewardsScanResponse
  | RewardsBuildTxResponse['rewardsSummary'];

function pumpNativeLamportsForRewards(source: RewardsFeeCapSource): number {
  return (
    source.pumpCashback +
    source.pumpSwapCashback +
    source.pumpCreatorFee +
    source.pumpSwapCreatorFee
  );
}

function accumulatorCloseLamportsForRewards(
  source: RewardsFeeCapSource,
): number {
  return (
    source.pumpAccumulatorCloseLamports +
    source.pumpSwapAccumulatorCloseLamports
  );
}

function calculateRewardsFeeCaps(source: RewardsFeeCapSource): {
  nativeLamports: number;
  usdcBaseUnits: bigint;
} {
  const pumpNativeLamports = pumpNativeLamportsForRewards(source);
  const accumulatorCloseLamports = accumulatorCloseLamportsForRewards(source);
  const pumpFee = BigInt(pumpNativeLamports) * BigInt(PUMP_REWARDS_FEE_BPS) / 10_000n;
  const pumpNativeFeeLamports = pumpFee > PUMP_REWARDS_FEE_CAP_LAMPORTS
    ? PUMP_REWARDS_FEE_CAP_LAMPORTS : pumpFee;
  const accumulatorCloseFeeLamports = BigInt(accumulatorCloseLamports) * 500n / 10_000n;

  const usdcTotalBaseUnits = BigInt(source.usdcRewards?.totalBaseUnits ?? 0);
  const usdcFeeBaseUnits = usdcTotalBaseUnits * BigInt(PUMP_REWARDS_FEE_BPS) / 10_000n;

  return {
    nativeLamports: Number(pumpNativeFeeLamports + accumulatorCloseFeeLamports),
    usdcBaseUnits:
      usdcFeeBaseUnits > PUMP_REWARDS_USDC_FEE_CAP_BASE_UNITS
        ? PUMP_REWARDS_USDC_FEE_CAP_BASE_UNITS
        : usdcFeeBaseUnits,
  };
}

// ---- Tool Definition ----

export function getClaimRewardsToolDefinition(keypairWallet?: string) {
  const walletDesc = keypairWallet
    ? `Solana wallet address. Must match configured keypair. Defaults to ${keypairWallet}`
    : 'Solana wallet address. Must match configured keypair.';

  return {
    name: 'claim_rewards',
    description:
      'Claim Pump/PumpSwap cashback and creator fees for a Solana wallet. ' +
      'Signs and broadcasts locally (3% capped at 1 SOL or 100 USDC). Other reward sources are not supported. ' +
      'Call with dry_run (default) first, then with execution_token to execute.',
    annotations: {
      title: 'Claim DeFi Rewards',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
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

      const previewTransactions = buildTxResp.transactions.map(b64 => Transaction.from(Buffer.from(b64, 'base64')));
      const previewCaps = calculateRewardsFeeCaps(buildTxResp.rewardsSummary);
      validateTransactionPrograms(previewTransactions, walletPubkey, REWARDS_FEE_BPS,
        buildTxResp.rewardsSummary.totalLamports, previewCaps.nativeLamports,
        previewCaps.usdcBaseUnits, 'rewards');
      await signer.verifyRewards(previewTransactions, walletPubkey);
      const token = tokenStore.generate(wallet, buildTxResp);
      const { rewardsSummary: s } = buildTxResp;

      let text =
        `Dry run — no transactions sent.\n\n` +
        `Rewards summary:\n` +
        `  Pump cashback: ${formatSolFromLamports(s.pumpCashback)}\n` +
        `  PumpSwap cashback: ${formatSolFromLamports(s.pumpSwapCashback)}\n` +
        `  Pump creator fees: ${formatSolFromLamports(s.pumpCreatorFee)}\n` +
        `  PumpSwap creator fees: ${formatSolFromLamports(s.pumpSwapCreatorFee)}\n` +
        `  Accumulator rent: ${formatSolFromLamports(s.pumpAccumulatorCloseLamports + s.pumpSwapAccumulatorCloseLamports)}\n` +
        `  Total: ${formatSolFromLamports(s.totalLamports)}\n` +
        `  Estimated service fee: ${formatSolFromLamports(s.estimatedFeeLamports)}\n` +
        `  Estimated net: ${formatSolFromLamports(s.estimatedNetLamports)}\n` +
        `  Transactions: ${buildTxResp.transactions.length}`;

      if (s.usdcRewards && s.usdcRewards.totalBaseUnits > 0) {
        text +=
          `\n  USDC rewards: ${(s.usdcRewards.totalBaseUnits / 1_000_000).toFixed(6)} USDC` +
          `\n  Estimated USDC service fee: ${(s.usdcRewards.estimatedServiceFeeBaseUnits / 1_000_000).toFixed(6)} USDC` +
          `\n  Estimated USDC net: ${(s.usdcRewards.estimatedNetBaseUnits / 1_000_000).toFixed(6)} USDC`;
      }

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

    const buildTxResponse = tokenStore.take(execution_token, wallet);

    // Deserialize transactions
    const transactions = buildTxResponse.transactions.map((b64) =>
      Transaction.from(Buffer.from(b64, 'base64')),
    );

    // A second backend response detects contract drift, but is NOT an
    // independent on-chain observation and cannot defeat a malicious backend.
    const independentScan = await scanner.getRewardsScan(wallet);
    const feeBasis = Math.min(
      independentScan.total,
      buildTxResponse.rewardsSummary.totalLamports,
    );
    const independentFeeCaps = calculateRewardsFeeCaps(independentScan);
    const buildFeeCaps = calculateRewardsFeeCaps(
      buildTxResponse.rewardsSummary,
    );
    const explicitMaxFeeLamports = Math.min(
      independentFeeCaps.nativeLamports,
      buildFeeCaps.nativeLamports,
    );
    const explicitMaxUsdcFeeBaseUnits =
      independentFeeCaps.usdcBaseUnits < buildFeeCaps.usdcBaseUnits
        ? independentFeeCaps.usdcBaseUnits
        : buildFeeCaps.usdcBaseUnits;

    // Pre-sign validation
    validateTransactionPrograms(
      transactions,
      walletPubkey,
      REWARDS_FEE_BPS,
      feeBasis,
      explicitMaxFeeLamports,
      explicitMaxUsdcFeeBaseUnits,
      'rewards',
    );

    await signer.verifyRewards(transactions, walletPubkey);

    // Balance snapshot (pre)
    const preBal = await signer.getBalance(walletPubkey);

    // Sign + send + confirm
    const results = await signer.signAndSendBatch(
      transactions,
      config.keypair!,
    );

    // Balance snapshot (post)
    const postBal = await signer.getBalance(walletPubkey).catch(() => null);


    const confirmed = results.filter((r) => r.status === 'confirmed');
    const failed = results.filter((r) => r.status !== 'confirmed');
    const netSol = postBal === null ? null : (postBal - preBal) / 1e9;

    let text: string;

    if (failed.length === 0) {
      text =
        `Rewards claimed across ${confirmed.length} transaction(s).\n\n` +
        `Confirmed net: ${(netSol === null ? 'unavailable (balance RPC failed; see signatures)' : formatSol(Math.max(0, netSol)))} (wallet balance change, inclusive of fees)\n\n` +
        `Signatures:\n${confirmed.map((r, i) => `${i + 1}. ${r.signature}`).join('\n')}`;
    } else if (confirmed.length > 0) {
      text =
        `Partial claim: ${confirmed.length}/${results.length} txs confirmed.\n\n` +
        `Confirmed net so far: ${(netSol === null ? 'unavailable (balance RPC failed; see signatures)' : formatSol(Math.max(0, netSol)))} (wallet balance change)\n\n` +
        `Successful:\n${confirmed.map((r, i) => `${i + 1}. ${r.signature}`).join('\n')}\n\n` +
        `Failed:\n${failed.map((r, i) => `${i + 1}. ${r.error || 'unknown'}${r.signature ? ` — ${r.signature}` : ''}`).join('\n')}\n\n` +
        `Run claim_rewards again (dry_run first) to retry.`;
    } else {
      text =
        `All ${results.length} transaction(s) failed.\n\n` +
        `${failed.map((r, i) => `${i + 1}. ${r.error || 'unknown'}${r.signature ? ` — ${r.signature}` : ''}`).join('\n')}\n\n` +
        `Run claim_rewards again (dry_run first) to retry.`;
    }

    if (results.some(result => result.status === 'unknown')) {
      text = `Submission outcome is uncertain. Do not assume these transactions failed. Check the signatures before a fresh dry run.\n\n` +
        results.map(result => `${result.status}: ${result.signature} ${result.error ?? ''}`).join('\n');
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
            'CLAIM_FAILED: request could not be completed. Obtain a fresh dry run; check any submitted signatures first.',
        },
      ],
      isError: true,
    };
  }
}

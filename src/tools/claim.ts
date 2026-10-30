import { z } from 'zod';
import { ExecutionTokenStore, ExecutionTokenError } from '../execution-token-store.js';
import { Config } from '../config.js';
import {
  ScannerService,
  ScannerError,
  TokenAccountInfo,
  BufferAccountInfo,
  BuffersResponse,
} from '../services/scanner.js';
import {
  TransactionBuilder,
  ClaimPlan,
  TransactionValidationError,
} from '../services/transaction.js';
import { SignerService } from '../services/signer.js';
import {
  validateWalletAddress,
  verifyWalletMatchesKeypair,
  WalletValidationError,
  ToolInputError,
  parseToolInput,
} from '../validation.js';
import { formatSol } from '../formatter.js';
import {
  WEBSITE_URL,
  DEFAULT_MAX_TRANSACTIONS,
} from '../constants.js';

// Discovery uses backend safe mode; RPC checks gate the actual target set.
// Checked on-chain amounts and exact approvals require a separate rollout.
const tokenStore = new ExecutionTokenStore<{
  tokens: TokenAccountInfo[];
  buffers: BufferAccountInfo[];
  plan: ClaimPlan;
  maxTransactions: number;
}>('claim_sol');

function shortenAddress(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function formatBalanceChange(sol: number | null): string {
  if (sol === null) return 'unavailable (balance RPC failed; see signatures)';
  if (sol === 0) return '0 SOL';
  return `${sol < 0 ? '-' : ''}${formatSol(Math.abs(sol))}`;
}

function tokenLabel(token: TokenAccountInfo): string {
  const symbol = token.symbol?.trim();
  const name = token.name?.trim();

  if (symbol && name && symbol.toLowerCase() !== name.toLowerCase()) {
    return `${symbol} (${name})`;
  }

  return symbol || name || 'Unknown token';
}

function normalizeExclude(values?: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values || []) {
    const v = value.trim().toLowerCase();
    if (v.length > 0) out.add(v);
  }
  return out;
}

function isExcludedByNameOrSymbol(
  token: TokenAccountInfo,
  normalizedExclude: Set<string>,
): boolean {
  if (normalizedExclude.size === 0) return false;

  const symbol = token.symbol?.trim().toLowerCase();
  const name = token.name?.trim().toLowerCase();

  return Boolean(
    (symbol && normalizedExclude.has(symbol)) ||
      (name && normalizedExclude.has(name)),
  );
}

function buildTokenPreview(tokens: TokenAccountInfo[]): string {
  if (tokens.length === 0) return '';

  const empty = tokens.filter((t) => t.amountUi === 0);
  const nonEmpty = tokens.filter((t) => t.amountUi > 0);
  const MAX_PER_GROUP = 8;
  const lines: string[] = ['Empty token accounts selected for closure (safe mode):'];

  const appendGroup = (
    title: string,
    group: TokenAccountInfo[],
    includeBalance: boolean,
  ) => {
    if (group.length === 0) return;
    lines.push('', `${title}:`);

    for (const token of group.slice(0, MAX_PER_GROUP)) {
      const base = `  - ${tokenLabel(token)} — ${shortenAddress(token.mintKey)}`;
      if (!includeBalance) {
        lines.push(base);
        continue;
      }
      lines.push(`${base} (balance: ${token.amountUi})`);
    }

    if (group.length > MAX_PER_GROUP) {
      lines.push(`  ...and ${group.length - MAX_PER_GROUP} more`);
    }
  };

  appendGroup('Empty token accounts', empty, false);
  appendGroup('Non-zero token accounts', nonEmpty, true);

  return `\n\n${lines.join('\n')}`;
}

// ---- Tool Definition ----

export function getClaimToolDefinition(keypairWallet?: string) {
  const walletDesc = keypairWallet
    ? `Solana wallet address. Must match configured keypair. Defaults to ${keypairWallet}`
    : 'Solana wallet address. Must match configured keypair.';

  return {
    name: 'claim_sol',
    description:
      'Claim reclaimable SOL from dormant token and buffer accounts. ' +
      'Closes empty token accounts and program buffers to reclaim rent. ' +
      'This action is irreversible — closed accounts cannot be recovered. ' +
      'Signs and broadcasts locally via UnclaimedSOL on-chain program. ' +
      'Token cleanup lets the user keep up to 0.002 SOL per closed account; buffers use a 5% fee. ' +
      'For deactivated stakes use claim_stakes; for DeFi rewards use claim_rewards. ' +
      'Call with dry_run (default) first, then with execution_token to execute.',
    annotations: {
      title: 'Claim Dormant SOL (Vibe Claiming)',
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
        max_transactions: {
          type: 'integer',
          description: 'Max txs to send. Default 10.',
          default: DEFAULT_MAX_TRANSACTIONS,
          maximum: 25,
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional token symbols or names to skip at execution time (case-insensitive). Example: ["BONK", "USD Coin"].',
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
  max_transactions: z
    .number()
    .int()
    .positive()
    .max(25)
    .default(DEFAULT_MAX_TRANSACTIONS),
  exclude: z.array(z.string().max(128)).max(256).optional(),
});

export async function handleClaim(
  args: unknown,
  config: Config,
  scanner: ScannerService,
  txBuilder: TransactionBuilder,
  signer: SignerService,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    const {
      wallet_address,
      dry_run,
      execution_token,
      max_transactions,
      exclude,
    } = parseToolInput(InputSchema, args);
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
    const url = `${WEBSITE_URL}?ref=mcp-claim`;

    verifyWalletMatchesKeypair(walletPubkey, config.keypair!.publicKey);

    // ---- DRY RUN ----
    if (dry_run) {
      let bufferNotice = '';
      // Fetch token + buffer accounts (always fresh, no cache)
      const [tokensResp, buffersResp] = await Promise.all([
        scanner.getClaimableTokens(wallet),
        scanner.getClaimableBuffers(wallet).catch(err => {
          if (!(err instanceof ScannerError) && !(err instanceof Error && err.message === 'BUFFER_DISCOVERY_UNAVAILABLE')) throw err;
          bufferNotice = 'Buffer discovery unavailable; buffers not included';
          return { claimableSol: 0, buffers: [] } as BuffersResponse;
        }),
      ]);

      const checked = await signer.inspectCleanup(walletPubkey, tokensResp.tokens, buffersResp.buffers);
      tokensResp.tokens = checked.tokens;
      buffersResp.buffers = checked.buffers;
      const omittedCount = checked.omitted;
      if (omittedCount > 0) {
        bufferNotice = `${bufferNotice ? `${bufferNotice}\n\n` : ''}${omittedCount} additional account(s) were not previewed; run claim_sol again after this claim.`;
      }

      // Optionally fetch stake info for reporting
      let stakeInfo: { count: number; estimatedSol: number } | null =
        null;
      try {
        stakeInfo = await scanner.getClaimableStakes(wallet);
      } catch {
        /* non-fatal */
      }

      if (!tokensResp.tokens.some(t => !t.isFrozen) && buffersResp.buffers.length === 0) {
        return { content: [{ type: 'text', text: `No token or buffer accounts to claim for this wallet.${checked.skipped > 0 ? ` Skipped ${checked.skipped} ineligible account(s).` : ''}${bufferNotice ? `\n\n${bufferNotice}` : ''}` }], isError: true };
      }

      const plan = await txBuilder.buildClaimPlan(
        tokensResp.tokens,
        buffersResp.buffers,
        walletPubkey,
        max_transactions,
        stakeInfo,
      );

      if (plan.tokenAccountCount + plan.bufferAccountCount === 0) {
        let msg =
          'No token or buffer accounts to claim for this wallet.';
        if (stakeInfo && stakeInfo.count > 0) {
          msg += `\n\nThis wallet may have stake account claims at ${url}`;
        }
        return {
          content: [{ type: 'text', text: msg }],
          isError: true,
        };
      }

      const selectedTokenSet = new Set(plan.selectedTokenPubkeys);
      const selectedBufferSet = new Set(plan.selectedBufferPubkeys);
      const selectedTokens = tokensResp.tokens.filter((t) =>
        selectedTokenSet.has(t.pubKey),
      );
      const selectedBuffers = buffersResp.buffers.filter((b) =>
        selectedBufferSet.has(b.pubkey),
      );

      const token = tokenStore.generate(wallet, {
        tokens: selectedTokens, buffers: selectedBuffers, plan, maxTransactions: max_transactions,
      });

      let text =
        `Dry run — no transactions sent.${checked.skipped > 0 ? ` Skipped ${checked.skipped} ineligible account(s).` : ''}\n\n` +
        `Estimated claim: ${formatSol(plan.estimatedSol)} from ` +
        `${plan.tokenAccountCount} token accounts and ${plan.bufferAccountCount} buffer accounts ` +
        `(token fee is max(2% rounded down, gross above 0.002 SOL); buffers use a 5% fee; network fees excluded).\n` +
        `Transactions needed: ${plan.transactionsNeeded}` +
        (plan.cappedByMaxTx
          ? ` of ${plan.totalTransactionsNeeded} (limited by max_transactions: ${max_transactions}` +
            ` — ${plan.totalTokenAccountCount - plan.tokenAccountCount} token and ` +
            `${plan.totalBufferAccountCount - plan.bufferAccountCount} buffer accounts deferred)`
          : '');

      // Frozen accounts warning
      if (plan.skippedFrozenCount > 0) {
        text += `\n\n${plan.skippedFrozenCount} frozen account(s) skipped (cannot be closed).`;
      }

      if (bufferNotice) text += `\n\n${bufferNotice}`;
      text += buildTokenPreview(selectedTokens);

      // Irreversibility warning
      text +=
        `\n\nEligible accounts will be permanently closed. Accounts that become ineligible may be skipped; estimates are not guaranteed proceeds. This action is irreversible. For a visual breakdown of ` +
        `each account, review at ${url} before proceeding.`;

      if (plan.tokenAccountCount > 0) {
        text +=
          `\n\nIf needed, you can skip specific tokens during execution with ` +
          `exclude: ["TOKEN_SYMBOL", "Token Name"].`;
      }

      // Execution token
      text +=
        `\n\nExecution token: ${token}\n` +
        `Expires in 60 seconds.\n\n` +
        `To execute: call claim_sol with dry_run: false and execution_token: "${token}"`;

      // Stake accounts note
      if (stakeInfo && stakeInfo.count > 0) {
        text += `\n\nNote: ~${formatSol(stakeInfo.estimatedSol)} also claimable from ${stakeInfo.count} stake account(s) at ${url}`;
      }

      return { content: [{ type: 'text', text }] };
    }

    // ---- EXECUTION ----
    if (!execution_token) {
      return {
        content: [
          {
            type: 'text',
            text: 'Run claim_sol with dry_run first to get an execution token.',
          },
        ],
        isError: true,
      };
    }

    const entry = tokenStore.take(execution_token, wallet);
    const checked = await signer.inspectCleanup(walletPubkey, entry.tokens, entry.buffers);
    const normalizedExclude = normalizeExclude(exclude);
    const claimableTokens = checked.tokens.filter((t) => !t.isFrozen);
    const filteredTokens = claimableTokens.filter(
      (t) => !isExcludedByNameOrSymbol(t, normalizedExclude),
    );
    const excludedTokenCount = claimableTokens.length - filteredTokens.length;

    if (filteredTokens.length === 0 && checked.buffers.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No eligible accounts remain after validation and exclusions.${checked.skipped > 0 ? ` Skipped ${checked.skipped} ineligible account(s).` : ''}`,
          },
        ],
        isError: true,
      };
    }

    const plan = normalizedExclude.size > 0 || checked.skipped > 0
      ? await txBuilder.buildClaimPlan(
        filteredTokens,
        checked.buffers,
        walletPubkey,
        entry.maxTransactions,
        entry.plan.stakeInfo,
      )
      : entry.plan;

    // Pre-sign validation
    txBuilder.validateTransactions(plan.transactions, walletPubkey);

    // Balance snapshot (pre)
    const preBal = await signer.getBalance(walletPubkey);

    // Sign + send + confirm
    const results = await signer.signAndSendBatch(
      plan.transactions,
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
        `Confirmed ${confirmed.length} transactions targeting ${plan.tokenAccountCount} token accounts and ${plan.bufferAccountCount} buffer accounts.\n\n` +
        `Observed wallet balance change: ${formatBalanceChange(netSol)} (includes network fees and any concurrent wallet activity)\n\n` +
        `Signatures:\n${confirmed.map((r, i) => `${i + 1}. ${r.signature}`).join('\n')}`;
    } else if (confirmed.length > 0) {
      text =
        `Partial claim: ${confirmed.length}/${results.length} txs confirmed.\n\n` +
        `Observed wallet balance change: ${formatBalanceChange(netSol)} (includes network fees and any concurrent wallet activity)\n\n` +
        `Successful:\n${confirmed.map((r, i) => `${i + 1}. ${r.signature}`).join('\n')}\n\n` +
        `Not confirmed:\n${failed.map((r, i) => `${i + 1}. ${r.error || 'unknown'}${r.signature ? ` — ${r.signature}` : ''}`).join('\n')}\n\n` +
        `Run claim_sol again (dry_run first) to retry.`;
    } else {
      text =
        `No transactions confirmed (${results.length} attempted or checked).\n\n` +
        `${failed.map((r, i) => `${i + 1}. ${r.error || 'unknown'}${r.signature ? ` — ${r.signature}` : ''}`).join('\n')}\n\n` +
        `Run claim_sol again (dry_run first) to retry.`;
    }

    if (results.some(result => result.status === 'unknown')) {
      text = 'Submission outcome is uncertain. Check these signatures before a fresh dry run.\n\n' +
        results.map(result => `${result.status}: ${result.signature || '(not submitted)'} ${result.error ?? ''}`).join('\n');
    }
    if (confirmed.length > 0 && plan.tokenAccountCount > 0) {
      text += '\n\nA confirmed transaction may skip token accounts that became ineligible. Account counts above are targets, not verified closures.';
    }

    if (checked.skipped > 0) text = `Skipped ${checked.skipped} ineligible account(s) during execution revalidation.\n\n${text}`;
    if (excludedTokenCount > 0) {
      text = `Excluded ${excludedTokenCount} token account(s) by name/symbol filter.\n\n${text}`;
    }

    if (plan.stakeInfo && plan.stakeInfo.count > 0) {
      text += `\n\n~${formatSol(plan.stakeInfo.estimatedSol)} also claimable from stake accounts at ${url}`;
    }

    text += `\n\nWallet: https://solscan.io/account/${wallet}`;

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (
      err instanceof WalletValidationError ||
      err instanceof ToolInputError ||
      err instanceof ClaimError || err instanceof ExecutionTokenError || err instanceof ScannerError
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
            text: `Transaction validation failed: ${err.message}. Aborting. Visit https://unclaimedsol.com directly.`,
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

class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimError';
  }
}

import { z } from 'zod';
import { randomBytes } from 'crypto';
import { Config } from '../config.js';
import {
  ScannerService,
  TokenAccountInfo,
  BufferAccountInfo,
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
} from '../validation.js';
import { formatSol } from '../formatter.js';
import {
  WEBSITE_URL,
  EXECUTION_TOKEN_TTL_MS,
  MAX_ACTIVE_TOKENS,
  DEFAULT_MAX_TRANSACTIONS,
} from '../constants.js';

// ---- Execution Token Store ----

interface TokenEntry {
  token: string;
  wallet: string;
  // Account set approved during dry_run (already capped by max_transactions).
  tokens: TokenAccountInfo[];
  buffers: BufferAccountInfo[];
  plan: ClaimPlan;
  maxTransactions: number;
  createdAt: number;
}

const tokensByWallet = new Map<string, TokenEntry>();
const allTokens = new Map<string, TokenEntry>();

function generateToken(
  wallet: string,
  tokens: TokenAccountInfo[],
  buffers: BufferAccountInfo[],
  plan: ClaimPlan,
  maxTransactions: number,
): string {
  // Evict expired
  const now = Date.now();
  for (const [t, e] of allTokens) {
    if (now - e.createdAt > EXECUTION_TOKEN_TTL_MS) {
      allTokens.delete(t);
      if (tokensByWallet.get(e.wallet)?.token === t)
        tokensByWallet.delete(e.wallet);
    }
  }
  // Enforce max (evict oldest)
  while (allTokens.size >= MAX_ACTIVE_TOKENS) {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [t, e] of allTokens) {
      if (e.createdAt < oldestTime) {
        oldestTime = e.createdAt;
        oldest = t;
      }
    }
    if (oldest) {
      const e = allTokens.get(oldest)!;
      allTokens.delete(oldest);
      if (tokensByWallet.get(e.wallet)?.token === oldest)
        tokensByWallet.delete(e.wallet);
    }
  }
  // Invalidate previous for this wallet (max 1 per wallet)
  const prev = tokensByWallet.get(wallet);
  if (prev) allTokens.delete(prev.token);

  const token = randomBytes(16).toString('hex');
  const entry: TokenEntry = {
    token,
    wallet,
    tokens,
    buffers,
    plan,
    maxTransactions,
    createdAt: now,
  };
  allTokens.set(token, entry);
  tokensByWallet.set(wallet, entry);
  return token;
}

function validateToken(token: string, wallet: string): TokenEntry {
  const entry = allTokens.get(token);
  if (!entry)
    throw new ClaimError(
      'Run claim_sol with dry_run first to get an execution token.',
    );
  if (entry.wallet !== wallet)
    throw new ClaimError('Execution token does not match this wallet.');
  if (Date.now() - entry.createdAt > EXECUTION_TOKEN_TTL_MS) {
    allTokens.delete(token);
    tokensByWallet.delete(wallet);
    throw new ClaimError('Execution token expired. Run dry_run again.');
  }
  return entry;
}

function consumeToken(token: string, wallet: string): void {
  allTokens.delete(token);
  if (tokensByWallet.get(wallet)?.token === token)
    tokensByWallet.delete(wallet);
}

function shortenAddress(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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
  const lines: string[] = ['Tokens selected for burn (safe mode):'];

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
      'Burns worthless token balances and closes accounts to reclaim rent. ' +
      'This action is irreversible — closed accounts cannot be recovered. ' +
      'Signs and broadcasts locally via UnclaimedSOL on-chain program (5% fee). ' +
      'Stake account claims are at unclaimedsol.com. ' +
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
        max_transactions: {
          type: 'integer',
          description: 'Max txs to send. Default 10.',
          default: DEFAULT_MAX_TRANSACTIONS,
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
    .default(DEFAULT_MAX_TRANSACTIONS),
  exclude: z.array(z.string()).optional(),
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
    } = InputSchema.parse(args ?? {});
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
      // Fetch token + buffer accounts (always fresh, no cache)
      const [tokensResp, buffersResp] = await Promise.all([
        scanner.getClaimableTokens(wallet),
        scanner.getClaimableBuffers(wallet),
      ]);

      // Optionally fetch stake info for reporting
      let stakeInfo: { count: number; estimatedSol: number } | null =
        null;
      try {
        stakeInfo = await scanner.getClaimableStakes(wallet);
      } catch {
        /* non-fatal */
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

      const token = generateToken(
        wallet,
        selectedTokens,
        selectedBuffers,
        plan,
        max_transactions,
      );

      let text =
        `Dry run — no transactions sent.\n\n` +
        `Estimated claim: ${formatSol(plan.estimatedSol)} from ` +
        `${plan.tokenAccountCount} token accounts and ${plan.bufferAccountCount} buffer accounts ` +
        `(inclusive of 5% fee).\n` +
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

      text += buildTokenPreview(selectedTokens);

      // Irreversibility warning
      text +=
        `\n\nThis will permanently close these accounts and burn any remaining ` +
        `token balances. This action is irreversible. For a visual breakdown of ` +
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

    const entry = validateToken(execution_token, wallet);
    const normalizedExclude = normalizeExclude(exclude);
    const claimableTokens = entry.tokens.filter((t) => !t.isFrozen);
    const filteredTokens = claimableTokens.filter(
      (t) => !isExcludedByNameOrSymbol(t, normalizedExclude),
    );
    const excludedTokenCount = claimableTokens.length - filteredTokens.length;

    if (filteredTokens.length === 0 && entry.buffers.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'All claimable token accounts were excluded and there are no buffer accounts left to claim.',
          },
        ],
        isError: true,
      };
    }

    const plan = normalizedExclude.size > 0
      ? await txBuilder.buildClaimPlan(
        filteredTokens,
        entry.buffers,
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
    const postBal = await signer.getBalance(walletPubkey);

    // Consume token
    consumeToken(execution_token, wallet);

    const confirmed = results.filter((r) => r.status === 'confirmed');
    const failed = results.filter((r) => r.status === 'failed');
    const netSol = (postBal - preBal) / 1e9;

    let text: string;

    if (failed.length === 0) {
      text =
        `Claimed across ${confirmed.length} transactions from ${plan.tokenAccountCount} token accounts and ${plan.bufferAccountCount} buffer accounts.\n\n` +
        `Confirmed net: ${formatSol(Math.max(0, netSol))} (wallet balance change, inclusive of priority fees)\n\n` +
        `Signatures:\n${confirmed.map((r, i) => `${i + 1}. ${r.signature}`).join('\n')}`;
    } else if (confirmed.length > 0) {
      text =
        `Partial claim: ${confirmed.length}/${results.length} txs confirmed.\n\n` +
        `Confirmed net so far: ${formatSol(Math.max(0, netSol))} (wallet balance change)\n\n` +
        `Successful:\n${confirmed.map((r, i) => `${i + 1}. ${r.signature}`).join('\n')}\n\n` +
        `Failed:\n${failed.map((r, i) => `${i + 1}. ${r.error || 'unknown'}`).join('\n')}\n\n` +
        `Run claim_sol again (dry_run first) to retry.`;
    } else {
      text =
        `All ${results.length} transactions failed.\n\n` +
        `${failed.map((r, i) => `${i + 1}. ${r.error || 'unknown'}`).join('\n')}\n\n` +
        `Run claim_sol again (dry_run first) to retry.`;
    }

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
      err instanceof ClaimError
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
            (err as Error).message ||
            'Unexpected error. Visit https://unclaimedsol.com directly.',
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

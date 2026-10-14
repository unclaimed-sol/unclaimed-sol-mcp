import { z } from 'zod';
import { Config } from '../config.js';
import {
  ScannerService,
  ScannerError,
  TokenAccountInfo,
} from '../services/scanner.js';
import {
  TransactionBuilder,
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
  DEFAULT_MAX_TRANSACTIONS,
} from '../constants.js';

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

  const empty = tokens.filter((t) => t.amountBaseUnits === '0');
  const nonEmpty = tokens.filter((t) => t.amountBaseUnits !== '0');
  const MAX_PER_GROUP = 8;
  const lines: string[] = ['Selected token accounts:'];

  const appendGroup = (
    title: string,
    group: TokenAccountInfo[],
    includeBalance: boolean,
  ) => {
    if (group.length === 0) return;
    lines.push('', `${title}:`);

    for (const token of group.slice(0, MAX_PER_GROUP)) {
      const base = `  - ${tokenLabel(token)} — account ${token.pubKey}, mint ${token.mintKey}`;
      if (!includeBalance) {
        lines.push(base);
        continue;
      }
      lines.push(`${base} (base units: ${token.amountBaseUnits})`);
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
      'Preview reclaimable SOL from empty canonical token accounts and explicitly selected positive token accounts or buffers. ' +
      'Token burning and account closure are irreversible. ' +
      'Token cleanup lets the user keep up to 0.002 SOL per closed account; buffers use a 5% fee. ' +
      'For deactivated stakes use claim_stakes; for DeFi rewards use claim_rewards. ' +
      'Preview only until checked on-chain cleanup instructions and SDK builders are available. Execution fails closed.',
    annotations: {
      title: 'Preview Dormant SOL',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
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
            'Default true. Shows a read-only estimate. Execution is currently unavailable.',
          default: true,
        },
        max_transactions: {
          type: 'integer',
          description: 'Max transactions included in the estimate. Default 10.',
          default: DEFAULT_MAX_TRANSACTIONS,
          maximum: 25,
        },
        token_accounts: { type: 'array', maxItems: 256, uniqueItems: true, items: { type: 'string' }, description: 'Exact token accounts selected for this dry run. This selection is for preview only.' },
        buffer_accounts: { type: 'array', maxItems: 256, uniqueItems: true, items: { type: 'string' }, description: 'Exact buffers selected for this dry run. Buffers are never automatic.' },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional token symbols or names to skip during the dry run (case-insensitive). Example: ["BONK", "USD Coin"].',
        },
      },
      ...(keypairWallet ? {} : { required: ['wallet_address'] }),
    },
  };
}

// ---- Handler ----

const AddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const AddressesSchema = z.array(AddressSchema).max(256).refine(a => new Set(a).size === a.length, 'Duplicate targets');
const InputSchema = z.object({
  wallet_address: z.string().optional(),
  dry_run: z.boolean().default(true),
  max_transactions: z
    .number()
    .int()
    .positive()
    .max(25)
    .default(DEFAULT_MAX_TRANSACTIONS),
  token_accounts: AddressesSchema.optional(),
  buffer_accounts: AddressesSchema.optional(),
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
      max_transactions,
      exclude, token_accounts, buffer_accounts,
    } = InputSchema.parse(args ?? {});
    if (!dry_run) {
      throw new ClaimError('CHECKED_CLEANUP_UNAVAILABLE: cleanup execution requires checked program instructions and SDK builders. This tool currently provides previews only.');
    }
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

    // Fetch token + buffer accounts (always fresh, no cache)
    const [tokensResp, buffersResp] = await Promise.all([
      scanner.getClaimableTokens(wallet, Boolean(token_accounts?.length)),
      buffer_accounts?.length ? scanner.getClaimableBuffers(wallet) : Promise.resolve({ claimableSol: 0, buffers: [] }),
    ]);

    // Optionally fetch stake info for reporting
    let stakeInfo: { count: number; estimatedSol: number } | null =
      null;
    try {
      stakeInfo = await scanner.getClaimableStakes(wallet);
    } catch {
      /* non-fatal */
    }

    const excluded = normalizeExclude(exclude);
    const candidateTokens = tokensResp.tokens.filter(t => !t.isFrozen &&
      (token_accounts ? token_accounts.includes(t.pubKey) : t.amountUi === 0) && !isExcludedByNameOrSymbol(t, excluded));
    const candidateBuffers = buffersResp.buffers.filter(b => buffer_accounts?.includes(b.pubkey));
    if (token_accounts?.some(address => !candidateTokens.some(t => t.pubKey === address)) ||
        buffer_accounts?.some(address => !candidateBuffers.some(b => b.pubkey === address))) {
      throw new ClaimError('Selected accounts are unavailable or excluded. Obtain a fresh dry run with a valid selection.');
    }
    const verified = await signer.inspectCleanup(walletPubkey, candidateTokens, candidateBuffers, token_accounts);
    if (verified.tokens.length + verified.buffers.length === 0) {
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

    const plan = await txBuilder.buildClaimPlan(
      verified.tokens,
      verified.buffers,
      walletPubkey,
      max_transactions,
      stakeInfo,
    );

    const selectedTokenSet = new Set(plan.selectedTokenPubkeys);
    const selectedTokens = verified.tokens.filter((t) =>
      selectedTokenSet.has(t.pubKey),
    );
    let text =
      `Dry run — no transactions sent.\n\n` +
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

    text += buildTokenPreview(selectedTokens);

    text += '\n\nPreview only. Cleanup execution is unavailable until checked program instructions and SDK builders are available.';

    // Stake accounts note
    if (stakeInfo && stakeInfo.count > 0) {
      text += `\n\nNote: ~${formatSol(stakeInfo.estimatedSol)} also claimable from ${stakeInfo.count} stake account(s) at ${url}`;
    }

    return { content: [{ type: 'text', text }] };

  } catch (err) {
    if (
      err instanceof WalletValidationError ||
      err instanceof ClaimError || err instanceof ScannerError
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
            'PREVIEW_FAILED: could not inspect this wallet. Please try again.',
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

import { z } from 'zod';
import { Config } from '../config.js';
import { ScannerService } from '../services/scanner.js';
import { ScanCache } from '../cache.js';
import {
  validateWalletAddress,
  WalletValidationError,
} from '../validation.js';
import { formatSol } from '../formatter.js';
import { WEBSITE_URL } from '../constants.js';

const InputSchema = z.object({
  wallet_address: z.string(),
});

const scanCache = new ScanCache<{
  totalSol: number;
  tokenCount: number;
  bufferCount: number;
}>();

export function getScanToolDefinition() {
  return {
    name: 'scan_claimable_sol',
    description:
      'Check how much SOL a Solana wallet can reclaim from dormant accounts. ' +
      'Returns total claimable amount. To claim, visit unclaimedsol.com or ' +
      'configure a local keypair for Vibe Claiming.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        wallet_address: {
          type: 'string',
          description:
            'Solana wallet address (base58 public key)',
        },
      },
      required: ['wallet_address'],
    },
  };
}

export async function handleScan(
  args: unknown,
  config: Config,
  scanner: ScannerService,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    const { wallet_address } = InputSchema.parse(args);
    const { pubkey } = await validateWalletAddress(wallet_address);
    const wallet = pubkey.toBase58();
    const ref = config.claimEnabled ? 'ref=mcp-claim' : 'ref=mcp';
    const url = `${WEBSITE_URL}?${ref}`;

    // Check cache
    const cached = scanCache.get(wallet);
    if (cached) {
      const ageSec = Math.round(cached.ageMs / 1000);
      return buildResponse(cached.data, config.claimEnabled, url, ageSec);
    }

    // Call backend
    const summary = await scanner.getScanSummary(wallet);
    const data = {
      totalSol: summary.totalClaimableSol,
      tokenCount: summary.tokenCount || 0,
      bufferCount: summary.bufferCount || 0,
    };

    scanCache.set(wallet, data);
    return buildResponse(data, config.claimEnabled, url, 0);
  } catch (err) {
    if (err instanceof WalletValidationError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    return {
      content: [
        {
          type: 'text',
          text:
            (err as Error).message ||
            'Scanner temporarily unavailable. Visit https://unclaimedsol.com directly.',
        },
      ],
      isError: true,
    };
  }
}

function buildResponse(
  data: { totalSol: number; tokenCount: number; bufferCount: number },
  claimEnabled: boolean,
  url: string,
  cacheAgeSec: number,
): { content: { type: string; text: string }[] } {
  if (data.totalSol <= 0) {
    return {
      content: [
        {
          type: 'text',
          text: `This wallet has no claimable SOL. All accounts are active or optimized.\n\nLearn more: ${url}`,
        },
      ],
    };
  }

  const solStr = formatSol(data.totalSol);
  const accountCount = data.tokenCount + data.bufferCount;
  const countStr =
    accountCount > 0 ? ` across ${accountCount} reclaimable accounts` : '';
  const cacheNote =
    cacheAgeSec > 0 ? ` (Scanned ${cacheAgeSec}s ago)` : '';

  const trustLine =
    'UnclaimedSOL will never DM you or ask for your seed phrase.';

  if (claimEnabled) {
    return {
      content: [
        {
          type: 'text',
          text:
            `This wallet has ${solStr} claimable${countStr} (inclusive of 5% fee).${cacheNote}\n\n` +
            `You can claim directly using the claim_sol tool, or visit ${url}\n\n` +
            `${trustLine}`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text:
          `This wallet has ${solStr} claimable${countStr} (inclusive of 5% fee).${cacheNote}\n\n` +
          `Claim at: ${url}\n\n` +
          `To enable Vibe Claiming from your AI assistant, set SOLANA_KEYPAIR_PATH in your MCP config.\n${trustLine}`,
      },
    ],
  };
}

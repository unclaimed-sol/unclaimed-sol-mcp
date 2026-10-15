import { z } from 'zod';
import { Config } from '../config.js';

/**
 * Maps directly to OwnerTokenAccount type from the backend.
 * Response from POST /api/get-claimable-tokens -> tokens[]
 *
 * Backend returns PublicKey objects but JSON serialization turns them
 * into strings. Handle both cases in the consumer.
 */
export interface TokenAccountInfo {
  pubKey: string; // ATA address (serialized from PublicKey)
  mintKey: string; // Mint address (serialized from PublicKey)
  amountUi: number; // Human-readable token balance
  isFrozen: boolean; // Account frozen?
  lamports: number; // Rent in lamports (recoverable SOL)
  symbol?: string; // e.g. "USDC"
  name?: string; // e.g. "USD Coin"
  icon?: string; // Logo URL
  decimals?: number; // Token decimals
  programOwnerId: string; // SPL Token or Token-2022 program ID
  isNft?: boolean; // true when decimals=0
}

/**
 * Response from POST /api/get-claimable-tokens
 * Body: { publicKey: "...", maxClaimMode: false }
 */
export interface TokensResponse {
  claimableSol: number;
  tokens: TokenAccountInfo[];
  rewardFee: number; // REWARD_FEE from backend
  /** Backend rows beyond MAX_TARGETS, dropped from this response. */
  omittedCount?: number;
}

/**
 * Maps to buffer objects from POST /api/get-claimable-buffers
 */
export interface BufferAccountInfo {
  pubkey: string; // Buffer account address
  authority?: string; // Independently verified via RPC
  lamports: number; // Rent in lamports
  dataLength?: number;
}

/**
 * Response from POST /api/get-claimable-buffers
 * Body: { publicKey: "..." }
 */
export interface BuffersResponse {
  claimableSol: number; // userReceives
  buffers: BufferAccountInfo[];
  /** Backend rows beyond MAX_TARGETS, dropped from this response. */
  omittedCount?: number;
}

/**
 * Response from POST /api/check-claimable-sol
 * Body: { publicKey: "..." }
 */
export interface ScanSummaryResponse {
  totalClaimableSol: number;
  assets: number;
  buffers: number;
  maxClaimableSol?: number;
  tokenCount?: number;
  bufferCount?: number;
  safeModeAssets?: number | null;
  safeTokenCount?: number | null;
  safeSummaryAvailable?: boolean;
  safeClaimAmount?: number | null;
}

/**
 * Response from POST /api/rewards/scan
 */
export interface RewardsScanResponse {
  pumpCashback: number; // lamports
  pumpSwapCashback: number; // lamports
  pumpCreatorFee: number; // lamports
  pumpSwapCreatorFee: number; // lamports
  raydiumLaunchLabCreatorFee: number; // lamports
  raydiumCpmmCreatorFee: number; // lamports
  meteoraDbcCreatorFee: number; // lamports
  pumpAccumulatorCloseLamports: number; // lamports
  pumpSwapAccumulatorCloseLamports: number; // lamports
  total: number; // lamports
  isLikelyProfitable: boolean;
  usdcRewards?: RewardsUsdcSummary;
}

/** Raw shape from backend — amounts are stringified BigInts. */
interface RawRewardsScanResponse {
  pumpCashback: string;
  pumpSwapCashback: string;
  pumpCreatorFee: string;
  pumpSwapCreatorFee: string;
  raydiumLaunchLabCreatorFee?: string;
  raydiumCpmmCreatorFee?: string;
  meteoraDbcCreatorFee?: string;
  pumpAccumulatorCloseLamports?: string;
  pumpSwapAccumulatorCloseLamports?: string;
  total: string;
  isLikelyProfitable: boolean;
  usdcRewards?: RawRewardsUsdcSummary;
}

export interface RewardsUsdcSummary {
  totalBaseUnits: number;
  estimatedServiceFeeBaseUnits: number;
  estimatedNetBaseUnits: number;
}

interface RawRewardsUsdcSummary {
  totalBaseUnits?: string;
  serviceFeeBaseUnits?: string;
  estimatedServiceFeeBaseUnits?: string;
  netBaseUnits?: string;
  estimatedNetBaseUnits?: string;
}

/**
 * Response from POST /api/rewards/build-tx
 */
export interface RewardsBuildTxResponse {
  transactions: string[]; // base64-encoded unsigned transactions
  rewardsSummary: {
    pumpCashback: number;
    pumpSwapCashback: number;
    pumpCreatorFee: number;
    pumpSwapCreatorFee: number;
    raydiumLaunchLabCreatorFee: number;
    raydiumCpmmCreatorFee: number;
    meteoraDbcCreatorFee: number;
    pumpAccumulatorCloseLamports: number;
    pumpSwapAccumulatorCloseLamports: number;
    totalLamports: number;
    estimatedFeeLamports: number;
    estimatedNetLamports: number;
    usdcRewards?: RewardsUsdcSummary;
  };
}

/**
 * Response from POST /api/stakes/build-tx
 */
export interface StakesBuildTxResponse {
  transactions: string[]; // base64-encoded unsigned transactions
  stakeCount: number;
  totalWithdrawableLamports: number;
  totalFeeLamports: number;
  totalNetLamports: number;
}

const REQUEST_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 30_000;

function numberFromString(value: string | number | undefined): number {
  if (value !== undefined && typeof value !== 'string' && typeof value !== 'number') throw new ScannerError('INVALID_BACKEND_AMOUNT');
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) throw new ScannerError('INVALID_BACKEND_AMOUNT');
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ScannerError('INVALID_BACKEND_AMOUNT');
  }
  return parsed;
}

function signedNumberFromString(value: unknown): number {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ScannerError('INVALID_BACKEND_AMOUNT');
  return Number(value);
}

function normalizeUsdcSummary(
  raw: RawRewardsUsdcSummary | undefined,
): RewardsUsdcSummary | undefined {
  if (!raw?.totalBaseUnits) return undefined;

  return {
    totalBaseUnits: numberFromString(raw.totalBaseUnits),
    estimatedServiceFeeBaseUnits: numberFromString(
      raw.estimatedServiceFeeBaseUnits ?? raw.serviceFeeBaseUnits,
    ),
    estimatedNetBaseUnits: numberFromString(
      raw.estimatedNetBaseUnits ?? raw.netBaseUnits,
    ),
  };
}

// Limit decoded bodies, including responses without Content-Length or with compression.
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TARGETS = 256;
const MAX_TRANSACTIONS = 25;
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const solAmount = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER / 1e9);
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const uniqueTargets = <T extends z.ZodType>(schema: T, key: string) =>
  z.array(schema).refine(
    rows => new Set(rows.map(row => (row as Record<string, unknown>)[key])).size === rows.length,
    'Duplicate targets',
  );
/** Keep the first MAX_TARGETS rows; the caller reports how many were dropped. */
function truncateTargets<T>(rows: T[]): { rows: T[]; omittedCount: number } {
  return rows.length > MAX_TARGETS
    ? { rows: rows.slice(0, MAX_TARGETS), omittedCount: rows.length - MAX_TARGETS }
    : { rows, omittedCount: 0 };
}
/** Contract mismatches surface as scanner errors, not generic failures. */
function parseContract<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw new ScannerError('INVALID_BACKEND_RESPONSE');
  return result.data;
}
const tokenResponseSchema = z.object({
  claimableSol: solAmount,
  rewardFee: z.number().nonnegative(),
  tokens: uniqueTargets(z.object({
    pubKey: address, mintKey: address, amountUi: z.number().nonnegative(),
    isFrozen: z.boolean(), lamports: amount,
    programOwnerId: z.enum(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']),
    symbol: z.string().max(128).optional(), name: z.string().max(256).optional(),
    decimals: z.number().int().min(0).max(255).optional(), isNft: z.boolean().optional(),
  }), 'pubKey'),
});
const bufferResponseSchema = z.object({
  claimableSol: solAmount,
  buffers: uniqueTargets(z.object({ address, lamports: amount, dataSize: amount }), 'address'),
  complete: z.boolean().optional(), cacheStatus: z.string().optional(),
  terminationReason: z.string().optional(),
});
const summarySchema = z.object({
  totalClaimableSol: solAmount, assets: solAmount, buffers: solAmount,
  maxClaimableSol: solAmount.optional(), tokenCount: amount.optional(), bufferCount: amount.optional(),
  safeModeAssets: solAmount.nullish(), safeTokenCount: amount.nullish(), safeClaimAmount: solAmount.nullish(),
});
const transactionsSchema = z.array(z.string().max(1644).refine(value => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= 1232 && bytes.toString('base64') === value;
}, 'Invalid serialized transaction')).max(MAX_TRANSACTIONS).refine(rows => new Set(rows).size === rows.length, 'Duplicate transactions');
const stakesBuildSchema = z.object({
  transactions: transactionsSchema, stakeCount: amount.max(MAX_TARGETS),
  totalWithdrawableLamports: amount, totalFeeLamports: amount, totalNetLamports: amount,
}).refine(value => value.totalNetLamports === value.totalWithdrawableLamports - value.totalFeeLamports, 'Inconsistent stake totals');

async function readBoundedJson(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new ScannerError('INVALID_BACKEND_RESPONSE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ScannerError('BACKEND_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ScannerError('INVALID_BACKEND_RESPONSE');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ScannerService {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Unclaimed-Source': 'mcp',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  /**
   * POST /api/check-claimable-sol
   * Used by scan_claimable_sol tool.
   */
  async getScanSummary(wallet: string): Promise<ScanSummaryResponse> {
    const response = await fetch(
      `${this.config.apiUrl}/api/check-claimable-sol`,
      {
        method: 'POST',
        redirect: 'error',
        headers: this.buildHeaders(),
        body: JSON.stringify({ publicKey: wallet }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (response.status === 429) {
      throw new ScannerError(
        'Too many requests. Try again in a minute or visit https://unclaimedsol.com directly.',
      );
    }
    if (!response.ok) {
      throw new ScannerError(
        'Scanner temporarily unavailable. Visit https://unclaimedsol.com directly.',
      );
    }

    const data = parseContract(summarySchema, await readBoundedJson(response));
    const maxClaimableSol = data.maxClaimableSol ?? data.totalClaimableSol;
    if (data.safeModeAssets === null || data.safeTokenCount === null || data.safeClaimAmount === null) {
      return { ...data, totalClaimableSol: 0, assets: 0, tokenCount: 0, maxClaimableSol, safeSummaryAvailable: false };
    }

    // Prefer explicit safe claim total when available.
    if (data.safeClaimAmount != null) {
      data.totalClaimableSol = data.safeClaimAmount;
      if (data.safeModeAssets != null) {
        data.assets = data.safeModeAssets;
      }
    } else if (data.safeModeAssets != null) {
      // Backward compatibility for older backend payloads.
      // Both safeModeAssets and buffers are already in SOL.
      data.totalClaimableSol = data.safeModeAssets + (data.buffers || 0);
      data.assets = data.safeModeAssets;
    }
    if (data.safeTokenCount != null) {
      data.tokenCount = data.safeTokenCount;
    }
    data.maxClaimableSol = maxClaimableSol;

    return data;
  }

  /**
   * POST /api/get-claimable-tokens
   * Used by claim_sol.
   *
   * Preserve the published backend safe-mode discovery contract.
   */
  async getClaimableTokens(wallet: string): Promise<TokensResponse> {
    const response = await fetch(
      `${this.config.apiUrl}/api/get-claimable-tokens`,
      {
        method: 'POST',
        redirect: 'error',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          publicKey: wallet,
          maxClaimMode: false,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      throw new ScannerError('Failed to fetch token accounts.');
    }

    const data = parseContract(tokenResponseSchema, await readBoundedJson(response));
    const { rows, omittedCount } = truncateTargets(data.tokens);
    return { ...data, tokens: rows, ...(omittedCount > 0 ? { omittedCount } : {}) };
  }

  /**
   * POST /api/get-claimable-buffers
   * Used by claim_sol.
   */
  async getClaimableBuffers(wallet: string): Promise<BuffersResponse> {
    const response = await fetch(
      `${this.config.apiUrl}/api/get-claimable-buffers`,
      {
        method: 'POST',
        redirect: 'error',
        headers: this.buildHeaders(),
        body: JSON.stringify({ publicKey: wallet, surface: 'dedicated', forceFresh: true }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      throw new ScannerError('Failed to fetch buffer accounts.');
    }

    const data = parseContract(bufferResponseSchema, await readBoundedJson(response));
    if (data.complete === false || data.cacheStatus === 'disabled' || data.terminationReason === 'disabled') {
      throw new ScannerError('BUFFER_DISCOVERY_UNAVAILABLE');
    }
    const { rows, omittedCount } = truncateTargets(data.buffers);
    return {
      claimableSol: data.claimableSol,
      buffers: rows.map(buffer => ({ pubkey: buffer.address, lamports: buffer.lamports, dataLength: buffer.dataSize })),
      ...(omittedCount > 0 ? { omittedCount } : {}),
    };
  }

  /**
   * POST /api/get-claimable-stakes
   * Used for reporting in dry-run. For claiming, use buildStakesTx().
   */
  async getClaimableStakes(
    wallet: string,
  ): Promise<{ count: number; estimatedSol: number }> {
    const response = await fetch(`${this.config.apiUrl}/api/get-claimable-stakes`, {
      method: 'POST',
        redirect: 'error', headers: this.buildHeaders(),
      body: JSON.stringify({ publicKey: wallet }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new ScannerError('STAKE_SCAN_UNAVAILABLE');
    const data = parseContract(z.object({
      stakeAccounts: uniqueTargets(z.object({ pubkey: address }).passthrough(), 'pubkey').max(MAX_TARGETS),
      count: amount.max(MAX_TARGETS), totalWithdrawableLamports: amount,
    }), await readBoundedJson(response));
    if (data.count !== data.stakeAccounts.length) throw new ScannerError('INVALID_STAKE_COUNT');
    return { count: data.count, estimatedSol: data.totalWithdrawableLamports / 1e9 };
  }

  /**
   * POST /api/rewards/scan
   * Returns rewards scan info (cashback, creator fees, profitability).
   */
  async getRewardsScan(wallet: string): Promise<RewardsScanResponse> {
    const response = await fetch(
      `${this.config.apiUrl}/api/rewards/scan`,
      {
        method: 'POST',
        redirect: 'error',
        headers: this.buildHeaders(),
        body: JSON.stringify({ publicKey: wallet }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      throw new ScannerError('Failed to fetch rewards scan.');
    }

    // Backend sends amount fields as stringified BigInts — normalize to numbers.
    const raw: RawRewardsScanResponse = await readBoundedJson(response);
    const usdcRewards = normalizeUsdcSummary(raw.usdcRewards);
    return {
      pumpCashback: numberFromString(raw.pumpCashback),
      pumpSwapCashback: numberFromString(raw.pumpSwapCashback),
      pumpCreatorFee: numberFromString(raw.pumpCreatorFee),
      pumpSwapCreatorFee: numberFromString(raw.pumpSwapCreatorFee),
      raydiumLaunchLabCreatorFee: numberFromString(
        raw.raydiumLaunchLabCreatorFee,
      ),
      raydiumCpmmCreatorFee: numberFromString(raw.raydiumCpmmCreatorFee),
      meteoraDbcCreatorFee: numberFromString(raw.meteoraDbcCreatorFee),
      pumpAccumulatorCloseLamports: numberFromString(
        raw.pumpAccumulatorCloseLamports,
      ),
      pumpSwapAccumulatorCloseLamports: numberFromString(
        raw.pumpSwapAccumulatorCloseLamports,
      ),
      total: numberFromString(raw.total),
      isLikelyProfitable: raw.isLikelyProfitable,
      ...(usdcRewards ? { usdcRewards } : {}),
    };
  }

  /**
   * POST /api/rewards/build-tx
   * Returns base64-encoded unsigned transactions for claiming rewards.
   */
  async buildRewardsTx(wallet: string): Promise<RewardsBuildTxResponse> {
    const response = await fetch(
      `${this.config.apiUrl}/api/rewards/build-tx`,
      {
        method: 'POST',
        redirect: 'error',
        headers: this.buildHeaders(),
        body: JSON.stringify({ publicKey: wallet, includeOtherRewards: false, includePumpFunCreatorFees: true, includeKaminoFarmsRewards: false, includeOrcaAquafarmsRewards: false }),
        signal: AbortSignal.timeout(BUILD_TIMEOUT_MS),
      },
    );

    if (response.status === 429) {
      throw new ScannerError(
        'Too many requests. Try again in a minute.',
      );
    }
    if (!response.ok) {
      throw new ScannerError('Failed to build rewards transactions.');
    }

    // Backend sends rewardsSummary values as strings (BigInt.toString()).
    // Normalize to numbers so the rest of the codebase can use them directly.
    const raw = await readBoundedJson(response);
    const s = raw.builtSummary ?? raw.rewardsSummary;
    if (!s || ['raydiumLaunchLabCreatorFee', 'raydiumCpmmCreatorFee', 'meteoraDbcCreatorFee'].some(key => numberFromString(s[key]) !== 0) || (s.splRewards?.length ?? 0) > 0) {
      throw new ScannerError('UNSUPPORTED_REWARD_SOURCE');
    }
    const usdcRewards = normalizeUsdcSummary(s.usdcRewards);
    return {
      transactions: parseContract(transactionsSchema, raw.transactions),
      rewardsSummary: {
        pumpCashback: numberFromString(s.pumpCashback),
        pumpSwapCashback: numberFromString(s.pumpSwapCashback),
        pumpCreatorFee: numberFromString(s.pumpCreatorFee),
        pumpSwapCreatorFee: numberFromString(s.pumpSwapCreatorFee),
        raydiumLaunchLabCreatorFee: numberFromString(
          s.raydiumLaunchLabCreatorFee,
        ),
        raydiumCpmmCreatorFee: numberFromString(s.raydiumCpmmCreatorFee),
        meteoraDbcCreatorFee: numberFromString(s.meteoraDbcCreatorFee),
        pumpAccumulatorCloseLamports: numberFromString(
          s.pumpAccumulatorCloseLamports,
        ),
        pumpSwapAccumulatorCloseLamports: numberFromString(
          s.pumpSwapAccumulatorCloseLamports,
        ),
        totalLamports: numberFromString(s.totalLamports),
        estimatedFeeLamports: numberFromString(
          s.estimatedFeeLamports ?? s.serviceFeeLamports,
        ),
        estimatedNetLamports: signedNumberFromString(String(s.estimatedNetLamports ?? s.netLamports ?? '0')),
        ...(usdcRewards ? { usdcRewards } : {}),
      },
    };
  }

  /**
   * POST /api/stakes/build-tx
   * Returns base64-encoded unsigned transactions for claiming stake accounts.
   */
  async buildStakesTx(
    wallet: string,
    stakeAccounts?: string[],
  ): Promise<StakesBuildTxResponse> {
    const body: Record<string, unknown> = { publicKey: wallet };
    if (stakeAccounts && stakeAccounts.length > 0) {
      body.stakeAccounts = stakeAccounts;
    }

    const response = await fetch(
      `${this.config.apiUrl}/api/stakes/build-tx`,
      {
        method: 'POST',
        redirect: 'error',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(BUILD_TIMEOUT_MS),
      },
    );

    if (response.status === 429) {
      throw new ScannerError(
        'Too many requests. Try again in a minute.',
      );
    }
    if (!response.ok) {
      throw new ScannerError('Failed to build stake transactions.');
    }

    return parseContract(stakesBuildSchema, await readBoundedJson(response));
  }
}

export class ScannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerError';
  }
}

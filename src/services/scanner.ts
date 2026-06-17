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
}

/**
 * Maps to buffer objects from POST /api/get-claimable-buffers
 */
export interface BufferAccountInfo {
  pubkey: string; // Buffer account address
  authority: string; // Buffer authority
  lamports: number; // Rent in lamports
}

/**
 * Response from POST /api/get-claimable-buffers
 * Body: { publicKey: "..." }
 */
export interface BuffersResponse {
  claimableSol: number; // userReceives
  buffers: BufferAccountInfo[];
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
  safeModeAssets?: number;
  safeTokenCount?: number;
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

function numberFromString(value: string | number | undefined): number {
  return Number(value ?? 0);
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

    const data = (await response.json()) as ScanSummaryResponse;
    const maxClaimableSol = data.maxClaimableSol ?? data.totalClaimableSol;

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
   * CRITICAL: maxClaimMode is ALWAYS false in MCP.
   * This ensures the backend's safety filtering is applied —
   * valuable tokens and NFTs are excluded.
   */
  async getClaimableTokens(wallet: string): Promise<TokensResponse> {
    const response = await fetch(
      `${this.config.apiUrl}/api/get-claimable-tokens`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          publicKey: wallet,
          maxClaimMode: false, // NEVER true in MCP
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      throw new ScannerError('Failed to fetch token accounts.');
    }

    return response.json() as Promise<TokensResponse>;
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
        headers: this.buildHeaders(),
        body: JSON.stringify({ publicKey: wallet }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      throw new ScannerError('Failed to fetch buffer accounts.');
    }

    return response.json() as Promise<BuffersResponse>;
  }

  /**
   * POST /api/get-claimable-stakes
   * Used for reporting in dry-run. For claiming, use buildStakesTx().
   */
  async getClaimableStakes(
    wallet: string,
  ): Promise<{ count: number; estimatedSol: number }> {
    try {
      const response = await fetch(
        `${this.config.apiUrl}/api/get-claimable-stakes`,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify({ publicKey: wallet }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );

      if (!response.ok) return { count: 0, estimatedSol: 0 };

      const data = (await response.json()) as any;

      return {
        count: Array.isArray(data.stakes) ? data.stakes.length : 0,
        estimatedSol: data.totalClaimableSol || data.totalSol || 0,
      };
    } catch {
      return { count: 0, estimatedSol: 0 }; // Non-fatal
    }
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
        headers: this.buildHeaders(),
        body: JSON.stringify({ publicKey: wallet }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      throw new ScannerError('Failed to fetch rewards scan.');
    }

    // Backend sends amount fields as stringified BigInts — normalize to numbers.
    const raw: RawRewardsScanResponse = await response.json();
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
        headers: this.buildHeaders(),
        body: JSON.stringify({ publicKey: wallet }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    const raw = await response.json();
    const s = raw.builtSummary ?? raw.rewardsSummary;
    const usdcRewards = normalizeUsdcSummary(s.usdcRewards);
    return {
      transactions: raw.transactions,
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
        estimatedNetLamports: numberFromString(
          s.estimatedNetLamports ?? s.netLamports,
        ),
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
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

    return response.json() as Promise<StakesBuildTxResponse>;
  }
}

export class ScannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerError';
  }
}

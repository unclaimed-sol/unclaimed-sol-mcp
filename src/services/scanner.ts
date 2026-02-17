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
  tokenCount?: number; // ADD TO BACKEND
  bufferCount?: number; // ADD TO BACKEND
}

const REQUEST_TIMEOUT_MS = 15_000;

export class ScannerService {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
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

    return response.json() as Promise<ScanSummaryResponse>;
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
   * Only for reporting in dry-run. MCP never claims stake accounts.
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
}

export class ScannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerError';
  }
}

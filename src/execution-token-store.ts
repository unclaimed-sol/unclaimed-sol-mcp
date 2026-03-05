import { randomBytes } from 'crypto';
import { EXECUTION_TOKEN_TTL_MS, MAX_ACTIVE_TOKENS } from './constants.js';

interface TokenEntry<T> {
  token: string;
  wallet: string;
  payload: T;
  createdAt: number;
}

export class ExecutionTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionTokenError';
  }
}

/**
 * Generic execution-token store used by claim tools.
 * Each tool instantiates its own store with its payload type.
 */
export class ExecutionTokenStore<T> {
  private tokensByWallet = new Map<string, TokenEntry<T>>();
  private allTokens = new Map<string, TokenEntry<T>>();
  private toolName: string;

  constructor(toolName: string) {
    this.toolName = toolName;
  }

  generate(wallet: string, payload: T): string {
    const now = Date.now();
    // Evict expired
    for (const [t, e] of this.allTokens) {
      if (now - e.createdAt > EXECUTION_TOKEN_TTL_MS) {
        this.allTokens.delete(t);
        if (this.tokensByWallet.get(e.wallet)?.token === t)
          this.tokensByWallet.delete(e.wallet);
      }
    }
    // Enforce max (evict oldest)
    while (this.allTokens.size >= MAX_ACTIVE_TOKENS) {
      let oldest: string | null = null;
      let oldestTime = Infinity;
      for (const [t, e] of this.allTokens) {
        if (e.createdAt < oldestTime) {
          oldestTime = e.createdAt;
          oldest = t;
        }
      }
      if (oldest) {
        const e = this.allTokens.get(oldest)!;
        this.allTokens.delete(oldest);
        if (this.tokensByWallet.get(e.wallet)?.token === oldest)
          this.tokensByWallet.delete(e.wallet);
      }
    }
    // Invalidate previous for this wallet (max 1 per wallet)
    const prev = this.tokensByWallet.get(wallet);
    if (prev) this.allTokens.delete(prev.token);

    const token = randomBytes(16).toString('hex');
    const entry: TokenEntry<T> = { token, wallet, payload, createdAt: now };
    this.allTokens.set(token, entry);
    this.tokensByWallet.set(wallet, entry);
    return token;
  }

  validate(token: string, wallet: string): T {
    const entry = this.allTokens.get(token);
    if (!entry)
      throw new ExecutionTokenError(
        `Run ${this.toolName} with dry_run first to get an execution token.`,
      );
    if (entry.wallet !== wallet)
      throw new ExecutionTokenError(
        'Execution token does not match this wallet.',
      );
    if (Date.now() - entry.createdAt > EXECUTION_TOKEN_TTL_MS) {
      this.allTokens.delete(token);
      this.tokensByWallet.delete(wallet);
      throw new ExecutionTokenError(
        'Execution token expired. Run dry_run again.',
      );
    }
    return entry.payload;
  }

  consume(token: string, wallet: string): void {
    this.allTokens.delete(token);
    if (this.tokensByWallet.get(wallet)?.token === token)
      this.tokensByWallet.delete(wallet);
  }
}

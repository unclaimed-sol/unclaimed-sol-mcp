import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  ExecutionTokenStore,
  ExecutionTokenError,
} from '../src/execution-token-store.js';
import { EXECUTION_TOKEN_TTL_MS, MAX_ACTIVE_TOKENS } from '../src/constants.js';

describe('ExecutionTokenStore', () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const WALLET_A = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
  const WALLET_B = 'WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';

  it('generates a hex token string', () => {
    const store = new ExecutionTokenStore<string>('test');
    const token = store.generate(WALLET_A, 'payload');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('validates a freshly generated token', () => {
    const store = new ExecutionTokenStore<string>('test');
    const token = store.generate(WALLET_A, 'myPayload');
    const payload = store.validate(token, WALLET_A);
    expect(payload).toBe('myPayload');
  });

  it('consume removes the token', () => {
    const store = new ExecutionTokenStore<string>('test');
    const token = store.generate(WALLET_A, 'payload');
    store.consume(token, WALLET_A);
    expect(() => store.validate(token, WALLET_A)).toThrow(
      'dry_run first',
    );
  });

  it('consume is safe to call on unknown token', () => {
    const store = new ExecutionTokenStore<string>('test');
    expect(() => store.consume('nonexistent', WALLET_A)).not.toThrow();
  });

  it('rejects unknown token', () => {
    const store = new ExecutionTokenStore<string>('test');
    expect(() => store.validate('nonexistent', WALLET_A)).toThrow(
      'dry_run first',
    );
  });

  it('rejects token with wrong wallet', () => {
    const store = new ExecutionTokenStore<string>('test');
    const token = store.generate(WALLET_A, 'payload');
    expect(() => store.validate(token, WALLET_B)).toThrow(
      'does not match',
    );
  });

  it('expires token after TTL', () => {
    const store = new ExecutionTokenStore<string>('test');
    const token = store.generate(WALLET_A, 'payload');
    vi.advanceTimersByTime(EXECUTION_TOKEN_TTL_MS + 1);
    expect(() => store.validate(token, WALLET_A)).toThrow(
      'Execution token expired',
    );
  });

  it('token is still valid just before expiry', () => {
    const store = new ExecutionTokenStore<string>('test');
    const token = store.generate(WALLET_A, 'payload');
    vi.advanceTimersByTime(EXECUTION_TOKEN_TTL_MS - 1);
    expect(store.validate(token, WALLET_A)).toBe('payload');
  });

  it('one token per wallet: new token replaces old', () => {
    const store = new ExecutionTokenStore<string>('test');
    const token1 = store.generate(WALLET_A, 'first');
    const token2 = store.generate(WALLET_A, 'second');
    expect(token1).not.toBe(token2);
    expect(() => store.validate(token1, WALLET_A)).toThrow(ExecutionTokenError);
    expect(store.validate(token2, WALLET_A)).toBe('second');
  });

  it('different wallets can have independent tokens', () => {
    const store = new ExecutionTokenStore<string>('test');
    const tokenA = store.generate(WALLET_A, 'payloadA');
    const tokenB = store.generate(WALLET_B, 'payloadB');
    expect(store.validate(tokenA, WALLET_A)).toBe('payloadA');
    expect(store.validate(tokenB, WALLET_B)).toBe('payloadB');
  });

  it(`evicts oldest when max tokens (${MAX_ACTIVE_TOKENS}) reached`, () => {
    const store = new ExecutionTokenStore<number>('test');
    const wallets: string[] = [];
    const tokens: string[] = [];

    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      const wallet = `Wallet${String(i).padStart(40, '0')}AAAA`;
      wallets.push(wallet);
      tokens.push(store.generate(wallet, i));
    }

    expect(store.validate(tokens[MAX_ACTIVE_TOKENS - 1], wallets[MAX_ACTIVE_TOKENS - 1])).toBe(MAX_ACTIVE_TOKENS - 1);

    const extraWallet = `Wallet${String(MAX_ACTIVE_TOKENS).padStart(40, '0')}AAAA`;
    store.generate(extraWallet, MAX_ACTIVE_TOKENS);

    expect(() => store.validate(tokens[0], wallets[0])).toThrow(ExecutionTokenError);
    expect(store.validate(tokens[1], wallets[1])).toBe(1);
  });

  it('expired tokens are evicted during generate', () => {
    const store = new ExecutionTokenStore<string>('test');
    const token1 = store.generate(WALLET_A, 'old');
    vi.advanceTimersByTime(EXECUTION_TOKEN_TTL_MS + 1);
    const token2 = store.generate(WALLET_B, 'new');
    expect(() => store.validate(token1, WALLET_A)).toThrow(ExecutionTokenError);
    expect(store.validate(token2, WALLET_B)).toBe('new');
  });

  it('stores generic payload types', () => {
    const store = new ExecutionTokenStore<{ txCount: number; data: string[] }>('test');
    const payload = { txCount: 3, data: ['tx1', 'tx2', 'tx3'] };
    const token = store.generate(WALLET_A, payload);
    const result = store.validate(token, WALLET_A);
    expect(result).toEqual(payload);
  });
});

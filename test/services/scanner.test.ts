import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScannerService } from '../../src/services/scanner.js';
import type { Config } from '../../src/config.js';

function makeConfig(): Config {
  return {
    apiUrl: 'https://unclaimedsol.com',
    apiKey: null,
    keypair: null,
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    priorityFee: 1_000,
    claimEnabled: false,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ScannerService.getScanSummary', () => {
  it('preserves backend-provided maxClaimableSol while using safe claim amount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          totalClaimableSol: 10,
          maxClaimableSol: 12.5,
          assets: 10,
          buffers: 0.5,
          safeModeAssets: 2,
          safeTokenCount: 3,
          safeClaimAmount: 2.5,
        }),
      })),
    );

    const scanner = new ScannerService(makeConfig());
    const summary = await scanner.getScanSummary('11111111111111111111111111111111');

    expect(summary.totalClaimableSol).toBe(2.5);
    expect(summary.assets).toBe(2);
    expect(summary.tokenCount).toBe(3);
    expect(summary.maxClaimableSol).toBe(12.5);
  });

  it('falls back to raw total as max when backend does not send maxClaimableSol', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          totalClaimableSol: 10,
          assets: 10,
          buffers: 0.5,
          safeModeAssets: 2,
        }),
      })),
    );

    const scanner = new ScannerService(makeConfig());
    const summary = await scanner.getScanSummary('11111111111111111111111111111111');

    expect(summary.totalClaimableSol).toBe(2.5);
    expect(summary.assets).toBe(2);
    expect(summary.maxClaimableSol).toBe(10);
  });
});


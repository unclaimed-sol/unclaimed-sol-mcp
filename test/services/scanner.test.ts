import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
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
      vi.fn(async () => Response.json({
          totalClaimableSol: 10,
          maxClaimableSol: 12.5,
          assets: 10,
          buffers: 0.5,
          safeModeAssets: 2,
          safeTokenCount: 3,
          safeClaimAmount: 2.5,
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
      vi.fn(async () => Response.json({
          totalClaimableSol: 10,
          assets: 10,
          buffers: 0.5,
          safeModeAssets: 2,
      })),
    );

    const scanner = new ScannerService(makeConfig());
    const summary = await scanner.getScanSummary('11111111111111111111111111111111');

    expect(summary.totalClaimableSol).toBe(2.5);
    expect(summary.assets).toBe(2);
    expect(summary.maxClaimableSol).toBe(10);
  });
});


describe('ScannerService contract boundaries', () => {
  const wallet = '11111111111111111111111111111111';
  const summary = { totalClaimableSol: 1, assets: 1, buffers: 0 };
  const token = { pubKey: wallet, mintKey: wallet, amountUi: 0, isFrozen: false, lamports: 2_000_000, programOwnerId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
  const respond = (data: unknown) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));

  it('does not present unavailable safe totals as automatically claimable', async () => {
    respond({ totalClaimableSol: 5, assets: 5, buffers: 0, safeModeAssets: null, safeTokenCount: null, safeClaimAmount: null });
    const result = await new ScannerService(makeConfig()).getScanSummary(wallet);
    expect(result.safeSummaryAvailable).toBe(false);
    expect(result.totalClaimableSol).toBe(0);
    expect(result.maxClaimableSol).toBe(5);
  });

  it('normalizes deployed buffer fields and explicitly requests fresh dedicated discovery', async () => {
    respond({ claimableSol: 0.0019, buffers: [{address:wallet,lamports:2_000_000,dataSize:37}], complete:true });
    const result = await new ScannerService(makeConfig()).getClaimableBuffers(wallet);
    expect(result.buffers).toEqual([{pubkey:wallet,lamports:2_000_000,dataLength:37}]);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({publicKey:wallet,surface:'dedicated',forceFresh:true});
  });

  it.each([{complete:false}, {cacheStatus:'disabled'}])('rejects unavailable buffer discovery %j', async flags => {
    respond({claimableSol:0,buffers:[],...flags});
    await expect(new ScannerService(makeConfig()).getClaimableBuffers(wallet)).rejects.toThrow('BUFFER_DISCOVERY_UNAVAILABLE');
  });

  it('parses current backend stake fields', async () => {
    respond({ stakeAccounts: [{ pubkey: wallet }], count: 1, totalWithdrawableLamports: 2_000_000_000 });
    expect(await new ScannerService(makeConfig()).getClaimableStakes(wallet)).toEqual({ count: 1, estimatedSol: 2 });
  });

  it('explicitly requests Pump-only builds with a 30-second timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    respond({ transactions: [], rewardsSummary: {} });
    await new ScannerService(makeConfig()).buildRewardsTx(wallet);
    const fetchMock = vi.mocked(fetch);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      publicKey: wallet, includeOtherRewards: false, includePumpFunCreatorFees: true,
      includeKaminoFarmsRewards: false, includeOrcaAquafarmsRewards: false,
    });
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it('limits scans to 15 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    respond(summary);
    await new ScannerService(makeConfig()).getScanSummary(wallet);
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it.each([NaN, Infinity, -1])('rejects invalid SOL totals: %s', async value => {
    respond({ ...summary, totalClaimableSol: value });
    await expect(new ScannerService(makeConfig()).getScanSummary(wallet)).rejects.toThrow();
  });

  it.each([['1e309'], ['-1'], ['9007199254740992'], ['not-a-number']])('rejects unsafe reward integer %s', async value => {
    respond({ pumpCashback: value });
    await expect(new ScannerService(makeConfig()).getRewardsScan(wallet)).rejects.toThrow('INVALID_BACKEND_AMOUNT');
  });

  it('rejects duplicate token targets', async () => {
    respond({ tokens: [token, token], claimableSol: 0, rewardFee: 0 });
    await expect(new ScannerService(makeConfig()).getClaimableTokens(wallet)).rejects.toThrow('INVALID_BACKEND_RESPONSE');
  });

  it('keeps the first 256 token targets and reports the omitted remainder', async () => {
    const tokens = Array.from({ length: 300 }, () => ({ ...token, pubKey: Keypair.generate().publicKey.toBase58() }));
    respond({ tokens, claimableSol: 0, rewardFee: 0 });
    const result = await new ScannerService(makeConfig()).getClaimableTokens(wallet);
    expect(result.tokens).toEqual(tokens.slice(0, 256));
    expect(result.omittedCount).toBe(44);
  });

  it('omits the count when every target fits', async () => {
    respond({ tokens: [token], claimableSol: 0, rewardFee: 0 });
    expect(await new ScannerService(makeConfig()).getClaimableTokens(wallet)).not.toHaveProperty('omittedCount');
  });

  it('reports a contract mismatch as a scanner error', async () => {
    respond({ tokens: [{ ...token, lamports: 'one' }], claimableSol: 0, rewardFee: 0 });
    await expect(new ScannerService(makeConfig()).getClaimableTokens(wallet)).rejects.toThrow('INVALID_BACKEND_RESPONSE');
  });

  it('rejects oversized serialized transactions', async () => {
    respond({ transactions: [Buffer.alloc(1233).toString('base64')], rewardsSummary: {} });
    await expect(new ScannerService(makeConfig()).buildRewardsTx(wallet)).rejects.toThrow();
  });

  it('rejects oversized streaming bodies without a Content-Length', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1_048_577)); controller.close(); },
    }))));
    await expect(new ScannerService(makeConfig()).getScanSummary(wallet)).rejects.toThrow('BACKEND_RESPONSE_TOO_LARGE');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { Keypair, Transaction } from '@solana/web3.js';
import { handleClaim } from '../../src/tools/claim.js';
import type { Config } from '../../src/config.js';
import type {
  TokenAccountInfo,
  BuffersResponse,
  TokensResponse,
} from '../../src/services/scanner.js';
import type { ClaimPlan } from '../../src/services/transaction.js';

function makeToken(
  symbol: string,
  pubKey: string,
  mintKey: string,
): TokenAccountInfo {
  return {
    pubKey,
    mintKey,
    amountUi: 0,
    isFrozen: false,
    lamports: 1_000_000,
    symbol,
    name: symbol,
    decimals: 9,
    programOwnerId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  };
}

function makePlan(
  selectedTokenPubkeys: string[],
  totalTokenAccountCount: number,
): ClaimPlan {
  return {
    tokenAccountCount: selectedTokenPubkeys.length,
    bufferAccountCount: 0,
    selectedTokenPubkeys,
    selectedBufferPubkeys: [],
    totalTokenAccountCount,
    totalBufferAccountCount: 0,
    estimatedSol: 0.002,
    transactionsNeeded: 1,
    totalTransactionsNeeded: 2,
    transactions: [new Transaction()],
    cappedByMaxTx: true,
    skippedFrozenCount: 0,
    stakeInfo: null,
  };
}

describe('claim_sol exclude execution scope', () => {
  it('applies exclude only within dry-run-selected accounts', async () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();

    const tokenA = makeToken(
      'AAA',
      Keypair.generate().publicKey.toBase58(),
      Keypair.generate().publicKey.toBase58(),
    );
    const tokenB = makeToken(
      'BBB',
      Keypair.generate().publicKey.toBase58(),
      Keypair.generate().publicKey.toBase58(),
    );
    const tokenC = makeToken(
      'CCC',
      Keypair.generate().publicKey.toBase58(),
      Keypair.generate().publicKey.toBase58(),
    );

    const buildClaimPlan = vi
      .fn<(...args: any[]) => Promise<ClaimPlan>>()
      .mockResolvedValueOnce(
        makePlan([tokenA.pubKey, tokenB.pubKey], 3),
      )
      .mockResolvedValueOnce(
        makePlan([tokenA.pubKey], 2),
      );

    const scanner = {
      getClaimableTokens: vi.fn<(...args: any[]) => Promise<TokensResponse>>(
        async () => ({
          claimableSol: 0.003,
          tokens: [tokenA, tokenB, tokenC],
          rewardFee: 0.05,
        }),
      ),
      getClaimableBuffers: vi.fn<(...args: any[]) => Promise<BuffersResponse>>(
        async () => ({
          claimableSol: 0,
          buffers: [],
        }),
      ),
      getClaimableStakes: vi.fn(async () => ({ count: 0, estimatedSol: 0 })),
    } as any;

    const txBuilder = {
      buildClaimPlan,
      validateTransactions: vi.fn(),
    } as any;

    const signer = {
      getBalance: vi
        .fn()
        .mockResolvedValueOnce(1_000_000_000)
        .mockResolvedValueOnce(1_100_000_000),
      signAndSendBatch: vi.fn(async () => [
        { status: 'confirmed', signature: 'sig-1' },
      ]),
    } as any;

    const config: Config = {
      apiUrl: 'https://unclaimedsol.com',
      apiKey: null,
      keypair: kp,
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      priorityFee: 1_000,
      claimEnabled: true,
    };

    const dryRun = await handleClaim(
      { wallet_address: wallet, dry_run: true, max_transactions: 1 },
      config,
      scanner,
      txBuilder,
      signer,
    );

    const tokenMatch = dryRun.content[0].text.match(
      /Execution token: ([a-f0-9]{32})/,
    );
    expect(tokenMatch?.[1]).toBeTruthy();
    const executionToken = tokenMatch![1];

    await handleClaim(
      {
        wallet_address: wallet,
        dry_run: false,
        execution_token: executionToken,
        exclude: ['BBB'],
      },
      config,
      scanner,
      txBuilder,
      signer,
    );

    expect(buildClaimPlan).toHaveBeenCalledTimes(2);

    const secondCallTokens = buildClaimPlan.mock.calls[1][0] as TokenAccountInfo[];
    const secondCallPubkeys = secondCallTokens.map((t) => t.pubKey);

    expect(secondCallPubkeys).toContain(tokenA.pubKey);
    expect(secondCallPubkeys).not.toContain(tokenB.pubKey);
    expect(secondCallPubkeys).not.toContain(tokenC.pubKey);
  });
});


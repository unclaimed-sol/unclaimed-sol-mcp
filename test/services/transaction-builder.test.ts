/**
 * Tests for TransactionBuilder.validateTransactions (local claim_sol path)
 * and buildClaimPlan (core claim_sol batching logic).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  Keypair,
} from '@solana/web3.js';
import {
  TransactionBuilder,
  TransactionValidationError,
} from '../../src/services/transaction.js';
import {
  PROGRAM_ID,
  FEE_VAULT,
  EXPECTED_PROGRAM_IDS,
  BPF_LOADER_UPGRADEABLE,
  TOKEN_PAIRS_PER_IX,
  BUFFERS_PER_IX,
} from '../../src/constants.js';
import {
  PROGRAM_ID as SDK_PROGRAM_ID,
  FEE_RECIPIENT as SDK_FEE_RECIPIENT,
} from '@unclaimedsol/spl-burn-close-sdk';
import type { TokenAccountInfo, BufferAccountInfo } from '../../src/services/scanner.js';
import type { Config } from '../../src/config.js';

// Mock the SDK's buildBurnAndCloseInstruction
vi.mock('@unclaimedsol/spl-burn-close-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unclaimedsol/spl-burn-close-sdk')>();
  return {
    ...actual,
    buildBurnAndCloseInstruction: vi.fn(async (programId, user, pairs, tokenProgramId) => {
      // Return a dummy instruction with keys proportional to pairs
      const keys = [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: actual.FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false },
        { pubkey: programId, isSigner: false, isWritable: false },
        ...pairs.flatMap((p: { mint: PublicKey; ata: PublicKey }) => [
          { pubkey: p.mint, isSigner: false, isWritable: false },
          { pubkey: p.ata, isSigner: false, isWritable: true },
        ]),
      ];
      return new TransactionInstruction({
        keys,
        programId,
        data: Buffer.from([0]),
      });
    }),
  };
});

const wallet = Keypair.generate().publicKey;
const feeVaultKey = new PublicKey(FEE_VAULT);

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    apiUrl: 'https://unclaimedsol.com',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    priorityFee: 1_000,
    claimEnabled: true,
    keypair: undefined,
    apiKey: undefined,
    ...overrides,
  } as Config;
}

function makeToken(overrides?: Partial<TokenAccountInfo>): TokenAccountInfo {
  return {
    pubKey: Keypair.generate().publicKey.toBase58(),
    mintKey: Keypair.generate().publicKey.toBase58(),
    amountUi: 0,
    isFrozen: false,
    lamports: 2_000_000, // ~0.002 SOL
    symbol: 'TEST',
    name: 'Test Token',
    decimals: 9,
    programOwnerId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ...overrides,
  };
}

function makeBuffer(overrides?: Partial<BufferAccountInfo>): BufferAccountInfo {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    authority: wallet.toBase58(),
    lamports: 5_000_000, // ~0.005 SOL
    ...overrides,
  };
}

// ============================================================================
// validateTransactions (local claim_sol path)
// ============================================================================

describe('TransactionBuilder.validateTransactions', () => {
  const builder = new TransactionBuilder(makeConfig());

  function makeValidLocalTx(): Transaction {
    const tx = new Transaction();
    // ComputeBudget
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
    // UnclaimedSOL instruction with fee vault
    tx.add(
      new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: feeVaultKey, isSigner: false, isWritable: true },
        ],
        programId: SDK_PROGRAM_ID,
        data: Buffer.from([0]),
      }),
    );
    return tx;
  }

  it('accepts valid local claim transaction', () => {
    const tx = makeValidLocalTx();
    expect(() => builder.validateTransactions([tx], wallet)).not.toThrow();
  });

  it('rejects unknown program', () => {
    const tx = makeValidLocalTx();
    tx.add(
      new TransactionInstruction({
        keys: [{ pubkey: wallet, isSigner: false, isWritable: false }],
        programId: Keypair.generate().publicKey,
        data: Buffer.alloc(0),
      }),
    );
    expect(() => builder.validateTransactions([tx], wallet)).toThrow(
      'unexpected program',
    );
  });

  it('allows all EXPECTED_PROGRAM_IDS', () => {
    const sdkProgramStr = SDK_PROGRAM_ID.toBase58();
    for (const pid of EXPECTED_PROGRAM_IDS) {
      const tx = new Transaction();
      // Add an UnclaimedSOL instruction with fee vault
      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: wallet, isSigner: true, isWritable: true },
            { pubkey: feeVaultKey, isSigner: false, isWritable: true },
          ],
          programId: SDK_PROGRAM_ID,
          data: Buffer.from([0]),
        }),
      );
      // Skip if this IS the UnclaimedSOL program (already added above with fee vault)
      if (pid !== sdkProgramStr) {
        tx.add(
          new TransactionInstruction({
            keys: [{ pubkey: wallet, isSigner: false, isWritable: false }],
            programId: new PublicKey(pid),
            data: Buffer.alloc(0),
          }),
        );
      }
      expect(() => builder.validateTransactions([tx], wallet)).not.toThrow();
    }
  });

  it('rejects backend-only programs (Pump, PumpSwap, ATA, Stake)', () => {
    const backendOnlyPrograms = [
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // ATA
      'Stake11111111111111111111111111111111111111', // Stake
    ];
    for (const pid of backendOnlyPrograms) {
      const tx = makeValidLocalTx();
      tx.add(
        new TransactionInstruction({
          keys: [{ pubkey: wallet, isSigner: false, isWritable: false }],
          programId: new PublicKey(pid),
          data: Buffer.alloc(0),
        }),
      );
      expect(() => builder.validateTransactions([tx], wallet)).toThrow(
        'unexpected program',
      );
    }
  });

  it('rejects System Program writing to unknown account', () => {
    const tx = new Transaction();
    tx.add(
      new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: feeVaultKey, isSigner: false, isWritable: true },
        ],
        programId: SDK_PROGRAM_ID,
        data: Buffer.from([0]),
      }),
    );
    // System instruction writing to a random unknown account
    tx.add(
      new TransactionInstruction({
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        ],
        programId: SystemProgram.programId,
        data: Buffer.alloc(0),
      }),
    );
    expect(() => builder.validateTransactions([tx], wallet)).toThrow(
      'system program writing to unknown account',
    );
  });

  it('allows System Program writing to wallet', () => {
    const tx = new Transaction();
    tx.add(
      new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: feeVaultKey, isSigner: false, isWritable: true },
        ],
        programId: SDK_PROGRAM_ID,
        data: Buffer.from([0]),
      }),
    );
    tx.add(
      new TransactionInstruction({
        keys: [{ pubkey: wallet, isSigner: true, isWritable: true }],
        programId: SystemProgram.programId,
        data: Buffer.alloc(0),
      }),
    );
    expect(() => builder.validateTransactions([tx], wallet)).not.toThrow();
  });

  it('allows System Program writing to fee vault', () => {
    const tx = new Transaction();
    tx.add(
      new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: feeVaultKey, isSigner: false, isWritable: true },
        ],
        programId: SDK_PROGRAM_ID,
        data: Buffer.from([0]),
      }),
    );
    tx.add(
      new TransactionInstruction({
        keys: [{ pubkey: feeVaultKey, isSigner: false, isWritable: true }],
        programId: SystemProgram.programId,
        data: Buffer.alloc(0),
      }),
    );
    expect(() => builder.validateTransactions([tx], wallet)).not.toThrow();
  });

  it('rejects UnclaimedSOL instruction missing fee vault', () => {
    const tx = new Transaction();
    tx.add(
      new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          // No fee vault key!
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        ],
        programId: SDK_PROGRAM_ID,
        data: Buffer.from([0]),
      }),
    );
    expect(() => builder.validateTransactions([tx], wallet)).toThrow(
      'missing fee vault',
    );
  });

  it('error includes tx number', () => {
    const tx1 = makeValidLocalTx();
    const tx2 = new Transaction();
    tx2.add(
      new TransactionInstruction({
        keys: [{ pubkey: wallet, isSigner: false, isWritable: false }],
        programId: Keypair.generate().publicKey,
        data: Buffer.alloc(0),
      }),
    );
    expect(() =>
      builder.validateTransactions([tx1, tx2], wallet),
    ).toThrow('Tx 2');
  });
});

// ============================================================================
// buildClaimPlan
// ============================================================================

describe('TransactionBuilder.buildClaimPlan', () => {
  const builder = new TransactionBuilder(makeConfig());

  it('skips frozen accounts', async () => {
    const tokens = [
      makeToken({ isFrozen: true, lamports: 1_000_000 }),
      makeToken({ isFrozen: true, lamports: 2_000_000 }),
      makeToken({ isFrozen: false, lamports: 3_000_000 }),
    ];
    const plan = await builder.buildClaimPlan(tokens, [], wallet, 10);
    expect(plan.skippedFrozenCount).toBe(2);
    expect(plan.tokenAccountCount).toBe(1);
  });

  it('batches tokens at TOKEN_PAIRS_PER_IX (12) per instruction', async () => {
    // 25 tokens → 3 instructions (12 + 12 + 1), 3 txs (1 ix per tx)
    const tokens = Array.from({ length: 25 }, () => makeToken());
    const plan = await builder.buildClaimPlan(tokens, [], wallet, 100);
    expect(plan.transactionsNeeded).toBe(3);
    expect(plan.tokenAccountCount).toBe(25);
  });

  it('batches buffers at BUFFERS_PER_IX (25) per instruction', async () => {
    // 60 buffers → 3 instructions (25 + 25 + 10), 3 txs
    const buffers = Array.from({ length: 60 }, () => makeBuffer());
    const plan = await builder.buildClaimPlan([], buffers, wallet, 100);
    expect(plan.transactionsNeeded).toBe(3);
    expect(plan.bufferAccountCount).toBe(60);
  });

  it('caps transactions at maxTransactions', async () => {
    const tokens = Array.from({ length: 50 }, () => makeToken());
    const plan = await builder.buildClaimPlan(tokens, [], wallet, 2);
    expect(plan.transactionsNeeded).toBe(2);
    expect(plan.cappedByMaxTx).toBe(true);
    expect(plan.totalTransactionsNeeded).toBeGreaterThan(2);
    expect(plan.transactions).toHaveLength(2);
  });

  it('computes SOL estimate from covered accounts only', async () => {
    const tokens = Array.from({ length: 25 }, () =>
      makeToken({ lamports: 1_000_000_000 }),
    ); // each 1 SOL
    // Only take 2 txs → 24 tokens covered (12 + 12)
    const plan = await builder.buildClaimPlan(tokens, [], wallet, 2);
    // 24 tokens × 1 SOL each = 24 SOL
    expect(plan.estimatedSol).toBe(24);
    expect(plan.tokenAccountCount).toBe(24);
  });

  it('includes stakeInfo when provided', async () => {
    const tokens = [makeToken()];
    const stakeInfo = { count: 5, estimatedSol: 2.5 };
    const plan = await builder.buildClaimPlan(tokens, [], wallet, 10, stakeInfo);
    expect(plan.stakeInfo).toEqual(stakeInfo);
  });

  it('stakeInfo defaults to null', async () => {
    const tokens = [makeToken()];
    const plan = await builder.buildClaimPlan(tokens, [], wallet, 10);
    expect(plan.stakeInfo).toBeNull();
  });

  it('throws when no accounts to claim', async () => {
    await expect(
      builder.buildClaimPlan([], [], wallet, 10),
    ).rejects.toThrow('No token or buffer accounts to claim');
  });

  it('handles mix of tokens and buffers', async () => {
    const tokens = Array.from({ length: 5 }, () => makeToken({ lamports: 1_000_000 }));
    const buffers = Array.from({ length: 3 }, () => makeBuffer({ lamports: 2_000_000 }));
    const plan = await builder.buildClaimPlan(tokens, buffers, wallet, 10);
    expect(plan.tokenAccountCount).toBe(5);
    expect(plan.bufferAccountCount).toBe(3);
    // tokens: 1 ix (5 < 12), buffers: 1 ix (3 < 25) → 2 txs
    expect(plan.transactionsNeeded).toBe(2);
    const expectedLamports = 5 * 1_000_000 + 3 * 2_000_000;
    expect(plan.estimatedSol).toBeCloseTo(expectedLamports / 1e9, 9);
  });

  it('creates 1 transaction per instruction group', async () => {
    // Exactly 12 tokens = 1 ix = 1 tx
    const tokens = Array.from({ length: TOKEN_PAIRS_PER_IX }, () => makeToken());
    const plan = await builder.buildClaimPlan(tokens, [], wallet, 10);
    expect(plan.transactionsNeeded).toBe(1);

    // 13 tokens = 2 ixs = 2 txs
    const tokens2 = Array.from({ length: TOKEN_PAIRS_PER_IX + 1 }, () => makeToken());
    const plan2 = await builder.buildClaimPlan(tokens2, [], wallet, 10);
    expect(plan2.transactionsNeeded).toBe(2);
  });

  it('each transaction has compute budget instructions', async () => {
    const tokens = [makeToken()];
    const plan = await builder.buildClaimPlan(tokens, [], wallet, 10);
    const tx = plan.transactions[0];
    // First two instructions should be ComputeBudget
    const programs = tx.instructions.map((ix) => ix.programId.toBase58());
    const computeBudgetId = ComputeBudgetProgram.programId.toBase58();
    expect(programs[0]).toBe(computeBudgetId);
    expect(programs[1]).toBe(computeBudgetId);
  });
});

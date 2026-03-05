/**
 * Tests for validateTransactionPrograms — the pre-sign security gate for
 * backend-built transactions (claim_rewards, claim_stakes).
 *
 * Strategy: fixture-driven. Build one valid transaction per allowed program
 * shape, then mutate one field per test to verify rejection.
 */
import { describe, it, expect } from 'vitest';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  Keypair,
} from '@solana/web3.js';
import {
  validateTransactionPrograms,
  TransactionValidationError,
} from '../../src/services/transaction.js';
import {
  FEE_VAULT,
  REWARDS_FEE_BPS,
  STAKES_FEE_BPS,
} from '../../src/constants.js';
import { PROGRAM_ID as SDK_PROGRAM_ID } from '@unclaimedsol/spl-burn-close-sdk';

// ---------------------------------------------------------------------------
// Independent test constants — hardcoded so a production drift is caught.
//
// These intentionally duplicate values from transaction.ts. If someone
// changes a discriminator, program ID, or PDA seed in production, the
// fixtures built from these values will no longer match what the validator
// expects, causing tests to fail and surfacing the change.
// ---------------------------------------------------------------------------
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const STAKE_PROGRAM_ID = new PublicKey('Stake11111111111111111111111111111111111111');
const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';

// Discriminators — raw bytes, independent of production constants.
const PUMP_CLAIM_CASHBACK = Buffer.from([37, 58, 35, 126, 190, 53, 228, 197]);
const PUMP_COLLECT_CREATOR_FEE = Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]);
const PUMPSWAP_COLLECT_COIN_CREATOR_FEE = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]);

// ---------------------------------------------------------------------------
// Independent PDA derivation — mirrors the algorithm but lives in the test.
// ---------------------------------------------------------------------------
function derivePda(seeds: (string | PublicKey)[], programId: PublicKey): PublicKey {
  const buffers = seeds.map((s) =>
    typeof s === 'string' ? Buffer.from(s) : s.toBuffer(),
  );
  const [pda] = PublicKey.findProgramAddressSync(buffers, programId);
  return pda;
}

function deriveAta(owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

// Test wallet
const wallet = Keypair.generate().publicKey;
const feeVault = new PublicKey(FEE_VAULT);
const randomKey = Keypair.generate().publicKey;

// Pre-derive wallet PDAs using the independent helpers above.
const pumpAccumulator = derivePda(['user_volume_accumulator', wallet], PUMP_PROGRAM_ID);
const pumpCreatorVault = derivePda(['creator-vault', wallet], PUMP_PROGRAM_ID);
const pumpEventAuthority = derivePda(['__event_authority'], PUMP_PROGRAM_ID);
const pumpSwapAccumulator = derivePda(['user_volume_accumulator', wallet], PUMP_AMM_PROGRAM_ID);
const pumpSwapCreatorVaultAuthority = derivePda(['creator_vault', wallet], PUMP_AMM_PROGRAM_ID);
const pumpSwapEventAuthority = derivePda(['__event_authority'], PUMP_AMM_PROGRAM_ID);
const userWsolAta = deriveAta(wallet);
const pumpSwapAccumulatorWsolAta = deriveAta(pumpSwapAccumulator);
const pumpSwapCreatorVaultAta = deriveAta(pumpSwapCreatorVaultAuthority);

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------
function makeSystemTransfer(lamports: number, source = wallet, dest = feeVault): TransactionInstruction {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // Transfer type
  data.writeBigUInt64LE(BigInt(lamports), 4);
  return new TransactionInstruction({
    keys: [
      { pubkey: source, isSigner: true, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
    ],
    programId: SystemProgram.programId,
    data,
  });
}

function makeStakeWithdraw(lamports: number, dest = wallet): TransactionInstruction {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(4, 0); // Withdraw type
  data.writeBigUInt64LE(BigInt(lamports), 4);
  const stakeAccount = Keypair.generate().publicKey;
  return new TransactionInstruction({
    keys: [
      { pubkey: stakeAccount, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarStakeHistory1111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: wallet, isSigner: true, isWritable: false },
    ],
    programId: STAKE_PROGRAM_ID,
    data,
  });
}

function makeComputeUnitLimit(units: number): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units });
}

function makeComputeUnitPrice(microLamports: number): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
}

function makeAtaCreate(owner: PublicKey = wallet): TransactionInstruction {
  const ata = deriveAta(owner);
  return new TransactionInstruction({
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ATA_PROGRAM_ID,
    data: Buffer.from([1]), // CreateIdempotent
  });
}

function makePumpClaimCashback(): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: pumpAccumulator, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PUMP_PROGRAM_ID,
    data: PUMP_CLAIM_CASHBACK,
  });
}

function makePumpCollectCreatorFee(): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: pumpCreatorVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PUMP_PROGRAM_ID,
    data: PUMP_COLLECT_CREATOR_FEE,
  });
}

function makePumpSwapClaimCashback(): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: pumpSwapAccumulator, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: pumpSwapAccumulatorWsolAta, isSigner: false, isWritable: true },
      { pubkey: userWsolAta, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: pumpSwapEventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PUMP_AMM_PROGRAM_ID,
    data: PUMP_CLAIM_CASHBACK,
  });
}

function makePumpSwapCollectCoinCreatorFee(): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: pumpSwapCreatorVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: pumpSwapCreatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: userWsolAta, isSigner: false, isWritable: true },
      { pubkey: pumpSwapEventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PUMP_AMM_PROGRAM_ID,
    data: PUMPSWAP_COLLECT_COIN_CREATOR_FEE,
  });
}

function makeSplTokenCloseAccount(account?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: account ?? Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: false },
    ],
    programId: SPL_TOKEN_PROGRAM_ID,
    data: Buffer.from([9]), // CloseAccount discriminator
  });
}

function makeUnclaimedSolIx(): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: feeVault, isSigner: false, isWritable: true },
    ],
    programId: SDK_PROGRAM_ID,
    data: Buffer.from([0]),
  });
}

// ---------------------------------------------------------------------------
// Helper: wrap instructions into a Transaction
// ---------------------------------------------------------------------------
function buildTx(...ixs: TransactionInstruction[]): Transaction {
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  return tx;
}

// Default fee bps and backend total for rewards tests
const FEE_BPS = REWARDS_FEE_BPS;
const BACKEND_TOTAL = 10_000_000; // 10M lamports

// Helpers for a valid rewards tx and stake tx
function validRewardsTx(): Transaction {
  return buildTx(
    makeComputeUnitLimit(400_000),
    makeComputeUnitPrice(1_000),
    makePumpClaimCashback(),
    makeSystemTransfer(Math.floor(BACKEND_TOTAL * FEE_BPS / 10_000)),
  );
}

function validStakeTx(withdrawLamports = 5_000_000_000): Transaction {
  const feeLamports = Math.floor(withdrawLamports * STAKES_FEE_BPS / 10_000);
  return buildTx(
    makeComputeUnitLimit(400_000),
    makeComputeUnitPrice(1_000),
    makeStakeWithdraw(withdrawLamports),
    makeSystemTransfer(feeLamports),
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('validateTransactionPrograms', () => {
  // ---------- Happy path ----------

  describe('happy path', () => {
    it('accepts valid Pump claim_cashback transaction', () => {
      const tx = validRewardsTx();
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).not.toThrow();
    });

    it('accepts valid Pump collect_creator_fee transaction', () => {
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeComputeUnitPrice(1_000),
        makePumpCollectCreatorFee(),
        makeSystemTransfer(Math.floor(BACKEND_TOTAL * FEE_BPS / 10_000)),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).not.toThrow();
    });

    it('accepts valid PumpSwap claim_cashback transaction', () => {
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeComputeUnitPrice(1_000),
        makePumpSwapClaimCashback(),
        makeSystemTransfer(Math.floor(BACKEND_TOTAL * FEE_BPS / 10_000)),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).not.toThrow();
    });

    it('accepts valid PumpSwap collect_coin_creator_fee transaction', () => {
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeComputeUnitPrice(1_000),
        makePumpSwapCollectCoinCreatorFee(),
        makeSystemTransfer(Math.floor(BACKEND_TOTAL * FEE_BPS / 10_000)),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).not.toThrow();
    });

    it('accepts valid Stake Withdraw transaction', () => {
      const tx = validStakeTx();
      expect(() =>
        validateTransactionPrograms([tx], wallet, STAKES_FEE_BPS, 0),
      ).not.toThrow();
    });

    it('accepts ATA CreateIdempotent for wallet', () => {
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeComputeUnitPrice(1_000),
        makeAtaCreate(wallet),
        makePumpSwapClaimCashback(),
        makeSystemTransfer(Math.floor(BACKEND_TOTAL * FEE_BPS / 10_000)),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).not.toThrow();
    });

    it('accepts ATA CreateIdempotent for PumpSwap creator-vault PDA', () => {
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeComputeUnitPrice(1_000),
        makeAtaCreate(pumpSwapCreatorVaultAuthority),
        makePumpSwapCollectCoinCreatorFee(),
        makeSystemTransfer(Math.floor(BACKEND_TOTAL * FEE_BPS / 10_000)),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).not.toThrow();
    });

    it('accepts SPL Token CloseAccount', () => {
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeComputeUnitPrice(1_000),
        makePumpClaimCashback(),
        makeSplTokenCloseAccount(),
        makeSystemTransfer(Math.floor(BACKEND_TOTAL * FEE_BPS / 10_000)),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).not.toThrow();
    });
  });

  // ---------- Program allowlist ----------

  describe('program allowlist', () => {
    it('rejects unknown program', () => {
      const ix = new TransactionInstruction({
        keys: [{ pubkey: wallet, isSigner: false, isWritable: false }],
        programId: Keypair.generate().publicKey,
        data: Buffer.alloc(0),
      });
      const tx = buildTx(makePumpClaimCashback(), ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('unexpected program');
    });

    it('rejects Token-2022 program', () => {
      const token2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
      const ix = new TransactionInstruction({
        keys: [{ pubkey: wallet, isSigner: false, isWritable: false }],
        programId: token2022,
        data: Buffer.alloc(0),
      });
      const tx = buildTx(makePumpClaimCashback(), ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('unexpected program');
    });

    it('rejects BPF Loader Upgradeable', () => {
      const bpf = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
      const ix = new TransactionInstruction({
        keys: [{ pubkey: wallet, isSigner: false, isWritable: false }],
        programId: bpf,
        data: Buffer.alloc(0),
      });
      const tx = buildTx(makePumpClaimCashback(), ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('unexpected program');
    });
  });

  // ---------- System Transfer ----------

  describe('System Transfer validation', () => {
    it('rejects non-Transfer type', () => {
      const data = Buffer.alloc(12);
      data.writeUInt32LE(0, 0); // CreateAccount, not Transfer
      data.writeBigUInt64LE(BigInt(1000), 4);
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: feeVault, isSigner: false, isWritable: true },
        ],
        programId: SystemProgram.programId,
        data,
      });
      const tx = buildTx(makePumpClaimCashback(), ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('not Transfer');
    });

    it('rejects short data', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: feeVault, isSigner: false, isWritable: true },
        ],
        programId: SystemProgram.programId,
        data: Buffer.alloc(4), // too short
      });
      const tx = buildTx(makePumpClaimCashback(), ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('data too short');
    });

    it('rejects wrong account count', () => {
      const data = Buffer.alloc(12);
      data.writeUInt32LE(2, 0);
      data.writeBigUInt64LE(BigInt(1000), 4);
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: feeVault, isSigner: false, isWritable: true },
          { pubkey: randomKey, isSigner: false, isWritable: false },
        ],
        programId: SystemProgram.programId,
        data,
      });
      const tx = buildTx(makePumpClaimCashback(), ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('expected 2 accounts');
    });

    it('rejects wrong source', () => {
      const data = Buffer.alloc(12);
      data.writeUInt32LE(2, 0);
      data.writeBigUInt64LE(BigInt(1000), 4);
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: randomKey, isSigner: true, isWritable: true },
          { pubkey: feeVault, isSigner: false, isWritable: true },
        ],
        programId: SystemProgram.programId,
        data,
      });
      const tx = buildTx(makePumpClaimCashback(), ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('source mismatch');
    });

    it('rejects wrong destination', () => {
      const data = Buffer.alloc(12);
      data.writeUInt32LE(2, 0);
      data.writeBigUInt64LE(BigInt(1000), 4);
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: randomKey, isSigner: false, isWritable: true },
        ],
        programId: SystemProgram.programId,
        data,
      });
      const tx = buildTx(makePumpClaimCashback(), ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('destination mismatch');
    });
  });

  // ---------- Stake Withdraw ----------

  describe('Stake Withdraw validation', () => {
    it('rejects non-Withdraw type', () => {
      const data = Buffer.alloc(12);
      data.writeUInt32LE(1, 0); // Delegate, not Withdraw
      data.writeBigUInt64LE(BigInt(5_000_000_000), 4);
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: true },
          { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: new PublicKey('SysvarStakeHistory1111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: wallet, isSigner: true, isWritable: false },
        ],
        programId: STAKE_PROGRAM_ID,
        data,
      });
      const tx = buildTx(makeComputeUnitLimit(400_000), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, STAKES_FEE_BPS, 0),
      ).toThrow('not Withdraw');
    });

    it('rejects short data', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: true },
          { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: new PublicKey('SysvarStakeHistory1111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: wallet, isSigner: true, isWritable: false },
        ],
        programId: STAKE_PROGRAM_ID,
        data: Buffer.alloc(4),
      });
      const tx = buildTx(makeComputeUnitLimit(400_000), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, STAKES_FEE_BPS, 0),
      ).toThrow('data too short');
    });

    it('rejects wrong account count', () => {
      const data = Buffer.alloc(12);
      data.writeUInt32LE(4, 0);
      data.writeBigUInt64LE(BigInt(5_000_000_000), 4);
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: true, isWritable: false },
        ],
        programId: STAKE_PROGRAM_ID,
        data,
      });
      const tx = buildTx(makeComputeUnitLimit(400_000), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, STAKES_FEE_BPS, 0),
      ).toThrow('expected 5 accounts');
    });

    it('rejects wrong destination', () => {
      const data = Buffer.alloc(12);
      data.writeUInt32LE(4, 0);
      data.writeBigUInt64LE(BigInt(5_000_000_000), 4);
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
          { pubkey: randomKey, isSigner: false, isWritable: true }, // wrong dest
          { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: new PublicKey('SysvarStakeHistory1111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: wallet, isSigner: true, isWritable: false },
        ],
        programId: STAKE_PROGRAM_ID,
        data,
      });
      const tx = buildTx(makeComputeUnitLimit(400_000), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, STAKES_FEE_BPS, 0),
      ).toThrow('destination mismatch');
    });

  });

  // ---------- ATA CreateIdempotent ----------

  describe('ATA CreateIdempotent validation', () => {
    it('rejects wrong account count', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ], // 5 accounts, expected 6
        programId: ATA_PROGRAM_ID,
        data: Buffer.from([1]),
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('expected 6 accounts');
    });

    it('rejects wrong discriminator (not CreateIdempotent)', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: ATA_PROGRAM_ID,
        data: Buffer.from([0]), // Create, not CreateIdempotent
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('not CreateIdempotent');
    });

    it('rejects wrong funder', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: randomKey, isSigner: true, isWritable: true }, // wrong funder
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: ATA_PROGRAM_ID,
        data: Buffer.from([1]),
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('funder mismatch');
    });

    it('rejects wrong mint', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: false },
          { pubkey: randomKey, isSigner: false, isWritable: false }, // wrong mint
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: ATA_PROGRAM_ID,
        data: Buffer.from([1]),
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('mint mismatch');
    });

    it('rejects wrong System Program position', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: randomKey, isSigner: false, isWritable: false }, // wrong System Program
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: ATA_PROGRAM_ID,
        data: Buffer.from([1]),
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('System Program mismatch');
    });

    it('rejects wrong token program position', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: randomKey, isSigner: false, isWritable: false }, // wrong token program
        ],
        programId: ATA_PROGRAM_ID,
        data: Buffer.from([1]),
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('token program mismatch');
    });

    it('rejects unauthorized owner', () => {
      const badOwner = Keypair.generate().publicKey;
      const badAta = deriveAta(badOwner);
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: badAta, isSigner: false, isWritable: true },
          { pubkey: badOwner, isSigner: false, isWritable: false }, // not wallet or creator-vault PDA
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: ATA_PROGRAM_ID,
        data: Buffer.from([1]),
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('ATA owner');
    });

    it('rejects bad ATA derivation (wrong address for owner)', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: randomKey, isSigner: false, isWritable: true }, // wrong ATA address
          { pubkey: wallet, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: ATA_PROGRAM_ID,
        data: Buffer.from([1]),
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('ATA address mismatch');
    });
  });

  // ---------- ComputeBudget ----------

  describe('ComputeBudget validation', () => {
    it('rejects CU limit above 1.4M', () => {
      const tx = buildTx(
        makeComputeUnitLimit(1_400_001),
        makePumpClaimCashback(),
        makeSystemTransfer(0),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('CU limit');
    });

    it('accepts CU limit exactly at 1.4M', () => {
      const tx = buildTx(
        makeComputeUnitLimit(1_400_000),
        makeComputeUnitPrice(1_000),
        makePumpClaimCashback(),
        makeSystemTransfer(Math.floor(BACKEND_TOTAL * FEE_BPS / 10_000)),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).not.toThrow();
    });

    it('rejects priority fee above 200k', () => {
      const tx = buildTx(
        makeComputeUnitPrice(200_001),
        makePumpClaimCashback(),
        makeSystemTransfer(0),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('CU price');
    });

    it('accepts priority fee exactly at 200k', () => {
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeComputeUnitPrice(200_000),
        makePumpClaimCashback(),
        makeSystemTransfer(Math.floor(BACKEND_TOTAL * FEE_BPS / 10_000)),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).not.toThrow();
    });
  });

  // ---------- Pump instructions ----------

  describe('Pump instruction validation', () => {
    it('rejects unrecognized discriminator', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: pumpAccumulator, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_PROGRAM_ID,
        data: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), // unknown disc
      });
      const tx = buildTx(ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('unrecognized discriminator');
    });

    it('rejects short instruction data', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: pumpAccumulator, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_PROGRAM_ID,
        data: Buffer.from([37, 58, 35]), // too short
      });
      const tx = buildTx(ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('data too short');
    });

    it('claim_cashback: rejects wrong account count', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: pumpAccumulator, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
        ], // 4, expected 5
        programId: PUMP_PROGRAM_ID,
        data: PUMP_CLAIM_CASHBACK,
      });
      const tx = buildTx(ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('expected 5 accounts');
    });

    it('claim_cashback: rejects wrong user position', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: randomKey, isSigner: true, isWritable: true }, // wrong user
          { pubkey: pumpAccumulator, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_PROGRAM_ID,
        data: PUMP_CLAIM_CASHBACK,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('user mismatch');
    });

    it('claim_cashback: rejects wrong accumulator', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: randomKey, isSigner: false, isWritable: true }, // wrong accumulator
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_PROGRAM_ID,
        data: PUMP_CLAIM_CASHBACK,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('accumulator mismatch');
    });

    it('collect_creator_fee: rejects wrong creatorVault', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: randomKey, isSigner: false, isWritable: true }, // wrong vault
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_PROGRAM_ID,
        data: PUMP_COLLECT_CREATOR_FEE,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('creatorVault mismatch');
    });

    it('claim_cashback: rejects wrong eventAuthority', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: pumpAccumulator, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: randomKey, isSigner: false, isWritable: false }, // wrong eventAuth
          { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_PROGRAM_ID,
        data: PUMP_CLAIM_CASHBACK,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('eventAuthority mismatch');
    });

    it('claim_cashback: rejects wrong program self-ref', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: pumpAccumulator, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
          { pubkey: randomKey, isSigner: false, isWritable: false }, // wrong self-ref
        ],
        programId: PUMP_PROGRAM_ID,
        data: PUMP_CLAIM_CASHBACK,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('program self-ref mismatch');
    });
  });

  // ---------- PumpSwap instructions ----------

  describe('PumpSwap instruction validation', () => {
    it('rejects unrecognized discriminator', () => {
      const ix = new TransactionInstruction({
        keys: Array(9).fill({ pubkey: wallet, isSigner: false, isWritable: false }),
        programId: PUMP_AMM_PROGRAM_ID,
        data: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
      });
      const tx = buildTx(ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('unrecognized discriminator');
    });

    it('claim_cashback: rejects wrong account count', () => {
      const ix = new TransactionInstruction({
        keys: Array(8).fill({ pubkey: wallet, isSigner: false, isWritable: false }),
        programId: PUMP_AMM_PROGRAM_ID,
        data: PUMP_CLAIM_CASHBACK,
      });
      const tx = buildTx(ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('expected 9 accounts');
    });

    it('claim_cashback: rejects wrong user position', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: randomKey, isSigner: true, isWritable: true }, // wrong user
          { pubkey: pumpSwapAccumulator, isSigner: false, isWritable: true },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: pumpSwapAccumulatorWsolAta, isSigner: false, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: pumpSwapEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_AMM_PROGRAM_ID,
        data: PUMP_CLAIM_CASHBACK,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('user mismatch');
    });

    it('claim_cashback: rejects wrong accumulator', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: randomKey, isSigner: false, isWritable: true }, // wrong
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: pumpSwapAccumulatorWsolAta, isSigner: false, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: pumpSwapEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_AMM_PROGRAM_ID,
        data: PUMP_CLAIM_CASHBACK,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('accumulator mismatch');
    });

    it('collect_coin_creator_fee: rejects wrong account count', () => {
      const ix = new TransactionInstruction({
        keys: Array(7).fill({ pubkey: wallet, isSigner: false, isWritable: false }),
        programId: PUMP_AMM_PROGRAM_ID,
        data: PUMPSWAP_COLLECT_COIN_CREATOR_FEE,
      });
      const tx = buildTx(ix);
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('expected 8 accounts');
    });

    it('collect_coin_creator_fee: rejects wrong user position', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: randomKey, isSigner: true, isWritable: true }, // wrong user
          { pubkey: pumpSwapCreatorVaultAuthority, isSigner: false, isWritable: false },
          { pubkey: pumpSwapCreatorVaultAta, isSigner: false, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: pumpSwapEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_AMM_PROGRAM_ID,
        data: PUMPSWAP_COLLECT_COIN_CREATOR_FEE,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('user mismatch');
    });

    it('collect_coin_creator_fee: rejects wrong vaultAuthority', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: randomKey, isSigner: false, isWritable: false }, // wrong
          { pubkey: pumpSwapCreatorVaultAta, isSigner: false, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: pumpSwapEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_AMM_PROGRAM_ID,
        data: PUMPSWAP_COLLECT_COIN_CREATOR_FEE,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('vaultAuthority mismatch');
    });

    it('collect_coin_creator_fee: rejects wrong vaultAta', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: pumpSwapCreatorVaultAuthority, isSigner: false, isWritable: false },
          { pubkey: randomKey, isSigner: false, isWritable: true }, // wrong
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: pumpSwapEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_AMM_PROGRAM_ID,
        data: PUMPSWAP_COLLECT_COIN_CREATOR_FEE,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('vaultAta mismatch');
    });

    it('collect_coin_creator_fee: rejects wrong userAta', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: pumpSwapCreatorVaultAuthority, isSigner: false, isWritable: false },
          { pubkey: pumpSwapCreatorVaultAta, isSigner: false, isWritable: true },
          { pubkey: randomKey, isSigner: false, isWritable: true }, // wrong
          { pubkey: pumpSwapEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: PUMP_AMM_PROGRAM_ID,
        data: PUMPSWAP_COLLECT_COIN_CREATOR_FEE,
      });
      const tx = buildTx(ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('userAta mismatch');
    });
  });

  // ---------- SPL Token CloseAccount ----------

  describe('SPL Token CloseAccount validation', () => {
    it('rejects wrong discriminator', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: true, isWritable: false },
        ],
        programId: SPL_TOKEN_PROGRAM_ID,
        data: Buffer.from([3]), // Transfer, not CloseAccount
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('not CloseAccount');
    });

    it('rejects wrong account count', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: true },
        ], // 2, expected 3
        programId: SPL_TOKEN_PROGRAM_ID,
        data: Buffer.from([9]),
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('expected 3 accounts');
    });

    it('rejects wrong destination', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
          { pubkey: randomKey, isSigner: false, isWritable: true }, // wrong dest
          { pubkey: wallet, isSigner: true, isWritable: false },
        ],
        programId: SPL_TOKEN_PROGRAM_ID,
        data: Buffer.from([9]),
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('destination mismatch');
    });

    it('rejects wrong authority', () => {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
          { pubkey: wallet, isSigner: false, isWritable: true },
          { pubkey: randomKey, isSigner: true, isWritable: false }, // wrong auth
        ],
        programId: SPL_TOKEN_PROGRAM_ID,
        data: Buffer.from([9]),
      });
      const tx = buildTx(makePumpClaimCashback(), ix, makeSystemTransfer(0));
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('authority mismatch');
    });
  });

  // ---------- UnclaimedSOL program is disallowed in backend txs ----------

  describe('UnclaimedSOL program rejection', () => {
    it('rejects UnclaimedSOL program even with fee vault present', () => {
      // A compromised backend could piggyback an extra burn/close via the
      // UnclaimedSOL program.  The validator must reject it at the allowlist
      // level — the program should never appear in backend-built txs.
      const tx = buildTx(
        makePumpClaimCashback(),
        makeUnclaimedSolIx(),
        makeSystemTransfer(Math.floor(BACKEND_TOTAL * FEE_BPS / 10_000)),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('unexpected program');
    });
  });

  // ---------- Per-tx claim requirement ----------

  describe('per-tx claim requirement', () => {
    it('rejects transaction with no claim instruction', () => {
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeSystemTransfer(1000),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, FEE_BPS, BACKEND_TOTAL),
      ).toThrow('contains no claim instruction');
    });
  });

  // ---------- Per-tx fee cap (stakes) ----------

  describe('per-tx fee cap (stakes)', () => {
    it('allows fee exactly at cap', () => {
      const withdraw = 10_000_000_000;
      const maxFee = Math.floor(withdraw * STAKES_FEE_BPS / 10_000);
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeStakeWithdraw(withdraw),
        makeSystemTransfer(maxFee),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, STAKES_FEE_BPS, 0),
      ).not.toThrow();
    });

    it('rejects fee above cap', () => {
      const withdraw = 10_000_000_000;
      const maxFee = Math.floor(withdraw * STAKES_FEE_BPS / 10_000);
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeStakeWithdraw(withdraw),
        makeSystemTransfer(maxFee + 1),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, STAKES_FEE_BPS, 0),
      ).toThrow('fee');
    });

    it('allows zero fee', () => {
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeStakeWithdraw(5_000_000_000),
        makeSystemTransfer(0),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, STAKES_FEE_BPS, 0),
      ).not.toThrow();
    });

    it('sums multiple System Transfers against fee cap', () => {
      const withdraw = 10_000_000_000;
      const maxFee = Math.floor(withdraw * STAKES_FEE_BPS / 10_000);
      // Two transfers that individually are under cap but sum exceeds it
      const half = Math.floor(maxFee / 2);
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeStakeWithdraw(withdraw),
        makeSystemTransfer(half),
        makeSystemTransfer(half + 2), // sum = maxFee + 1
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, STAKES_FEE_BPS, 0),
      ).toThrow('fee');
    });

    it('sums multiple Stake Withdrawals for fee cap', () => {
      const w1 = 5_000_000_000;
      const w2 = 5_000_000_000;
      const totalWithdraw = w1 + w2;
      const maxFee = Math.floor(totalWithdraw * STAKES_FEE_BPS / 10_000);
      const tx = buildTx(
        makeComputeUnitLimit(400_000),
        makeStakeWithdraw(w1),
        makeStakeWithdraw(w2),
        makeSystemTransfer(maxFee),
      );
      expect(() =>
        validateTransactionPrograms([tx], wallet, STAKES_FEE_BPS, 0),
      ).not.toThrow();
    });
  });

  // ---------- Per-tx fee cap (rewards) ----------

  describe('per-tx fee cap (rewards)', () => {
    it('divides backend total evenly across transactions', () => {
      const total = 20_000_000;
      // 2 txs, so each gets total/2 = 10M, max fee = 10M * 1500 / 10000 = 1.5M
      const maxFeePerTx = Math.floor((total / 2) * FEE_BPS / 10_000);
      const tx1 = buildTx(
        makePumpClaimCashback(),
        makeSystemTransfer(maxFeePerTx),
      );
      const tx2 = buildTx(
        makePumpSwapClaimCashback(),
        makeSystemTransfer(maxFeePerTx),
      );
      expect(() =>
        validateTransactionPrograms([tx1, tx2], wallet, FEE_BPS, total),
      ).not.toThrow();
    });

    it('rejects when per-tx fee exceeds share', () => {
      const total = 20_000_000;
      const maxFeePerTx = Math.floor((total / 2) * FEE_BPS / 10_000);
      const tx1 = buildTx(
        makePumpClaimCashback(),
        makeSystemTransfer(maxFeePerTx + 1),
      );
      const tx2 = buildTx(
        makePumpSwapClaimCashback(),
        makeSystemTransfer(0),
      );
      expect(() =>
        validateTransactionPrograms([tx1, tx2], wallet, FEE_BPS, total),
      ).toThrow('fee');
    });
  });

  // ---------- Multi-tx: validated independently ----------

  describe('multi-tx independence', () => {
    it('error message includes tx number', () => {
      const tx1 = validRewardsTx();
      // tx2 has an unknown program
      const badIx = new TransactionInstruction({
        keys: [{ pubkey: wallet, isSigner: false, isWritable: false }],
        programId: Keypair.generate().publicKey,
        data: Buffer.alloc(0),
      });
      const tx2 = buildTx(makePumpClaimCashback(), badIx);
      expect(() =>
        validateTransactionPrograms([tx1, tx2], wallet, FEE_BPS, BACKEND_TOTAL * 2),
      ).toThrow('Tx 2');
    });

    it('first valid tx does not save second invalid tx', () => {
      const tx1 = validRewardsTx();
      const tx2 = buildTx(makeComputeUnitLimit(400_000), makeSystemTransfer(0)); // no claim
      expect(() =>
        validateTransactionPrograms([tx1, tx2], wallet, FEE_BPS, BACKEND_TOTAL * 2),
      ).toThrow('Tx 2');
    });
  });
});

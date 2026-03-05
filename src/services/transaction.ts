import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
} from '@solana/web3.js';
import {
  buildBurnAndCloseInstruction,
  PROGRAM_ID as SDK_PROGRAM_ID,
} from '@unclaimedsol/spl-burn-close-sdk';
import type { Pair } from '@unclaimedsol/spl-burn-close-sdk';
import {
  PROGRAM_ID,
  FEE_VAULT,
  EXPECTED_PROGRAM_IDS,
  BPF_LOADER_UPGRADEABLE,
  TOKEN_PAIRS_PER_IX,
  BUFFERS_PER_IX,
  PRIORITY_FEE_MAX,
} from '../constants.js';
import { TokenAccountInfo, BufferAccountInfo } from './scanner.js';
import { Config } from '../config.js';

interface InstructionMeta {
  ix: TransactionInstruction;
  tokenCount: number;
  bufferCount: number;
  lamports: number;
}

export interface ClaimPlan {
  tokenAccountCount: number;
  bufferAccountCount: number;
  totalTokenAccountCount: number;
  totalBufferAccountCount: number;
  estimatedSol: number; // Net amount — 5% fee is already included
  transactionsNeeded: number;
  totalTransactionsNeeded: number;
  transactions: Transaction[];
  cappedByMaxTx: boolean;
  skippedFrozenCount: number;
  stakeInfo: { count: number; estimatedSol: number } | null;
}

export class TransactionBuilder {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async buildClaimPlan(
    tokens: TokenAccountInfo[],
    buffers: BufferAccountInfo[],
    walletPubkey: PublicKey,
    maxTransactions: number,
    stakeInfo?: { count: number; estimatedSol: number } | null,
  ): Promise<ClaimPlan> {
    // ---- FILTER TOKENS ----
    // Skip frozen accounts (can't close them)
    const skippedFrozen = tokens.filter((t) => t.isFrozen);
    const activeTokens = tokens.filter((t) => !t.isFrozen);

    // ---- GROUP TOKENS BY TOKEN PROGRAM ----
    // buildBurnAndCloseInstruction needs the tokenProgramId, and you can't
    // mix SPL Token and Token-2022 accounts in the same instruction.
    const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

    const tokensByProgram = new Map<string, TokenAccountInfo[]>();
    for (const token of activeTokens) {
      const pid = token.programOwnerId || SPL_TOKEN_PROGRAM;
      if (!tokensByProgram.has(pid)) tokensByProgram.set(pid, []);
      tokensByProgram.get(pid)!.push(token);
    }

    // ---- BUILD TOKEN INSTRUCTIONS (with metadata) ----
    const allIxMeta: InstructionMeta[] = [];

    for (const [programId, programTokens] of tokensByProgram) {
      const chunks = chunkArray(programTokens, TOKEN_PAIRS_PER_IX);

      for (const chunk of chunks) {
        const pairs: Pair[] = chunk.map((t) => ({
          mint: new PublicKey(t.mintKey),
          ata: new PublicKey(t.pubKey),
        }));

        const ix = await buildBurnAndCloseInstruction(
          SDK_PROGRAM_ID,
          walletPubkey,
          pairs,
          new PublicKey(programId),
        );

        if (ix) {
          allIxMeta.push({
            ix,
            tokenCount: chunk.length,
            bufferCount: 0,
            lamports: chunk.reduce((s, t) => s + t.lamports, 0),
          });
        }
      }
    }

    // ---- BUILD BUFFER INSTRUCTIONS (with metadata) ----
    if (buffers.length > 0) {
      const feeRecipient = new PublicKey(FEE_VAULT);
      const bufferChunks = chunkArray(buffers, BUFFERS_PER_IX);

      for (const chunk of bufferChunks) {
        const ix = buildBufferCloseInstruction(
          SDK_PROGRAM_ID,
          walletPubkey,
          feeRecipient,
          chunk.map((b) => b.pubkey),
        );
        allIxMeta.push({
          ix,
          tokenCount: 0,
          bufferCount: chunk.length,
          lamports: chunk.reduce((s, b) => s + b.lamports, 0),
        });
      }
    }

    if (allIxMeta.length === 0) {
      throw new Error('No token or buffer accounts to claim.');
    }

    // ---- BUILD TRANSACTIONS ----
    // Each instruction already handles a batch of pairs/buffers.
    // 1 instruction per tx is safest to start — tune up after testing.
    const INSTRUCTIONS_PER_TX = 1;

    const ixGroups = chunkArray(allIxMeta, INSTRUCTIONS_PER_TX);
    const cappedByMaxTx = ixGroups.length > maxTransactions;
    const usedGroups = ixGroups.slice(0, maxTransactions);

    const transactions: Transaction[] = [];
    for (const group of usedGroups) {
      const tx = new Transaction();

      // Compute budget — estimate CU based on pairs in this group
      const estimatedPairs = group.reduce((sum, meta) => {
        const overhead = 4; // signer, program, token program, etc.
        return sum + Math.max(1, Math.floor((meta.ix.keys.length - overhead) / 2));
      }, 0);

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: Math.min(1_400_000, estimatedPairs * 50_000),
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.config.priorityFee,
        }),
      );

      for (const meta of group) {
        tx.add(meta.ix);
      }

      transactions.push(tx);
    }

    // ---- ESTIMATE SOL (only for accounts covered by used transactions) ----
    // API returns amounts with the 5% fee already included, so no deduction needed.
    const usedMeta = usedGroups.flat();
    const coveredTokenCount = usedMeta.reduce((s, m) => s + m.tokenCount, 0);
    const coveredBufferCount = usedMeta.reduce((s, m) => s + m.bufferCount, 0);
    const coveredLamports = usedMeta.reduce((s, m) => s + m.lamports, 0);
    const estimatedSol = coveredLamports / 1e9;

    return {
      tokenAccountCount: coveredTokenCount,
      bufferAccountCount: coveredBufferCount,
      totalTokenAccountCount: activeTokens.length,
      totalBufferAccountCount: buffers.length,
      estimatedSol,
      transactionsNeeded: usedGroups.length,
      totalTransactionsNeeded: ixGroups.length,
      transactions,
      cappedByMaxTx,
      skippedFrozenCount: skippedFrozen.length,
      stakeInfo: stakeInfo || null,
    };
  }

  /**
   * Pre-sign validation — every transaction, every instruction.
   * Aborts entirely if any check fails.
   */
  validateTransactions(
    transactions: Transaction[],
    walletPubkey: PublicKey,
  ): void {
    const allowedPrograms = new Set(EXPECTED_PROGRAM_IDS);
    const feeVaultKey = new PublicKey(FEE_VAULT);

    for (let i = 0; i < transactions.length; i++) {
      for (const ix of transactions[i].instructions) {
        const pid = ix.programId.toBase58();

        // Check 1: Program ID in allowlist
        if (!allowedPrograms.has(pid)) {
          throw new TransactionValidationError(
            `Tx ${i + 1}: unexpected program ${pid}`,
          );
        }

        // Check 2: System Program instructions only touch wallet or fee vault
        if (pid === SYSTEM_PROGRAM) {
          for (const key of ix.keys) {
            if (
              key.isWritable &&
              !key.pubkey.equals(walletPubkey) &&
              !key.pubkey.equals(feeVaultKey)
            ) {
              throw new TransactionValidationError(
                `Tx ${i + 1}: system program writing to unknown account ${key.pubkey.toBase58()}`,
              );
            }
          }
        }

        // Check 3: Fee vault appears in UnclaimedSOL program instructions
        if (pid === SDK_PROGRAM_ID.toBase58()) {
          const hasFeeVault = ix.keys.some((k) =>
            k.pubkey.equals(feeVaultKey),
          );
          if (!hasFeeVault) {
            throw new TransactionValidationError(
              `Tx ${i + 1}: UnclaimedSOL program instruction missing fee vault`,
            );
          }
        }
      }
    }
  }
}

/**
 * Build buffer close instruction — matches the existing function exactly.
 * Instruction discriminator = 1.
 */
function buildBufferCloseInstruction(
  programId: PublicKey,
  authority: PublicKey,
  feeRecipient: PublicKey,
  bufferAddresses: string[],
): TransactionInstruction {
  const BPF_LOADER = new PublicKey(BPF_LOADER_UPGRADEABLE);

  const keys = [
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: feeRecipient, isSigner: false, isWritable: true },
    { pubkey: BPF_LOADER, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...bufferAddresses.map((addr) => ({
      pubkey: new PublicKey(addr),
      isSigner: false,
      isWritable: true,
    })),
  ];

  return new TransactionInstruction({
    keys,
    programId,
    data: Buffer.from([1]), // instruction discriminator = 1
  });
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/**
 * Restricted program allowlist for backend-built transactions.
 *
 * Deliberately excludes Token-2022 and BPF Loader — those are only needed
 * for the local burn-and-close claim path.
 *
 * Programs that could be abused (Pump, PumpSwap, SPL Token) ARE allowed
 * but are validated down to exact instruction discriminators and account
 * shapes — see the per-program checks in validateTransactionPrograms.
 */
const BACKEND_TX_ALLOWED_PROGRAMS = new Set([
  // UnclaimedSOL (spl-burn-close) is intentionally excluded — it is only
  // used by the local claim_sol flow.  Backend-built reward/stake txs
  // must never contain it; allowing it here would let a compromised
  // /build-tx response piggyback an arbitrary burn/close instruction.
  '11111111111111111111111111111111', // System Program
  'ComputeBudget111111111111111111111111111111', // Compute Budget
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
  'Stake11111111111111111111111111111111111111', // Stake Program
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump program
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token (CloseAccount only)
]);

// Pump/PumpSwap instruction discriminators the backend is allowed to emit.
// Anything else (buy, sell, swap, etc.) will be rejected.
export const PUMP_CLAIM_CASHBACK = Buffer.from([37, 58, 35, 126, 190, 53, 228, 197]);
export const PUMP_COLLECT_CREATOR_FEE = Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]);
export const PUMPSWAP_COLLECT_COIN_CREATOR_FEE = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]);

// Well-known addresses used by validation.
export const NATIVE_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112',
);
export const ATA_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
export const PUMP_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
);
export const PUMP_AMM_PROGRAM_ID = new PublicKey(
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
);
export const STAKE_PROGRAM_ID = new PublicKey(
  'Stake11111111111111111111111111111111111111',
);

// String forms for fast comparison in the hot loop.
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const STAKE_PROGRAM = STAKE_PROGRAM_ID.toBase58();
const ATA_PROGRAM = ATA_PROGRAM_ID.toBase58();
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const PUMP_PROGRAM = PUMP_PROGRAM_ID.toBase58();
const PUMPSWAP_PROGRAM = PUMP_AMM_PROGRAM_ID.toBase58();
const SPL_TOKEN = SPL_TOKEN_PROGRAM_ID.toBase58();

/**
 * Validate backend-built transactions before signing.
 *
 * All validation is **per-transaction**: each transaction must independently
 * contain at least one claim instruction, and its fee transfer must not
 * exceed feeBps applied to that transaction's proven claim value.
 *
 * ## Trust model
 *
 * **Stakes (claim_stakes):** Full value-level safety. Withdraw amounts are
 * proven from instruction data — the fee cap is locally derived and does
 * not depend on any backend-reported value.
 *
 * **Rewards (claim_rewards):** Structural safety only. Pump/PumpSwap claim
 * amounts are determined on-chain at execution time and are not encoded in
 * instruction data, so the fee cap relies on `backendReportedTotalLamports`
 * (cross-checked against an independent /scan call by the caller). This
 * protects against accidental drift between /build-tx and /scan, but not
 * against a fully compromised backend that lies consistently on both
 * endpoints.
 *
 * In both cases, instruction shapes are validated exactly: every account
 * position is pinned to a locally-derived PDA or well-known address, account
 * counts are exact (not minimum), and only known discriminators are accepted.
 *
 * @param feeBps  Fee rate cap in basis points (e.g. 1500 = 15%).
 * @param backendReportedTotalLamports  Fallback for rewards fee cap (claim
 *   amounts are on-chain, not in instruction data). For stakes the fee cap
 *   is derived from proven withdraw amounts in instruction data.
 */
export function validateTransactionPrograms(
  transactions: Transaction[],
  walletPubkey: PublicKey,
  feeBps: number,
  backendReportedTotalLamports: number,
): void {
  const feeVaultKey = new PublicKey(FEE_VAULT);
  const MAX_COMPUTE_UNITS = 1_400_000;

  // Pre-derive all wallet-dependent PDAs once.
  const pdas = deriveExpectedPdas(walletPubkey);

  for (let i = 0; i < transactions.length; i++) {
    const label = `Tx ${i + 1}`;

    // Per-transaction accumulators.
    let txFeeLamports = 0;
    let txStakeWithdrawLamports = 0;
    let txHasClaim = false;

    for (const ix of transactions[i].instructions) {
      const pid = ix.programId.toBase58();

      if (!BACKEND_TX_ALLOWED_PROGRAMS.has(pid)) {
        throw new TransactionValidationError(
          `${label}: unexpected program ${pid}`,
        );
      }

      // ---- System Program ----
      if (pid === SYSTEM_PROGRAM) {
        validateSystemTransfer(ix, walletPubkey, feeVaultKey, label);
        txFeeLamports += Number(ix.data.readBigUInt64LE(4));
      }

      // ---- Stake Program (Withdraw only) ----
      if (pid === STAKE_PROGRAM) {
        txStakeWithdrawLamports += validateStakeWithdraw(
          ix,
          walletPubkey,
          label,
        );
        txHasClaim = true;
      }

      // ---- Associated Token Program ----
      if (pid === ATA_PROGRAM) {
        validateAtaCreate(ix, walletPubkey, pdas, label);
      }

      // ---- ComputeBudget ----
      if (pid === COMPUTE_BUDGET) {
        validateComputeBudget(ix, MAX_COMPUTE_UNITS, label);
      }

      // ---- Pump ----
      if (pid === PUMP_PROGRAM) {
        validatePumpIx(ix, walletPubkey, pdas, label);
        txHasClaim = true;
      }

      // ---- PumpSwap ----
      if (pid === PUMPSWAP_PROGRAM) {
        validatePumpSwapIx(ix, walletPubkey, pdas, label);
        txHasClaim = true;
      }

      // ---- SPL Token ----
      if (pid === SPL_TOKEN) {
        validateSplTokenCloseAccount(ix, walletPubkey, label);
      }
    }

    // ---- Per-transaction: must have at least one claim instruction ----
    if (!txHasClaim) {
      throw new TransactionValidationError(
        `${label}: contains no claim instruction (Pump, PumpSwap, or Stake)`,
      );
    }

    // ---- Per-transaction fee cap ----
    // Stakes: fee cap from proven withdraw amounts in instruction data.
    // Rewards: Pump/PumpSwap amounts are on-chain; fall back to backend
    // total divided evenly across transactions (best available bound).
    const claimTotal = txStakeWithdrawLamports > 0
      ? txStakeWithdrawLamports
      : backendReportedTotalLamports / transactions.length;
    const maxFee = Math.floor(claimTotal * feeBps / 10_000);

    if (txFeeLamports > maxFee) {
      throw new TransactionValidationError(
        `${label}: fee ${txFeeLamports} lamports exceeds max ${maxFee}`,
      );
    }
  }
}

// ============================================================================
// Per-instruction validators
// ============================================================================

/** Pre-derived PDAs for the wallet, computed once per validation call. */
interface WalletPdas {
  pumpAccumulator: PublicKey;
  pumpCreatorVault: PublicKey;
  pumpEventAuthority: PublicKey;
  pumpSwapAccumulator: PublicKey;
  pumpSwapCreatorVaultAuthority: PublicKey;
  pumpSwapEventAuthority: PublicKey;
  userWsolAta: PublicKey;
  pumpSwapAccumulatorWsolAta: PublicKey;
  pumpSwapCreatorVaultAta: PublicKey;
  allowedAtaOwners: Set<string>;
}

function deriveExpectedPdas(wallet: PublicKey): WalletPdas {
  const pumpAccumulator = derivePda(
    ['user_volume_accumulator', wallet],
    PUMP_PROGRAM_ID,
  );
  const pumpCreatorVault = derivePda(
    ['creator-vault', wallet],
    PUMP_PROGRAM_ID,
  );
  const pumpEventAuthority = derivePda(
    ['__event_authority'],
    PUMP_PROGRAM_ID,
  );

  const pumpSwapAccumulator = derivePda(
    ['user_volume_accumulator', wallet],
    PUMP_AMM_PROGRAM_ID,
  );
  const pumpSwapCreatorVaultAuthority = derivePda(
    ['creator_vault', wallet],
    PUMP_AMM_PROGRAM_ID,
  );
  const pumpSwapEventAuthority = derivePda(
    ['__event_authority'],
    PUMP_AMM_PROGRAM_ID,
  );

  const userWsolAta = deriveAta(wallet);
  const pumpSwapAccumulatorWsolAta = deriveAta(pumpSwapAccumulator);
  const pumpSwapCreatorVaultAta = deriveAta(pumpSwapCreatorVaultAuthority);

  return {
    pumpAccumulator,
    pumpCreatorVault,
    pumpEventAuthority,
    pumpSwapAccumulator,
    pumpSwapCreatorVaultAuthority,
    pumpSwapEventAuthority,
    userWsolAta,
    pumpSwapAccumulatorWsolAta,
    pumpSwapCreatorVaultAta,
    allowedAtaOwners: new Set([
      wallet.toBase58(),
      pumpSwapCreatorVaultAuthority.toBase58(),
    ]),
  };
}

export function derivePda(
  seeds: (string | PublicKey)[],
  programId: PublicKey,
): PublicKey {
  const buffers = seeds.map((s) =>
    typeof s === 'string' ? Buffer.from(s) : s.toBuffer(),
  );
  const [pda] = PublicKey.findProgramAddressSync(buffers, programId);
  return pda;
}

export function deriveAta(owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

function requireKey(
  ix: TransactionInstruction,
  index: number,
  expected: PublicKey,
  desc: string,
  label: string,
): void {
  if (ix.keys.length <= index || !ix.keys[index].pubkey.equals(expected)) {
    throw new TransactionValidationError(
      `${label}: ${desc} mismatch at keys[${index}]`,
    );
  }
}

function validateSystemTransfer(
  ix: TransactionInstruction,
  wallet: PublicKey,
  feeVault: PublicKey,
  label: string,
): void {
  if (ix.data.length < 12) {
    throw new TransactionValidationError(
      `${label}: system instruction data too short`,
    );
  }
  if (ix.data.readUInt32LE(0) !== 2) {
    throw new TransactionValidationError(
      `${label}: system instruction is not Transfer (type=${ix.data.readUInt32LE(0)})`,
    );
  }
  if (ix.keys.length !== 2) {
    throw new TransactionValidationError(
      `${label}: system Transfer expected 2 accounts, got ${ix.keys.length}`,
    );
  }
  requireKey(ix, 0, wallet, 'system Transfer source', label);
  requireKey(ix, 1, feeVault, 'system Transfer destination', label);
}

/** Validate Stake instruction is Withdraw (type 4). Returns withdraw lamports. */
function validateStakeWithdraw(
  ix: TransactionInstruction,
  wallet: PublicKey,
  label: string,
): number {
  // Stake Withdraw layout: [u32LE type=4][u64LE lamports]
  // Keys: [stake, to, clock, stakeHistory, withdrawAuthority]
  if (ix.data.length < 12) {
    throw new TransactionValidationError(
      `${label}: stake instruction data too short`,
    );
  }
  const ixType = ix.data.readUInt32LE(0);
  if (ixType !== 4) {
    throw new TransactionValidationError(
      `${label}: stake instruction is not Withdraw (type=${ixType})`,
    );
  }
  if (ix.keys.length !== 5) {
    throw new TransactionValidationError(
      `${label}: stake Withdraw expected 5 accounts, got ${ix.keys.length}`,
    );
  }
  requireKey(ix, 1, wallet, 'stake Withdraw destination', label);
  return Number(ix.data.readBigUInt64LE(4));
}

function validateAtaCreate(
  ix: TransactionInstruction,
  wallet: PublicKey,
  pdas: WalletPdas,
  label: string,
): void {
  if (ix.keys.length !== 6) {
    throw new TransactionValidationError(
      `${label}: ATA instruction expected 6 accounts, got ${ix.keys.length}`,
    );
  }
  if (ix.data.length < 1 || ix.data[0] !== 1) {
    throw new TransactionValidationError(
      `${label}: ATA instruction is not CreateIdempotent`,
    );
  }
  requireKey(ix, 0, wallet, 'ATA funder', label);
  requireKey(ix, 3, NATIVE_MINT, 'ATA mint', label);
  requireKey(ix, 4, SystemProgram.programId, 'ATA System Program', label);
  requireKey(ix, 5, SPL_TOKEN_PROGRAM_ID, 'ATA token program', label);

  const owner = ix.keys[2].pubkey;
  if (!pdas.allowedAtaOwners.has(owner.toBase58())) {
    throw new TransactionValidationError(
      `${label}: ATA owner is not wallet or PumpSwap creator-vault PDA`,
    );
  }
  requireKey(ix, 1, deriveAta(owner), 'ATA address', label);
}

function validateComputeBudget(
  ix: TransactionInstruction,
  maxCU: number,
  label: string,
): void {
  if (ix.data.length === 0) return;
  const disc = ix.data[0];

  if (disc === 2 && ix.data.length >= 5) {
    const units = ix.data.readUInt32LE(1);
    if (units > maxCU) {
      throw new TransactionValidationError(
        `${label}: CU limit ${units} exceeds max ${maxCU}`,
      );
    }
  }
  if (disc === 3 && ix.data.length >= 9) {
    const microLamports = Number(ix.data.readBigUInt64LE(1));
    if (microLamports > PRIORITY_FEE_MAX) {
      throw new TransactionValidationError(
        `${label}: CU price ${microLamports} exceeds max ${PRIORITY_FEE_MAX}`,
      );
    }
  }
}

/**
 * Validate Pump instruction: discriminator + full account layout.
 *
 * claim_cashback (5 keys):
 *   [0] user  [1] accumulator  [2] System  [3] eventAuthority  [4] PUMP_PROGRAM
 *
 * collect_creator_fee (5 keys):
 *   [0] user  [1] creatorVault  [2] System  [3] eventAuthority  [4] PUMP_PROGRAM
 */
function validatePumpIx(
  ix: TransactionInstruction,
  wallet: PublicKey,
  pdas: WalletPdas,
  label: string,
): void {
  if (ix.data.length < 8) {
    throw new TransactionValidationError(
      `${label}: Pump instruction data too short`,
    );
  }
  const disc = ix.data.subarray(0, 8);

  if (PUMP_CLAIM_CASHBACK.equals(disc)) {
    if (ix.keys.length !== 5) {
      throw new TransactionValidationError(
        `${label}: Pump claim_cashback expected 5 accounts, got ${ix.keys.length}`,
      );
    }
    requireKey(ix, 0, wallet, 'Pump claim_cashback user', label);
    requireKey(ix, 1, pdas.pumpAccumulator, 'Pump claim_cashback accumulator', label);
    requireKey(ix, 2, SystemProgram.programId, 'Pump claim_cashback System Program', label);
    requireKey(ix, 3, pdas.pumpEventAuthority, 'Pump claim_cashback eventAuthority', label);
    requireKey(ix, 4, PUMP_PROGRAM_ID, 'Pump claim_cashback program self-ref', label);
  } else if (PUMP_COLLECT_CREATOR_FEE.equals(disc)) {
    if (ix.keys.length !== 5) {
      throw new TransactionValidationError(
        `${label}: Pump collect_creator_fee expected 5 accounts, got ${ix.keys.length}`,
      );
    }
    requireKey(ix, 0, wallet, 'Pump collect_creator_fee user', label);
    requireKey(ix, 1, pdas.pumpCreatorVault, 'Pump collect_creator_fee creatorVault', label);
    requireKey(ix, 2, SystemProgram.programId, 'Pump collect_creator_fee System Program', label);
    requireKey(ix, 3, pdas.pumpEventAuthority, 'Pump collect_creator_fee eventAuthority', label);
    requireKey(ix, 4, PUMP_PROGRAM_ID, 'Pump collect_creator_fee program self-ref', label);
  } else {
    throw new TransactionValidationError(
      `${label}: Pump instruction has unrecognized discriminator`,
    );
  }
}

/**
 * Validate PumpSwap instruction: discriminator + full account layout.
 *
 * claim_cashback (9 keys):
 *   [0] user  [1] accumulator  [2] NATIVE_MINT  [3] TOKEN_PROGRAM
 *   [4] accumulatorWsolAta  [5] userWsolAta  [6] System
 *   [7] eventAuthority  [8] PUMP_AMM_PROGRAM
 *
 * collect_coin_creator_fee (8 keys):
 *   [0] NATIVE_MINT  [1] TOKEN_PROGRAM  [2] user  [3] vaultAuthority
 *   [4] vaultAta  [5] userWsolAta  [6] eventAuthority  [7] PUMP_AMM_PROGRAM
 */
function validatePumpSwapIx(
  ix: TransactionInstruction,
  wallet: PublicKey,
  pdas: WalletPdas,
  label: string,
): void {
  if (ix.data.length < 8) {
    throw new TransactionValidationError(
      `${label}: PumpSwap instruction data too short`,
    );
  }
  const disc = ix.data.subarray(0, 8);

  if (PUMP_CLAIM_CASHBACK.equals(disc)) {
    if (ix.keys.length !== 9) {
      throw new TransactionValidationError(
        `${label}: PumpSwap claim_cashback expected 9 accounts, got ${ix.keys.length}`,
      );
    }
    requireKey(ix, 0, wallet, 'PumpSwap claim_cashback user', label);
    requireKey(ix, 1, pdas.pumpSwapAccumulator, 'PumpSwap claim_cashback accumulator', label);
    requireKey(ix, 2, NATIVE_MINT, 'PumpSwap claim_cashback mint', label);
    requireKey(ix, 3, SPL_TOKEN_PROGRAM_ID, 'PumpSwap claim_cashback token program', label);
    requireKey(ix, 4, pdas.pumpSwapAccumulatorWsolAta, 'PumpSwap claim_cashback accumulator ATA', label);
    requireKey(ix, 5, pdas.userWsolAta, 'PumpSwap claim_cashback user ATA', label);
    requireKey(ix, 6, SystemProgram.programId, 'PumpSwap claim_cashback System Program', label);
    requireKey(ix, 7, pdas.pumpSwapEventAuthority, 'PumpSwap claim_cashback eventAuthority', label);
    requireKey(ix, 8, PUMP_AMM_PROGRAM_ID, 'PumpSwap claim_cashback program self-ref', label);
  } else if (PUMPSWAP_COLLECT_COIN_CREATOR_FEE.equals(disc)) {
    if (ix.keys.length !== 8) {
      throw new TransactionValidationError(
        `${label}: PumpSwap collect_coin_creator_fee expected 8 accounts, got ${ix.keys.length}`,
      );
    }
    requireKey(ix, 0, NATIVE_MINT, 'PumpSwap collect_coin_creator_fee mint', label);
    requireKey(ix, 1, SPL_TOKEN_PROGRAM_ID, 'PumpSwap collect_coin_creator_fee token program', label);
    requireKey(ix, 2, wallet, 'PumpSwap collect_coin_creator_fee user', label);
    requireKey(ix, 3, pdas.pumpSwapCreatorVaultAuthority, 'PumpSwap collect_coin_creator_fee vaultAuthority', label);
    requireKey(ix, 4, pdas.pumpSwapCreatorVaultAta, 'PumpSwap collect_coin_creator_fee vaultAta', label);
    requireKey(ix, 5, pdas.userWsolAta, 'PumpSwap collect_coin_creator_fee userAta', label);
    requireKey(ix, 6, pdas.pumpSwapEventAuthority, 'PumpSwap collect_coin_creator_fee eventAuthority', label);
    requireKey(ix, 7, PUMP_AMM_PROGRAM_ID, 'PumpSwap collect_coin_creator_fee program self-ref', label);
  } else {
    throw new TransactionValidationError(
      `${label}: PumpSwap instruction has unrecognized discriminator`,
    );
  }
}

function validateSplTokenCloseAccount(
  ix: TransactionInstruction,
  wallet: PublicKey,
  label: string,
): void {
  if (ix.data.length < 1 || ix.data[0] !== 9) {
    throw new TransactionValidationError(
      `${label}: SPL Token instruction is not CloseAccount (disc=${ix.data.length > 0 ? ix.data[0] : 'empty'})`,
    );
  }
  if (ix.keys.length !== 3) {
    throw new TransactionValidationError(
      `${label}: SPL Token CloseAccount expected 3 accounts, got ${ix.keys.length}`,
    );
  }
  requireKey(ix, 1, wallet, 'SPL Token CloseAccount destination', label);
  requireKey(ix, 2, wallet, 'SPL Token CloseAccount authority', label);
}

export class TransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionValidationError';
  }
}

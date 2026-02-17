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
  FEE_VAULT,
  EXPECTED_PROGRAM_IDS,
  BPF_LOADER_UPGRADEABLE,
  TOKEN_PAIRS_PER_IX,
  BUFFERS_PER_IX,
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
        if (pid === '11111111111111111111111111111111') {
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

export class TransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionValidationError';
  }
}

import { Connection, Keypair, Transaction, PublicKey, SendTransactionError, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { verifyRewardFees } from './reward-validation.js';
import { verifyStakeAccounts } from './stake-validation.js';
import { inspectCleanupTargets } from './cleanup-validation.js';
import { TokenAccountInfo, BufferAccountInfo } from './scanner.js';
import { Config } from '../config.js';
import { closeEmptyTargetCount, simulatedCloseCount } from './cleanup-simulation.js';

export interface SendResult {
  signature: string;
  status: 'confirmed' | 'failed' | 'unknown';
  error?: string;
}

function isPreflightRejection(err: unknown): boolean {
  // web3.js exposes its private transactionMessage through this public getter.
  return err instanceof SendTransactionError && /^Transaction simulation failed/i.test(err.transactionError.message);
}

export class SignerService {
  private connection: Connection;

  constructor(config: Config) {
    this.connection = new Connection(config.rpcUrl, 'confirmed');
  }

  async getBalance(wallet: PublicKey): Promise<number> {
    return this.connection.getBalance(wallet, 'confirmed');
  }

  async inspectCleanup(wallet: PublicKey, tokens: TokenAccountInfo[], buffers: BufferAccountInfo[]) {
    return inspectCleanupTargets(this.connection, wallet, tokens, buffers);
  }

  async verifyRewards(transactions: Transaction[], wallet: PublicKey): Promise<void> {
    await verifyRewardFees(this.connection, transactions, wallet);
  }

  async verifyStakes(transactions: Transaction[], wallet: PublicKey, requestedAccounts?: string[]): Promise<void> {
    await verifyStakeAccounts(this.connection, transactions, wallet, requestedAccounts);
  }

  /** Submit each signed transaction once. An ambiguous RPC failure is never
   * grounds to re-sign with a fresh blockhash and create a second payment. */
  async signAndSendBatch(transactions: Transaction[], keypair: Keypair): Promise<SendResult[]> {
    if (transactions.length > 25) throw new Error('TRANSACTION_LIMIT_EXCEEDED');
    if (transactions.length === 0) return [];
    // Validate size and duplicate messages using a fixed placeholder before any
    // submission. Actual signing happens only when each transaction is ready.
    const prepared = transactions.map(source => {
      const tx = new Transaction({ feePayer: keypair.publicKey, recentBlockhash: PublicKey.default.toBase58() });
      tx.add(...source.instructions);
      const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      if (bytes.length > 1232) throw new Error('TRANSACTION_TOO_LARGE');
      return bytes;
    });
    if (new Set(prepared.map(bytes => bytes.toString('base64'))).size !== prepared.length) {
      throw new Error('DUPLICATE_TRANSACTIONS');
    }
    const results: SendResult[] = [];
    for (const preparedBytes of prepared) {
      let signature = '';
      let submissionAttempted = false;
      try {
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
        const tx = Transaction.from(preparedBytes);
        tx.recentBlockhash = blockhash;
        const cleanupTargets = closeEmptyTargetCount(tx);
        if (cleanupTargets !== null) {
          // VersionedTransaction also accepts a legacy Message. The config
          // overload avoids web3.js's legacy simulation blockhash cache.
          const simulation = await this.connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
            sigVerify: false, commitment: 'confirmed',
          });
          if (simulation.value.err) {
            results.push({ signature: '', status: 'failed', error: 'PREFLIGHT_REJECTED' });
            continue;
          }
          const closed = simulatedCloseCount(simulation.value.logs, cleanupTargets);
          if (closed === null || closed === 0) {
            results.push({ signature: '', status: 'failed', error: closed === 0
              ? 'NO_RECOVERY: no eligible token accounts; not submitted'
              : 'CLEANUP_SIMULATION_UNVERIFIED: not submitted' });
            continue;
          }
        }
        tx.sign(keypair);
        const bytes = tx.serialize();
        signature = bs58.encode(tx.signature!);
        submissionAttempted = true;
        let returnedSignature: string;
        try {
          // The RPC may rebroadcast these exact signed bytes until the blockhash
          // expires; an identical signature cannot land twice.
          returnedSignature = await this.connection.sendRawTransaction(bytes, {
            skipPreflight: false, preflightCommitment: 'confirmed',
          });
        } catch (err) {
          if (!isPreflightRejection(err)) throw err;
          results.push({ signature, status: 'failed', error: 'PREFLIGHT_REJECTED' });
          continue; // The rejected transaction is never retried.
        }
        if (returnedSignature !== signature) throw new Error('RPC_SIGNATURE_MISMATCH');
        const confirmation = await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight }, 'confirmed',
        );
        results.push(confirmation.value.err
          ? { signature, status: 'failed', error: 'TRANSACTION_REJECTED' }
          : { signature, status: 'confirmed' });
      } catch {
        // Retain the locally derived signature even if the send response was lost.
        results.push(submissionAttempted
          ? { signature, status: 'unknown', error: 'SUBMISSION_UNCERTAIN: check signature status before a fresh dry run' }
          : { signature, status: 'failed', error: 'NOT_SUBMITTED' });
        // Preserve earlier results and stop; later transactions remain unsigned.
        for (let i = results.length; i < prepared.length; i++) {
          results.push({ signature: '', status: 'failed', error: 'NOT_SUBMITTED' });
        }
        break;
      }
    }
    return results;
  }
}

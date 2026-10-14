import { Connection, Keypair, Transaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { verifyRewardFees } from './reward-validation.js';
import { verifyStakeAccounts } from './stake-validation.js';
import { inspectCleanupTargets } from './cleanup-validation.js';
import { TokenAccountInfo, BufferAccountInfo } from './scanner.js';
import { Config } from '../config.js';

export interface SendResult {
  signature: string;
  status: 'confirmed' | 'failed' | 'unknown';
  error?: string;
}

export class SignerService {
  private connection: Connection;

  constructor(config: Config) {
    this.connection = new Connection(config.rpcUrl, 'confirmed');
  }

  async getBalance(wallet: PublicKey): Promise<number> {
    return this.connection.getBalance(wallet, 'confirmed');
  }

  async inspectCleanup(wallet: PublicKey, tokens: TokenAccountInfo[], buffers: BufferAccountInfo[], explicitTokens: string[] = []) {
    return inspectCleanupTargets(this.connection, wallet, tokens, buffers, explicitTokens);
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
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    // Serialize the entire batch before sending anything, so size/serialization
    // errors cannot cause partially submitted batches.
    const signed = transactions.map(source => {
      const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight });
      tx.add(...source.instructions);
      tx.sign(keypair);
      const bytes = tx.serialize();
      if (bytes.length > 1232) throw new Error('TRANSACTION_TOO_LARGE');
      return { bytes, signature: bs58.encode(tx.signature!) };
    });
    if (new Set(signed.map(tx => tx.signature)).size !== signed.length) {
      throw new Error('DUPLICATE_TRANSACTIONS');
    }
    const results: SendResult[] = [];
    for (const { bytes, signature } of signed) {
      try {
        const returnedSignature = await this.connection.sendRawTransaction(bytes, {
          skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0,
        });
        if (returnedSignature !== signature) throw new Error('RPC_SIGNATURE_MISMATCH');
        const confirmation = await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight }, 'confirmed',
        );
        results.push(confirmation.value.err
          ? { signature, status: 'failed', error: 'TRANSACTION_REJECTED' }
          : { signature, status: 'confirmed' });
      } catch {
        // Retain the locally derived signature even if the send response was lost.
        results.push({ signature, status: 'unknown', error: 'SUBMISSION_UNCERTAIN: check signature status before a fresh dry run' });
        // Stop the batch after an unknown outcome; later transactions remain unsent.
        for (const remaining of signed.slice(results.length)) {
          results.push({ signature: remaining.signature, status: 'failed', error: 'NOT_SUBMITTED' });
        }
        break;
      }
    }
    return results;
  }
}

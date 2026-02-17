import {
  Connection,
  Keypair,
  Transaction,
  PublicKey,
} from '@solana/web3.js';
import { Config } from '../config.js';

export interface SendResult {
  signature: string;
  status: 'confirmed' | 'failed';
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

  /**
   * Batch sign + send + confirm with retry.
   *
   * 1. Fetch one blockhash
   * 2. Sign all txs with same blockhash
   * 3. Send all
   * 4. Confirm all in parallel
   * 5. Retry blockhash-expired failures (max 2 rounds)
   */
  async signAndSendBatch(
    transactions: Transaction[],
    keypair: Keypair,
  ): Promise<SendResult[]> {
    const results: SendResult[] = new Array(transactions.length);

    // Store original instructions for retry (re-signing needs fresh tx objects)
    const ixSets = transactions.map((tx) => [...tx.instructions]);
    let pending = ixSets.map((_, i) => i);

    const MAX_RETRIES = 2;

    for (
      let round = 0;
      round <= MAX_RETRIES && pending.length > 0;
      round++
    ) {
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash('confirmed');

      // Build + sign
      const txMap = new Map<number, Transaction>();
      for (const idx of pending) {
        const tx = new Transaction();
        for (const ix of ixSets[idx]) tx.add(ix);
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = keypair.publicKey;
        tx.sign(keypair);
        txMap.set(idx, tx);
      }

      // Send
      const sent: { idx: number; sig: string }[] = [];
      for (const [idx, tx] of txMap) {
        try {
          const sig = await this.connection.sendRawTransaction(
            tx.serialize(),
            {
              skipPreflight: false,
              preflightCommitment: 'confirmed',
            },
          );
          sent.push({ idx, sig });
        } catch (err) {
          results[idx] = {
            signature: '',
            status: 'failed',
            error: (err as Error).message,
          };
        }
      }

      // Confirm in parallel
      await Promise.allSettled(
        sent.map(async ({ idx, sig }) => {
          try {
            const conf = await this.connection.confirmTransaction(
              { signature: sig, blockhash, lastValidBlockHeight },
              'confirmed',
            );
            if (conf.value.err) {
              results[idx] = {
                signature: sig,
                status: 'failed',
                error: JSON.stringify(conf.value.err),
              };
            } else {
              results[idx] = { signature: sig, status: 'confirmed' };
            }
          } catch (err) {
            results[idx] = {
              signature: sig,
              status: 'failed',
              error: (err as Error).message,
            };
          }
        }),
      );

      // Find retryable failures (blockhash expired)
      pending = pending.filter((idx) => {
        const r = results[idx];
        return (
          r?.status === 'failed' &&
          r.error?.toLowerCase().includes('blockhash')
        );
      });
    }

    return results;
  }
}

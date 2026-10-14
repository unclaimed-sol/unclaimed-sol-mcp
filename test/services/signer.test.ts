import { describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction, TransactionExpiredBlockheightExceededError } from '@solana/web3.js';
import bs58 from 'bs58';
import { SignerService } from '../../src/services/signer.js';

function setup() {
  const keypair = Keypair.generate();
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1,
  }));
  const connection = {
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    sendRawTransaction: vi.fn(async (bytes: Buffer) => bs58.encode(Transaction.from(bytes).signature!)),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
  };
  const signer = new SignerService({ apiUrl: 'https://unclaimedsol.com', apiKey: null, keypair, rpcUrl: 'https://api.mainnet-beta.solana.com', priorityFee: 1000, claimEnabled: true });
  (signer as unknown as { connection: typeof connection }).connection = connection;
  return { signer, connection, keypair, tx };
}

describe('SignerService one-shot submission', () => {
  it('confirms using the locally computed signature', async () => {
    const { signer, connection, keypair, tx } = setup();
    const [result] = await signer.signAndSendBatch([tx], keypair);
    expect(result.status).toBe('confirmed');
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction.mock.calls[0][0]).toBeInstanceOf(Buffer);
    expect(connection.confirmTransaction.mock.calls[0][0].signature).toBe(result.signature);
  });

  it.each(['BlockhashNotFound', 'https://rpc.example/secret?api-key=secret'])('never retries a send failure: %s', async message => {
    const { signer, connection, keypair, tx } = setup();
    connection.sendRawTransaction.mockRejectedValue(new Error(message));
    const [result] = await signer.signAndSendBatch([tx], keypair);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(result.status).toBe('unknown');
    expect(result.error).toContain('SUBMISSION_UNCERTAIN');
    expect(result.error).not.toContain(message);
  });

  it('does not re-sign after ambiguous confirmation expiry and stops the batch', async () => {
    const { signer, connection, keypair, tx } = setup();
    connection.confirmTransaction.mockRejectedValue(new TransactionExpiredBlockheightExceededError('lost'));
    const second = new Transaction().add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 2 }));
    const results = await signer.signAndSendBatch([tx, second], keypair);
    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(results[0].error).toContain('SUBMISSION_UNCERTAIN');
    expect(results[1].error).toBe('NOT_SUBMITTED');
  });

  it('rejects duplicate signed transactions before sending', async () => {
    const { signer, connection, keypair, tx } = setup();
    await expect(signer.signAndSendBatch([tx, tx], keypair)).rejects.toThrow('DUPLICATE');
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('rejects oversized batches before RPC', async () => {
    const { signer, connection, keypair, tx } = setup();
    await expect(signer.signAndSendBatch(Array(26).fill(tx), keypair)).rejects.toThrow('LIMIT');
    expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction, TransactionExpiredBlockheightExceededError, SendTransactionError } from '@solana/web3.js';
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

  it('records a typed send rejection without leaking details and continues to the next transaction', async () => {
    const {signer,connection,keypair,tx}=setup();
    const next=new Transaction().add(SystemProgram.transfer({fromPubkey:keypair.publicKey,toPubkey:Keypair.generate().publicKey,lamports:2}));
    connection.sendRawTransaction.mockRejectedValueOnce(new SendTransactionError({action:'simulate',signature:'',transactionMessage:'https://rpc.example/secret',logs:['secret log']}));
    const results=await signer.signAndSendBatch([tx,next],keypair);
    expect(results[0]).toMatchObject({status:'failed',error:'PREFLIGHT_REJECTED'});
    expect(results[0].signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(results[1].status).toBe('confirmed');
    expect(JSON.stringify(results)).not.toContain('secret');
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(connection.confirmTransaction).toHaveBeenCalledTimes(1);
  });
  it.each(['generic send','typed confirmation','generic confirmation'])('keeps %s errors uncertain and stops the batch', async phase => {
    const {signer,connection,keypair,tx}=setup();
    const next=new Transaction().add(SystemProgram.transfer({fromPubkey:keypair.publicKey,toPubkey:Keypair.generate().publicKey,lamports:2}));
    const error=phase==='typed confirmation'
      ? new SendTransactionError({action:'simulate',signature:'',transactionMessage:'private RPC detail'})
      : new Error('private RPC detail');
    if(phase==='generic send') connection.sendRawTransaction.mockRejectedValueOnce(error);
    else connection.confirmTransaction.mockRejectedValueOnce(error);
    const results=await signer.signAndSendBatch([tx,next],keypair);
    expect(results[0].status).toBe('unknown');
    expect(results[1].error).toBe('NOT_SUBMITTED');
    expect(JSON.stringify(results)).not.toContain('private RPC detail');
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('gets a fresh blockhash after the previous confirmation and before each send', async () => {
    const { signer, connection, keypair, tx } = setup();
    const second = new Transaction().add(SystemProgram.transfer({fromPubkey:keypair.publicKey,toPubkey:Keypair.generate().publicKey,lamports:2}));
    const firstHash = Keypair.generate().publicKey.toBase58();
    const secondHash = Keypair.generate().publicKey.toBase58();
    connection.getLatestBlockhash.mockResolvedValueOnce({blockhash:firstHash,lastValidBlockHeight:100})
      .mockImplementationOnce(async () => {
        expect(connection.confirmTransaction).toHaveBeenCalledTimes(1);
        return {blockhash:secondHash,lastValidBlockHeight:300};
      });
    const results = await signer.signAndSendBatch([tx,second],keypair);
    expect(results.map(r=>r.status)).toEqual(['confirmed','confirmed']);
    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(connection.sendRawTransaction.mock.calls.map(([bytes])=>Transaction.from(bytes).recentBlockhash)).toEqual([firstHash,secondHash]);
    expect(connection.confirmTransaction.mock.calls[1][0]).toMatchObject({blockhash:secondHash,lastValidBlockHeight:300});
  });

  it('retains earlier confirmations if fetching a later blockhash fails', async () => {
    const { signer, connection, keypair, tx } = setup();
    const second = new Transaction().add(SystemProgram.transfer({fromPubkey:keypair.publicKey,toPubkey:Keypair.generate().publicKey,lamports:2}));
    connection.getLatestBlockhash.mockResolvedValueOnce({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100})
      .mockRejectedValueOnce(new Error('private RPC endpoint'));
    const results = await signer.signAndSendBatch([tx,second],keypair);
    expect(results[0].status).toBe('confirmed');
    expect(results[1]).toEqual({signature:'',status:'failed',error:'NOT_SUBMITTED'});
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate messages before fetching a blockhash or sending', async () => {
    const { signer, connection, keypair, tx } = setup();
    await expect(signer.signAndSendBatch([tx, tx], keypair)).rejects.toThrow('DUPLICATE');
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
  });

  it('rejects oversized batches before RPC', async () => {
    const { signer, connection, keypair, tx } = setup();
    await expect(signer.signAndSendBatch(Array(26).fill(tx), keypair)).rejects.toThrow('LIMIT');
    expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
  });
});

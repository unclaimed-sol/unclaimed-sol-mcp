import { describe, expect, it, vi } from 'vitest';
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
} from '@solana/web3.js';
import { SignerService } from '../../src/services/signer.js';
import type { Config } from '../../src/config.js';

function makeConfig(): Config {
  return {
    apiUrl: 'https://unclaimedsol.com',
    apiKey: null,
    keypair: null,
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    priorityFee: 1_000,
    claimEnabled: true,
  };
}

function makeTransaction(keypair: Keypair): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
}

function makeMockConnection(blockhashCount = 2) {
  const blockhashes = Array.from({ length: blockhashCount }, () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  }));
  const connection = {
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    confirmTransaction: vi.fn().mockResolvedValue({
      context: { slot: 1 },
      value: { err: null },
    }),
  };

  for (const blockhash of blockhashes) {
    connection.getLatestBlockhash.mockResolvedValueOnce(blockhash);
  }

  return connection;
}

function makeSigner(connection: ReturnType<typeof makeMockConnection>) {
  const signer = new SignerService(makeConfig());
  (signer as unknown as { connection: typeof connection }).connection =
    connection;
  return signer;
}

describe('SignerService blockhash expiry handling', () => {
  it.each([
    ['RPC message', 'Transaction simulation failed: Blockhash not found'],
    ['RPC enum variant', 'BlockhashNotFound'],
    ['RPC block-height message', 'block height exceeded'],
    [
      'web3.js block-height message',
      new TransactionExpiredBlockheightExceededError('first-signature').message,
    ],
    [
      'web3.js error-name variant',
      'TransactionExpiredBlockheightExceededError: transaction expired',
    ],
  ])('rebuilds and re-signs after the %s', async (_label, expiryMessage) => {
    const keypair = Keypair.generate();
    const connection = makeMockConnection();
    connection.sendRawTransaction
      .mockRejectedValueOnce(new Error(expiryMessage))
      .mockResolvedValueOnce('retry-signature');
    const signer = makeSigner(connection);

    const results = await signer.signAndSendBatch(
      [makeTransaction(keypair)],
      keypair,
    );

    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { signature: 'retry-signature', status: 'confirmed' },
    ]);
  });

  it('does not retry an unrelated send error', async () => {
    const keypair = Keypair.generate();
    const connection = makeMockConnection(1);
    connection.sendRawTransaction.mockRejectedValueOnce(
      new Error('Transaction simulation failed: insufficient funds for fee'),
    );
    const signer = makeSigner(connection);

    const results = await signer.signAndSendBatch(
      [makeTransaction(keypair)],
      keypair,
    );

    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({
      signature: '',
      status: 'failed',
      error: 'Transaction simulation failed: insufficient funds for fee',
    });
  });

  it('does not retry a confirmation timeout with an unknown outcome', async () => {
    const keypair = Keypair.generate();
    const connection = makeMockConnection(1);
    connection.sendRawTransaction.mockResolvedValueOnce('first-signature');
    connection.confirmTransaction.mockRejectedValueOnce(
      new TransactionExpiredTimeoutError('first-signature', 30),
    );
    const signer = makeSigner(connection);

    const results = await signer.signAndSendBatch(
      [makeTransaction(keypair)],
      keypair,
    );

    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({
      signature: 'first-signature',
      status: 'failed',
    });
  });

  it('keeps the two-retry limit and never sends identical signed bytes', async () => {
    const keypair = Keypair.generate();
    const connection = makeMockConnection(3);
    connection.sendRawTransaction
      .mockResolvedValueOnce('first-signature')
      .mockResolvedValueOnce('second-signature')
      .mockResolvedValueOnce('third-signature');
    connection.confirmTransaction.mockRejectedValue(
      new TransactionExpiredBlockheightExceededError('expired-signature'),
    );
    const signer = makeSigner(connection);

    const results = await signer.signAndSendBatch(
      [makeTransaction(keypair)],
      keypair,
    );

    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(3);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(3);
    expect(connection.confirmTransaction).toHaveBeenCalledTimes(3);
    expect(results[0]).toMatchObject({
      signature: 'third-signature',
      status: 'failed',
    });
    const signedBytes = connection.sendRawTransaction.mock.calls.map(
      ([serialized]) => Buffer.from(serialized).toString('hex'),
    );
    expect(new Set(signedBytes).size).toBe(signedBytes.length);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { Connection, PublicKey, SendTransactionError } from '@solana/web3.js';

// Exercise web3.js's real Jayson client; only the HTTP boundary is replaced.
function connectionWith(result: unknown, error?: { code: number; message: string }) {
  const fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const request = JSON.parse(String(init?.body));
    const respond = (entry: { id: string }) => ({
      jsonrpc: '2.0', id: entry.id, ...(error ? { error } : { result }),
    });
    return Response.json(Array.isArray(request) ? request.map(respond) : respond(request));
  });
  return { connection: new Connection('https://rpc.invalid', { fetch }), fetch };
}

describe('published RPC transport compatibility', () => {
  it('round-trips a single request with a generated string ID', async () => {
    const { connection, fetch } = connectionWith({ context: { slot: 1 }, value: 42 });
    expect(await connection.getBalance(PublicKey.default)).toBe(42);
    const request = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(request).toMatchObject({ jsonrpc: '2.0', method: 'getBalance' });
    expect(request.id).toEqual(expect.any(String));
    expect(request.id.length).toBeGreaterThan(0);
  });

  it('round-trips batch requests', async () => {
    const { connection, fetch } = connectionWith(null);
    expect(await connection.getParsedTransactions(['first', 'second'])).toEqual([null, null]);
    const requests = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request: { id: string }) => request.id)).size).toBe(2);
  });

  it.each([
    [-32002, 'Transaction simulation failed: Blockhash not found'],
    [-32603, 'Internal error'],
  ])('preserves RPC send error %s for submission classification', async (code, message) => {
    const { connection } = connectionWith(undefined, { code, message });
    const error = await connection.sendRawTransaction(Buffer.from([1])).catch(err => err);
    expect(error).toBeInstanceOf(SendTransactionError);
    expect(error.transactionError.message).toBe(message);
  });
});

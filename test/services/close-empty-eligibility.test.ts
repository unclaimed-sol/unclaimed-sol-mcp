import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { inspectCleanupTargets } from '../../src/services/cleanup-validation.js';

const classic = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const t22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const wallet = Keypair.generate().publicKey;
const rent = 2_039_280;
function extended(base: Buffer, accountType: number, entries: [number, number][]) {
  if (!entries.length) return base;
  const data = Buffer.alloc(166 + entries.reduce((size, [, length]) => size + 4 + length, 0));
  base.copy(data); data[165] = accountType;
  let offset = 166;
  for (const [type, length] of entries) {
    data.writeUInt16LE(type, offset); data.writeUInt16LE(length, offset + 2); offset += 4 + length;
  }
  return data;
}
function fixture(program = t22, mintKey = Keypair.generate().publicKey) {
  const tokenKey = Keypair.generate().publicKey;
  const tokenData = Buffer.alloc(165); mintKey.toBuffer().copy(tokenData);
  wallet.toBuffer().copy(tokenData, 32); tokenData[108] = 1;
  const mintData = Buffer.alloc(82); mintData[45] = 1;
  const info = (data: Buffer): AccountInfo<Buffer> => ({ data, owner: program, lamports: rent, executable: false, rentEpoch: 0 });
  const token = info(tokenData), mint = info(mintData);
  const target = { pubKey: tokenKey.toBase58(), mintKey: mintKey.toBase58(), programOwnerId: program.toBase58(), amountUi: 0, isFrozen: false, lamports: rent };
  const rpc = { getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(k => k.equals(tokenKey) ? token : k.equals(mintKey) ? mint : null)) };
  return { target, token, mint, rpc };
}

describe('close-empty RPC eligibility', () => {
  it.each([
    [classic, 'So11111111111111111111111111111111111111112'],
    [t22, '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP'],
  ] as const)('checks native reserve and unsynchronized deposits for %s', async (program, native) => {
    const { target, token, rpc } = fixture(program, new PublicKey(native));
    token.data.writeUInt32LE(1, 109); token.data.writeBigUInt64LE(BigInt(rent), 113);
    expect((await inspectCleanupTargets(rpc, wallet, [target], [])).tokens).toHaveLength(1);
    token.lamports += 1; // No SyncNative: amount remains zero.
    expect((await inspectCleanupTargets(rpc, wallet, [target], [])).skipped).toBe(1);
    token.lamports = rent; token.data.writeUInt32LE(0, 109);
    expect((await inspectCleanupTargets(rpc, wallet, [target], [])).skipped).toBe(1);
  });
  it('rejects a native marker on a nonnative mint', async () => {
    const { target, token, rpc } = fixture(classic);
    token.data.writeUInt32LE(1, 109); token.data.writeBigUInt64LE(BigInt(rent), 113);
    expect((await inspectCleanupTargets(rpc, wallet, [target], [])).skipped).toBe(1);
  });
  it.each([
    [[], []], [[[7, 0]], []], [[[2, 8]], [[1, 108]]], [[[7, 0], [2, 8]], [[1, 108]]],
  ] as [Array<[number, number]>, Array<[number, number]>][])('accepts supported matching extensions %j / %j', async (accountExtensions, mintExtensions) => {
    const { target, token, mint, rpc } = fixture();
    token.data = extended(token.data, 2, accountExtensions); mint.data = extended(mint.data, 1, mintExtensions);
    expect((await inspectCleanupTargets(rpc, wallet, [target], [])).tokens).toEqual([target]);
  });
  it.each(['metadata', 'account extension', 'duplicate', 'length', 'trailing', 'fee mismatch', 'mint owner', 'mint uninitialized', 'mint type', 'missing mint'])('skips unsupported or malformed %s', async kind => {
    const { target, token, mint, rpc } = fixture();
    if (kind === 'metadata') mint.data = extended(mint.data, 1, [[18, 64]]);
    if (kind === 'account extension') token.data = extended(token.data, 2, [[11, 1]]);
    if (kind === 'duplicate') token.data = extended(token.data, 2, [[7, 0], [7, 0]]);
    if (kind === 'length') token.data = extended(token.data, 2, [[2, 7]]);
    if (kind === 'trailing') token.data = Buffer.concat([extended(token.data, 2, [[7, 0]]), Buffer.from([1])]);
    if (kind === 'fee mismatch') token.data = extended(token.data, 2, [[2, 8]]);
    if (kind === 'mint owner') mint.owner = classic;
    if (kind === 'mint uninitialized') mint.data[45] = 0;
    if (kind === 'mint type') mint.data = extended(mint.data, 2, [[1, 108]]);
    if (kind === 'missing mint') rpc.getMultipleAccountsInfo.mockImplementation(async keys => keys.map(k => k.toBase58() === target.pubKey ? token : null));
    expect((await inspectCleanupTargets(rpc, wallet, [target], [])).skipped).toBe(1);
  });
  it('advances past 256 unsupported mints before applying the eligible cap', async () => {
    const fixtures = Array.from({ length: 257 }, () => fixture());
    const infos = new Map<string, AccountInfo<Buffer>>();
    fixtures.forEach(({ target, token, mint }, index) => {
      if (index < 256) mint.data = extended(mint.data, 1, [[18, 64]]);
      infos.set(target.pubKey, token); infos.set(target.mintKey, mint);
    });
    const rpc = { getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(k => infos.get(k.toBase58()) ?? null)) };
    const result = await inspectCleanupTargets(rpc, wallet, fixtures.map(f => f.target), []);
    expect(result.tokens).toEqual([fixtures[256].target]); expect(result.skipped).toBe(256);
    expect(rpc.getMultipleAccountsInfo.mock.calls.every(([keys]) => keys.length <= 100)).toBe(true);
  });
  it('propagates mint RPC failures and rejects incomplete mint responses', async () => {
    const own = fixture();
    own.rpc.getMultipleAccountsInfo.mockResolvedValueOnce([own.token]).mockRejectedValueOnce(new Error('mint RPC failed'));
    await expect(inspectCleanupTargets(own.rpc, wallet, [own.target], [])).rejects.toThrow('mint RPC failed');
    own.rpc.getMultipleAccountsInfo.mockResolvedValueOnce([own.token]).mockResolvedValueOnce([]);
    await expect(inspectCleanupTargets(own.rpc, wallet, [own.target], [])).rejects.toThrow('INCOMPLETE_RPC_RESPONSE');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, StakeProgram, SYSVAR_CLOCK_PUBKEY, Transaction } from '@solana/web3.js';
import { verifyStakeAccounts } from '../../src/services/stake-validation.js';

function setup() {
  const wallet = Keypair.generate().publicKey;
  const stake = Keypair.generate().publicKey;
  const data = Buffer.alloc(200);
  data.writeUInt32LE(2, 0);
  wallet.toBuffer().copy(data, 44);
  const clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(100n, 16);
  clock.writeBigInt64LE(1_000n, 32);
  const account = { data, lamports: 2_000_000, owner: StakeProgram.programId, executable: false, rentEpoch: 0 };
  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) => key.equals(SYSVAR_CLOCK_PUBKEY) ? { ...account, data: clock } : account),
    simulateTransaction: vi.fn(async () => ({ context: { slot: 1 }, value: { err: null as unknown, logs: [] } })),
  };
  const tx = StakeProgram.withdraw({ stakePubkey: stake, authorizedPubkey: wallet, toPubkey: wallet, lamports: 2_000_000 });
  return { wallet, stake, data, account, connection, tx };
}

describe('trusted RPC stake revalidation', () => {
  it('accepts the exact fully inactive source and amount', async () => {
    const { connection, tx, wallet, stake } = setup();
    await expect(verifyStakeAccounts(connection as any, [tx], wallet, [stake.toBase58()])).resolves.toBeUndefined();
  });
  it.each(['balance', 'authority', 'lockup', 'owner', 'state'])('rejects changed %s', async change => {
    const { connection, tx, wallet, account, data } = setup();
    if (change === 'balance') account.lamports++;
    if (change === 'authority') Keypair.generate().publicKey.toBuffer().copy(data, 44);
    if (change === 'lockup') data.writeBigUInt64LE(101n, 84);
    if (change === 'owner') account.owner = Keypair.generate().publicKey;
    if (change === 'state') data.writeUInt32LE(0, 0);
    await expect(verifyStakeAccounts(connection as any, [tx], wallet)).rejects.toThrow();
  });
  it('accepts a stake deactivated in the current epoch when full withdrawal simulates', async () => {
    const { connection, tx, wallet, data } = setup();
    data.writeBigUInt64LE(100n, 164); // activation epoch == current epoch
    data.writeBigUInt64LE(100n, 172); // deactivation epoch == current epoch
    await expect(verifyStakeAccounts(connection as any, [tx], wallet)).resolves.toBeUndefined();
    expect(connection.simulateTransaction).toHaveBeenCalledTimes(1);
  });
  it('rejects partially active stake even after its deactivation epoch', async () => {
    const { connection, tx, wallet } = setup();
    connection.simulateTransaction.mockResolvedValue({ context: { slot: 1 }, value: { err: { InstructionError: [0, 'InsufficientFunds'] }, logs: [] } });
    await expect(verifyStakeAccounts(connection as any, [tx], wallet)).rejects.toThrow('simulation failed');
  });
  it('rejects duplicate source accounts across transactions', async () => {
    const { connection, tx, wallet } = setup();
    await expect(verifyStakeAccounts(connection as any, [tx, tx], wallet)).rejects.toThrow('duplicate');
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
  });
  it('rejects extra targets not selected in the dry run request', async () => {
    const { connection, tx, wallet } = setup();
    await expect(verifyStakeAccounts(connection as any, [tx], wallet, [Keypair.generate().publicKey.toBase58()])).rejects.toThrow('selection differs');
  });
  it('fails closed if activation RPC is unavailable', async () => {
    const { connection, tx, wallet } = setup();
    connection.simulateTransaction.mockRejectedValue(new Error('unavailable'));
    await expect(verifyStakeAccounts(connection as any, [tx], wallet)).rejects.toThrow();
  });
});

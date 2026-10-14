import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, Transaction, VersionedTransaction } from '@solana/web3.js';
import { STAKE_PROGRAM_ID, TransactionValidationError } from './transaction.js';

/** Recheck each exact withdrawal against the user's trusted RPC. Never infer
 * full inactivity solely from the deactivation epoch (cooldown can span epochs). */
export async function verifyStakeAccounts(
  connection: Pick<Connection, 'getAccountInfo' | 'simulateTransaction'>,
  transactions: Transaction[],
  wallet: PublicKey,
  requestedAccounts?: string[],
): Promise<void> {
  const withdrawals = transactions.flatMap(tx => tx.instructions)
    .filter(ix => ix.programId.equals(STAKE_PROGRAM_ID));
  const addresses = withdrawals.map(ix => ix.keys[0].pubkey.toBase58());
  if (withdrawals.length === 0 || withdrawals.length > 256 || new Set(addresses).size !== addresses.length) {
    throw new TransactionValidationError('Invalid or duplicate stake targets');
  }
  if (requestedAccounts && (requestedAccounts.length !== addresses.length ||
      requestedAccounts.some(address => !addresses.includes(address)))) {
    throw new TransactionValidationError('Stake selection differs from requested accounts');
  }
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  if (!clock || clock.data.length !== 40) throw new TransactionValidationError('Stake clock unavailable');
  const epoch = clock.data.readBigUInt64LE(16);
  const unixTimestamp = clock.data.readBigInt64LE(32);
  for (const ix of withdrawals) {
    const address = ix.keys[0].pubkey;
    const account = await connection.getAccountInfo(address, 'confirmed');
    if (!account || account.executable || !account.owner.equals(STAKE_PROGRAM_ID) || account.data.length !== 200 ||
        !Number.isSafeInteger(account.lamports) || BigInt(account.lamports) !== ix.data.readBigUInt64LE(4)) {
      throw new TransactionValidationError('Stake account owner, state, or live balance changed; obtain a fresh dry run');
    }
    const data = account.data;
    const state = data.readUInt32LE(0);
    if ((state !== 1 && state !== 2) || !new PublicKey(data.subarray(44, 76)).equals(wallet) ||
        data.readBigInt64LE(76) > unixTimestamp || data.readBigUInt64LE(84) > epoch) {
      throw new TransactionValidationError('Stake authority or lockup is invalid');
    }
    if (state === 2) {
      if (data.readBigUInt64LE(172) >= epoch) {
        throw new TransactionValidationError('Stake is not deactivated');
      }
    }
  }
  // getStakeActivation was removed from Solana RPC. Simulate the complete
  // full-balance withdrawals instead: the stake program computes activation
  // from stake history and rejects a full withdrawal while any stake is active.
  for (const transaction of transactions) {
    const copy = new Transaction({ feePayer: wallet, recentBlockhash: PublicKey.default.toBase58() });
    copy.add(...transaction.instructions);
    const simulation = await connection.simulateTransaction(new VersionedTransaction(copy.compileMessage()), {
      sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    });
    if (simulation.value.err) throw new TransactionValidationError('Stake full-withdrawal simulation failed');
  }
}

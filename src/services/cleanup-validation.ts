import { Connection, PublicKey } from '@solana/web3.js';
import { TokenAccountInfo, BufferAccountInfo } from './scanner.js';
import { ATA_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from './transaction.js';
import { BPF_LOADER_UPGRADEABLE } from '../constants.js';

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
/** Snapshot checks only: legacy instructions do not bind amounts atomically. */
export async function inspectCleanupTargets(
  connection: Pick<Connection, 'getMultipleAccountsInfo'>, wallet: PublicKey,
  tokens: TokenAccountInfo[], buffers: BufferAccountInfo[],
) {
  const addresses = [...tokens.map(t => t.pubKey), ...buffers.map(b => b.pubkey)];
  const reads = [];
  for (let i = 0; i < addresses.length; i += 100) {
    reads.push(connection.getMultipleAccountsInfo(addresses.slice(i, i + 100).map(a => new PublicKey(a)), 'confirmed'));
  }
  const infos = (await Promise.all(reads)).flat(); // RPC errors must propagate.
  if (infos.length !== addresses.length) throw new Error('INCOMPLETE_RPC_RESPONSE');
  const verifiedTokens = tokens.filter((token, i) => {
    const a = infos[i];
    if (!a || a.executable || !Number.isSafeInteger(a.lamports) || a.lamports < 0 || a.data.length < 165 ||
        (!a.owner.equals(SPL_TOKEN_PROGRAM_ID) && !a.owner.equals(TOKEN_2022))) return false;
    const d = a.data, mint = new PublicKey(d.subarray(0, 32));
    const close = d.readUInt32LE(129), native = d.readUInt32LE(109);
    const [ata] = PublicKey.findProgramAddressSync([wallet.toBuffer(), a.owner.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
    return d[108] === 1 && d.readBigUInt64LE(64) === 0n && native <= 1 && close <= 1 &&
      new PublicKey(d.subarray(32, 64)).equals(wallet) && mint.toBase58() === token.mintKey &&
      a.owner.toBase58() === token.programOwnerId && ata.toBase58() === token.pubKey &&
      (close === 0 || new PublicKey(d.subarray(133, 165)).equals(wallet));
  }); // Empty WSOL follows the same zero-balance rule; funded WSOL is dropped.
  const verifiedBuffers = buffers.filter((_, i) => {
    const a = infos[tokens.length + i];
    return a && !a.executable && Number.isSafeInteger(a.lamports) && a.lamports >= 0 &&
      a.owner.toBase58() === BPF_LOADER_UPGRADEABLE && a.data.length >= 37 &&
      a.data.readUInt32LE(0) === 1 && a.data[4] === 1 && new PublicKey(a.data.subarray(5, 37)).equals(wallet);
  });
  return { tokens: verifiedTokens.map(t => ({ ...t, amountUi: 0, isFrozen: false })), buffers: verifiedBuffers,
    skipped: addresses.length - verifiedTokens.length - verifiedBuffers.length };
}

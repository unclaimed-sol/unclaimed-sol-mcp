import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { TokenAccountInfo, BufferAccountInfo } from './scanner.js';
import { SPL_TOKEN_PROGRAM_ID } from './transaction.js';
import { BPF_LOADER_UPGRADEABLE } from '../constants.js';
import { cleanupExtensions } from './cleanup-extensions.js';

const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(BPF_LOADER_UPGRADEABLE);
const TOKEN_ACCOUNT_SIZE = 165;
const BUFFER_HEADER_SIZE = 37;
const RPC_BATCH_SIZE = 100;
const CLASSIC_NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_2022_NATIVE_MINT = new PublicKey('9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP');

type CleanupRpc = Pick<Connection, 'getMultipleAccountsInfo'>;

function hasValidLamports(account: AccountInfo<Buffer>): boolean {
  return (
    !account.executable &&
    Number.isSafeInteger(account.lamports) &&
    account.lamports >= 0
  );
}

/**
 * SPL Token / Token-2022 account layout:
 *   [0..32) mint, [32..64) owner, [64..72) amount, [108] state,
 *   [109..113) is_native tag, [129..133) close_authority tag, [133..165) close_authority.
 * Token-2022 extension eligibility is checked with its mint below.
 */
function isEmptyWalletTokenAccount(
  account: AccountInfo<Buffer> | null,
  wallet: PublicKey,
  expected: TokenAccountInfo,
): boolean {
  if (!account || !hasValidLamports(account)) return false;
  if (account.data.length < TOKEN_ACCOUNT_SIZE) return false;
  if (
    !account.owner.equals(SPL_TOKEN_PROGRAM_ID) &&
    !account.owner.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    return false;
  }
  if (account.owner.toBase58() !== expected.programOwnerId) return false;
  if (account.owner.equals(SPL_TOKEN_PROGRAM_ID) && account.data.length !== TOKEN_ACCOUNT_SIZE) return false;

  const data = account.data;
  const mint = new PublicKey(data.subarray(0, 32));
  const owner = new PublicKey(data.subarray(32, 64));
  const amount = data.readBigUInt64LE(64);
  const initialized = data[108] === 1;
  const nativeTag = data.readUInt32LE(109);
  const closeAuthorityTag = data.readUInt32LE(129);

  // Empty wrapped SOL follows the same zero-balance rule; funded WSOL is dropped.
  if (!initialized || amount !== 0n) return false;
  if (nativeTag > 1 || closeAuthorityTag > 1) return false;
  const nativeMint = account.owner.equals(SPL_TOKEN_PROGRAM_ID) ? CLASSIC_NATIVE_MINT : TOKEN_2022_NATIVE_MINT;
  if (nativeTag === 1) {
    const reserve = data.readBigUInt64LE(113);
    if (!mint.equals(nativeMint) || reserve === 0n || BigInt(account.lamports) !== reserve) return false;
  } else if (mint.equals(nativeMint)) return false;
  if (!owner.equals(wallet) || mint.toBase58() !== expected.mintKey) return false;
  if (closeAuthorityTag === 1) {
    const closeAuthority = new PublicKey(data.subarray(133, 165));
    if (!closeAuthority.equals(wallet)) return false;
  }
  return true;
}

function hasSupportedToken2022State(account: AccountInfo<Buffer>, mint: AccountInfo<Buffer> | null): boolean {
  if (!mint || mint.executable || !mint.owner.equals(TOKEN_2022_PROGRAM_ID) || mint.data.length < 82 || mint.data[45] !== 1) return false;
  if (mint.data.readUInt32LE(0) > 1 || mint.data.readUInt32LE(46) > 1 || account.data.readUInt32LE(72) > 1) return false;
  const accountTypes = cleanupExtensions(account.data, 'account');
  const mintTypes = cleanupExtensions(mint.data, 'mint');
  if (!accountTypes || !mintTypes || accountTypes.has(2) !== mintTypes.has(1)) return false;
  return account.data.readUInt32LE(109) === 0 || !accountTypes.has(2);
}

/** Upgradeable loader Buffer layout: [0..4) tag = 1, [4] authority tag, [5..37) authority. */
function isWalletBuffer(
  account: AccountInfo<Buffer> | null,
  wallet: PublicKey,
): boolean {
  if (!account || !hasValidLamports(account)) return false;
  if (!account.owner.equals(BPF_LOADER_UPGRADEABLE_ID)) return false;
  if (account.data.length < BUFFER_HEADER_SIZE) return false;
  const data = account.data;
  if (data.readUInt32LE(0) !== 1 || data[4] !== 1) return false;
  return new PublicKey(data.subarray(5, BUFFER_HEADER_SIZE)).equals(wallet);
}

/**
 * Read candidates in order and apply the cap after eligibility. Token-2022
 * mint reads are cached only within this inspection. These RPC snapshots keep
 * previews useful; selector 2 independently enforces token safety at execution.
 * Buffers retain their existing authority checks. RPC failures propagate.
 */
export async function inspectCleanupTargets(
  connection: CleanupRpc,
  wallet: PublicKey,
  tokens: TokenAccountInfo[],
  buffers: BufferAccountInfo[],
  limit = 256,
): Promise<{
  tokens: TokenAccountInfo[];
  buffers: BufferAccountInfo[];
  skipped: number;
  omitted: number;
}> {
  const addresses = [
    ...tokens.map((token) => new PublicKey(token.pubKey)),
    ...buffers.map((buffer) => new PublicKey(buffer.pubkey)),
  ];
  const verifiedTokens: TokenAccountInfo[] = [];
  const verifiedBuffers: BufferAccountInfo[] = [];
  const mintInfos = new Map<string, AccountInfo<Buffer> | null>();
  let read = 0;
  let skipped = 0;
  while (read < addresses.length && verifiedTokens.length + verifiedBuffers.length < limit) {
    // Never read more candidates than could fit if all of them are eligible.
    const remaining = limit - verifiedTokens.length - verifiedBuffers.length;
    const chunk = addresses.slice(read, read + Math.min(RPC_BATCH_SIZE, remaining));
    const infos = await connection.getMultipleAccountsInfo(chunk, 'confirmed');
    if (infos.length !== chunk.length) throw new Error('INCOMPLETE_RPC_RESPONSE');
    const missingMints = new Set<string>();
    for (let i = 0; i < infos.length && read + i < tokens.length; i++) {
      const target = tokens[read + i];
      if (infos[i]?.owner.equals(TOKEN_2022_PROGRAM_ID) && isEmptyWalletTokenAccount(infos[i], wallet, target) && !mintInfos.has(target.mintKey)) {
        missingMints.add(target.mintKey);
      }
    }
    if (missingMints.size > 0) {
      const keys = [...missingMints];
      const mints = await connection.getMultipleAccountsInfo(keys.map(key => new PublicKey(key)), 'confirmed');
      if (mints.length !== keys.length) throw new Error('INCOMPLETE_RPC_RESPONSE');
      keys.forEach((key, i) => mintInfos.set(key, mints[i]));
    }
    for (let i = 0; i < infos.length; i++) {
      const index = read + i;
      if (index < tokens.length) {
        const token = tokens[index];
        const info = infos[i];
        if (isEmptyWalletTokenAccount(info, wallet, token) && info &&
          (!info.owner.equals(TOKEN_2022_PROGRAM_ID) || hasSupportedToken2022State(info, mintInfos.get(token.mintKey) ?? null))) {
          verifiedTokens.push({ ...token, lamports: info.lamports, amountUi: 0, isFrozen: false });
        } else {
          skipped++;
        }
      } else if (isWalletBuffer(infos[i], wallet)) {
        verifiedBuffers.push({ ...buffers[index - tokens.length], lamports: infos[i]!.lamports });
      } else {
        skipped++;
      }
    }
    read += chunk.length;
  }

  return {
    tokens: verifiedTokens,
    buffers: verifiedBuffers,
    skipped,
    omitted: addresses.length - read,
  };
}

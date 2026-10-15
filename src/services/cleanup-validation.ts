import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { TokenAccountInfo, BufferAccountInfo } from './scanner.js';
import { SPL_TOKEN_PROGRAM_ID } from './transaction.js';
import { BPF_LOADER_UPGRADEABLE } from '../constants.js';

const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(BPF_LOADER_UPGRADEABLE);
const TOKEN_ACCOUNT_SIZE = 165;
const BUFFER_HEADER_SIZE = 37;
const RPC_BATCH_SIZE = 100;

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
 * Token-2022 extensions follow the 165-byte base and are not inspected here.
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
  if (!owner.equals(wallet) || mint.toBase58() !== expected.mintKey) return false;
  if (closeAuthorityTag === 1) {
    const closeAuthority = new PublicKey(data.subarray(133, 165));
    if (!closeAuthority.equals(wallet)) return false;
  }
  return true;
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
 * Re-read every cleanup target from RPC and keep only accounts the legacy
 * program can close for this wallet. These are snapshot checks: legacy
 * instructions do not bind amounts atomically, so balances can still change
 * between this read and execution. RPC errors propagate to the caller.
 */
export async function inspectCleanupTargets(
  connection: CleanupRpc,
  wallet: PublicKey,
  tokens: TokenAccountInfo[],
  buffers: BufferAccountInfo[],
): Promise<{
  tokens: TokenAccountInfo[];
  buffers: BufferAccountInfo[];
  skipped: number;
}> {
  const addresses = [
    ...tokens.map((token) => new PublicKey(token.pubKey)),
    ...buffers.map((buffer) => new PublicKey(buffer.pubkey)),
  ];
  const reads: Promise<(AccountInfo<Buffer> | null)[]>[] = [];
  for (let i = 0; i < addresses.length; i += RPC_BATCH_SIZE) {
    reads.push(
      connection.getMultipleAccountsInfo(
        addresses.slice(i, i + RPC_BATCH_SIZE),
        'confirmed',
      ),
    );
  }
  const infos = (await Promise.all(reads)).flat();
  if (infos.length !== addresses.length) {
    throw new Error('INCOMPLETE_RPC_RESPONSE');
  }

  const verifiedTokens = tokens
    .filter((token, i) => isEmptyWalletTokenAccount(infos[i], wallet, token))
    .map((token) => ({ ...token, amountUi: 0, isFrozen: false }));
  const verifiedBuffers = buffers.filter((_, i) =>
    isWalletBuffer(infos[tokens.length + i], wallet),
  );

  return {
    tokens: verifiedTokens,
    buffers: verifiedBuffers,
    skipped: addresses.length - verifiedTokens.length - verifiedBuffers.length,
  };
}

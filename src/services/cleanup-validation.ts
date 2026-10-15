import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { BPF_LOADER_UPGRADEABLE } from '../constants.js';
import { TokenAccountInfo, BufferAccountInfo } from './scanner.js';
import { ATA_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, NATIVE_MINT, TransactionValidationError } from './transaction.js';

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
/** Local observations reduce backend trust; legacy instructions still cannot
 * enforce these snapshots atomically on-chain. Checked selectors remain required. */
export async function inspectCleanupTargets(
  connection: Pick<Connection, 'getMultipleAccountsInfo'>,
  wallet: PublicKey,
  tokens: TokenAccountInfo[],
  buffers: BufferAccountInfo[],
  explicitTokenAccounts: string[] = [],
): Promise<{ tokens: TokenAccountInfo[]; buffers: BufferAccountInfo[]; skippedTokenCount: number }> {
  const addresses = [...tokens.map(t => t.pubKey), ...buffers.map(b => b.pubkey)];
  if (addresses.length > 256 || new Set(addresses).size !== addresses.length) throw new TransactionValidationError('Invalid or duplicate cleanup targets');
  const infos: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    infos.push(...await connection.getMultipleAccountsInfo(addresses.slice(i, i + 100).map(a => new PublicKey(a)), 'confirmed'));
  }
  const verifiedTokens = tokens.map<TokenAccountInfo | null>((token, index) => {
    try {
      const account = infos[index];
      if (!account || account.executable || !Number.isSafeInteger(account.lamports) || account.lamports < 0 ||
          (!account.owner.equals(SPL_TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022)) || account.data.length < 165) {
        throw new TransactionValidationError('Invalid token account');
      }
      const data = account.data;
      const mint = new PublicKey(data.subarray(0, 32));
      const owner = new PublicKey(data.subarray(32, 64));
      const amount = data.readBigUInt64LE(64);
      const nativeOption = data.readUInt32LE(109);
      const closeOption = data.readUInt32LE(129);
      if (data[108] !== 1 || !owner.equals(wallet) || !mint.equals(new PublicKey(token.mintKey)) ||
          account.owner.toBase58() !== token.programOwnerId || closeOption > 1 || nativeOption > 1 ||
          (closeOption === 1 && !new PublicKey(data.subarray(133, 165)).equals(wallet))) {
        throw new TransactionValidationError('Token mint, owner, program, state, or close authority mismatch');
      }
      // The legacy program can charge wrapped principal as a fee. Do not offer
      // native accounts through that selector, even if the cached amount is zero.
      if (nativeOption === 1 || mint.equals(NATIVE_MINT)) throw new TransactionValidationError('Wrapped SOL cleanup requires the checked program release; use the dedicated unwrap flow.');
      const [ata] = PublicKey.findProgramAddressSync([wallet.toBuffer(), account.owner.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
      if (!explicitTokenAccounts.includes(token.pubKey) && (amount !== 0n || !ata.equals(new PublicKey(token.pubKey)))) {
        throw new TransactionValidationError('Only empty canonical ATAs are automatic; select other token accounts explicitly.');
      }
      return { ...token, amountBaseUnits: amount.toString(), lamports: account.lamports, isNative: false };
    } catch (err) {
      if (err instanceof TransactionValidationError && !explicitTokenAccounts.includes(token.pubKey)) return null;
      throw err;
    }
  }).filter((token): token is TokenAccountInfo => token !== null);
  const verifiedBuffers = buffers.map((buffer, index) => {
    const account = infos[tokens.length + index];
    if (!account || account.executable || !Number.isSafeInteger(account.lamports) || account.lamports < 0 ||
        account.owner.toBase58() !== BPF_LOADER_UPGRADEABLE || account.data.length < 37 ||
        account.data.readUInt32LE(0) !== 1 || account.data[4] !== 1 ||
        !new PublicKey(account.data.subarray(5, 37)).equals(wallet)) {
      throw new TransactionValidationError('Invalid buffer owner, state, or authority');
    }
    return { ...buffer, authority: wallet.toBase58(), lamports: account.lamports, dataLength: account.data.length };
  });
  return { tokens: verifiedTokens, buffers: verifiedBuffers, skippedTokenCount: tokens.length - verifiedTokens.length };
}

import { AccountInfo, Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, NATIVE_MINT, USDC_MINT,
  PUMP_CLAIM_CASHBACK, PUMP_COLLECT_CREATOR_FEE, PUMP_CLAIM_CASHBACK_V2, PUMP_COLLECT_CREATOR_FEE_V2,
  PUMPSWAP_COLLECT_COIN_CREATOR_FEE, CLOSE_ACCUMULATOR, INIT_ACCUMULATOR,
  derivePda, deriveAta, TransactionValidationError } from './transaction.js';

type RewardRpc = Pick<Connection, 'getMultipleAccountsInfo' | 'getMinimumBalanceForRentExemption'>;
/** Call after structural validation. Caps apply per transaction, only to the
 * locally derived sources actually claimed. Missing accounts contribute zero. */
export async function verifyRewardFees(connection: RewardRpc, transactions: Transaction[], wallet: PublicKey): Promise<void> {
  const keys = new Map<string, PublicKey>();
  for (const tx of transactions) for (const ix of tx.instructions) for (const meta of ix.keys) keys.set(meta.pubkey.toBase58(), meta.pubkey);
  if (keys.size > 256) throw new TransactionValidationError('Too many reward accounts');
  const addresses = [...keys.values()];
  const accounts = new Map<string, AccountInfo<Buffer> | null>();
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100);
    const values = await connection.getMultipleAccountsInfo(batch, 'confirmed');
    batch.forEach((key, index) => accounts.set(key.toBase58(), values[index]));
  }
  const seen = new Set<string>();
  const rentCache = new Map<number, bigint>();
  const info = (key: PublicKey) => accounts.get(key.toBase58());
  const lamports = (account: AccountInfo<Buffer>) => {
    if (!Number.isSafeInteger(account.lamports) || account.lamports < 0 || account.executable) throw new TransactionValidationError('Invalid reward account lamports');
    return BigInt(account.lamports);
  };
  const reserve = async (account: AccountInfo<Buffer>) => {
    if (!rentCache.has(account.data.length)) {
      const value = await connection.getMinimumBalanceForRentExemption(account.data.length, 'confirmed');
      if (!Number.isSafeInteger(value) || value < 0) throw new TransactionValidationError('Invalid reward rent reserve');
      rentCache.set(account.data.length, BigInt(value));
    }
    return rentCache.get(account.data.length)!;
  };
  const mark = (key: PublicKey, kind: string) => {
    const id = `${key.toBase58()}:${kind}`;
    if (seen.has(id)) throw new TransactionValidationError('Duplicate reward claim source');
    seen.add(id);
  };
  const nativeValue = async (key: PublicKey, owner: PublicKey, allowSystemVault = false) => {
    mark(key, 'native');
    const account = info(key);
    if (!account) return 0n;
    if (!account.owner.equals(owner) && !(allowSystemVault && account.owner.equals(SystemProgram.programId) && account.data.length === 0)) throw new TransactionValidationError('Invalid reward source owner');
    const gross = lamports(account), rent = await reserve(account);
    return gross > rent ? gross - rent : 0n;
  };
  const tokenValue = (owner: PublicKey, mint: PublicKey) => {
    const address = deriveAta(owner, mint);
    mark(address, 'token');
    const account = info(address);
    if (!account) return 0n;
    if (account.executable || !account.owner.equals(SPL_TOKEN_PROGRAM_ID) || account.data.length !== 165 || account.data[108] !== 1 ||
        !new PublicKey(account.data.subarray(0, 32)).equals(mint) || !new PublicKey(account.data.subarray(32, 64)).equals(owner)) {
      throw new TransactionValidationError('Invalid reward token source');
    }
    return account.data.readBigUInt64LE(64);
  };
  const consumedNative = new Map<string, bigint>();
  for (const tx of transactions) {
    let native = 0n, usdc = 0n, closeRent = 0n, nativeFee = 0n, usdcFee = 0n;
    const closes: { key: PublicKey; program: PublicKey }[] = [];
    for (const ix of tx.instructions) {
      if (ix.programId.equals(SystemProgram.programId)) nativeFee += ix.data.readBigUInt64LE(4);
      if (ix.programId.equals(SPL_TOKEN_PROGRAM_ID) && ix.data[0] === 12) usdcFee += ix.data.readBigUInt64LE(1);
      const pump = ix.programId.equals(PUMP_PROGRAM_ID), swap = ix.programId.equals(PUMP_AMM_PROGRAM_ID);
      if (!pump && !swap) continue;
      const accumulator = derivePda(['user_volume_accumulator', wallet], ix.programId);
      const creator = derivePda([pump ? 'creator-vault' : 'creator_vault', wallet], ix.programId);
      if (ix.data.equals(INIT_ACCUMULATOR)) continue;
      if (ix.data.equals(CLOSE_ACCUMULATOR)) { mark(accumulator, 'close'); closes.push({key:accumulator,program:ix.programId}); continue; }
      if (pump && (ix.data.equals(PUMP_CLAIM_CASHBACK) || ix.data.equals(PUMP_COLLECT_CREATOR_FEE))) {
        const address = ix.data.equals(PUMP_CLAIM_CASHBACK) ? accumulator : creator;
        const value = await nativeValue(address, ix.programId, address.equals(creator));
        native += value; consumedNative.set(address.toBase58(), value);
      } else {
        let mint: PublicKey, owner: PublicKey;
        if (pump && ix.data.equals(PUMP_CLAIM_CASHBACK_V2)) { mint=ix.keys[2].pubkey; owner=accumulator; }
        else if (pump && ix.data.equals(PUMP_COLLECT_CREATOR_FEE_V2)) { mint=ix.keys[4].pubkey; owner=creator; }
        else if (swap && ix.data.equals(PUMP_CLAIM_CASHBACK)) { mint=ix.keys[2].pubkey; owner=accumulator; }
        else if (swap && ix.data.equals(PUMPSWAP_COLLECT_COIN_CREATOR_FEE)) { mint=ix.keys[0].pubkey; owner=creator; }
        else throw new TransactionValidationError('Unsupported reward instruction');
        const value = tokenValue(owner, mint);
        if (mint.equals(NATIVE_MINT)) native += value;
        else if (mint.equals(USDC_MINT)) usdc += value;
        else throw new TransactionValidationError('Unsupported reward mint');
      }
    }
    for (const {key,program} of closes) {
      const account = info(key);
      if (!account) continue; // A newly initialized accumulator is wallet-funded, not a reward.
      if (!account.owner.equals(program)) throw new TransactionValidationError('Invalid accumulator owner');
      closeRent += lamports(account) - (consumedNative.get(key.toBase58()) ?? 0n);
    }
    const fee = native * 300n / 10_000n;
    const maxNativeFee = (fee > 1_000_000_000n ? 1_000_000_000n : fee) + closeRent * 500n / 10_000n;
    const tokenFee = usdc * 300n / 10_000n;
    const maxUsdcFee = tokenFee > 100_000_000n ? 100_000_000n : tokenFee;
    if (nativeFee > maxNativeFee || usdcFee > maxUsdcFee) throw new TransactionValidationError('Reward fee exceeds locally observed claimable value');
  }
}

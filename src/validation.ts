import { PublicKey } from '@solana/web3.js';

export interface WalletValidationResult {
  pubkey: PublicKey;
  inputWasDomain: boolean;
}

export async function validateWalletAddress(
  input: string,
): Promise<WalletValidationResult> {
  const cleaned = input.trim().replace(/[.,;:!?]+$/, '');

  if (cleaned.includes('.')) {
    const tld = cleaned.split('.').pop()?.toLowerCase();
    if (tld === 'sol' || tld === 'skr') {
      throw new WalletValidationError(
        'Domain resolution not yet implemented. Please use a base58 wallet address.',
      );
    } else {
      throw new WalletValidationError(
        'Unsupported domain. Only .sol and .skr are supported.',
      );
    }
  }

  try {
    const pubkey = new PublicKey(cleaned);
    if (pubkey.toBytes().length !== 32) throw new Error();
    return { pubkey, inputWasDomain: false };
  } catch {
    throw new WalletValidationError(
      'Invalid Solana wallet address. Provide a valid base58 public key.',
    );
  }
}

export function verifyWalletMatchesKeypair(
  walletPubkey: PublicKey,
  keypairPubkey: PublicKey,
): void {
  if (!walletPubkey.equals(keypairPubkey)) {
    throw new WalletValidationError(
      'Wallet address does not match configured keypair.',
    );
  }
}

export class WalletValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletValidationError';
  }
}

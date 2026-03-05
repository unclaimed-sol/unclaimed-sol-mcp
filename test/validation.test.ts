import { describe, it, expect } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
  validateWalletAddress,
  verifyWalletMatchesKeypair,
  WalletValidationError,
} from '../src/validation.js';

describe('validateWalletAddress', () => {
  const VALID_ADDRESS = 'So11111111111111111111111111111111111111112';

  it('accepts a valid base58 public key', async () => {
    const result = await validateWalletAddress(VALID_ADDRESS);
    expect(result.pubkey).toBeInstanceOf(PublicKey);
    expect(result.inputWasDomain).toBe(false);
  });

  it('trims whitespace', async () => {
    const result = await validateWalletAddress(`  ${VALID_ADDRESS}  `);
    expect(result.pubkey.toBase58()).toBe(VALID_ADDRESS);
  });

  it('strips trailing punctuation', async () => {
    const result = await validateWalletAddress(`${VALID_ADDRESS}.`);
    expect(result.pubkey.toBase58()).toBe(VALID_ADDRESS);

    const result2 = await validateWalletAddress(`${VALID_ADDRESS}!?`);
    expect(result2.pubkey.toBase58()).toBe(VALID_ADDRESS);
  });

  it('rejects .sol domains with guidance', async () => {
    await expect(validateWalletAddress('example.sol')).rejects.toThrow(
      'Domain resolution not yet implemented',
    );
  });

  it('rejects .skr domains with guidance', async () => {
    await expect(validateWalletAddress('example.skr')).rejects.toThrow(
      'Domain resolution not yet implemented',
    );
  });

  it('rejects unsupported domains', async () => {
    await expect(validateWalletAddress('example.com')).rejects.toThrow(
      'Unsupported domain',
    );
  });

  it('rejects invalid base58 strings', async () => {
    await expect(validateWalletAddress('notavalidaddress')).rejects.toThrow(
      'Invalid Solana wallet address',
    );
  });

  it('rejects empty string', async () => {
    await expect(validateWalletAddress('')).rejects.toThrow(
      WalletValidationError,
    );
  });

  it('accepts a keypair-generated address', async () => {
    const kp = Keypair.generate();
    const result = await validateWalletAddress(kp.publicKey.toBase58());
    expect(result.pubkey.equals(kp.publicKey)).toBe(true);
  });
});

describe('verifyWalletMatchesKeypair', () => {
  it('does not throw when pubkeys match', () => {
    const kp = Keypair.generate();
    expect(() =>
      verifyWalletMatchesKeypair(kp.publicKey, kp.publicKey),
    ).not.toThrow();
  });

  it('throws WalletValidationError when pubkeys differ', () => {
    const kp1 = Keypair.generate();
    const kp2 = Keypair.generate();
    expect(() =>
      verifyWalletMatchesKeypair(kp1.publicKey, kp2.publicKey),
    ).toThrow('does not match configured keypair');
  });
});

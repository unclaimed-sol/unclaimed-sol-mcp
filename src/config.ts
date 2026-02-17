import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import {
  PRIORITY_FEE_MIN,
  PRIORITY_FEE_MAX,
  PRIORITY_FEE_DEFAULT,
  DEFAULT_RPC_URL,
  DEFAULT_API_URL,
  API_URL_ALLOWLIST,
} from './constants.js';

export interface Config {
  apiUrl: string;
  apiKey: string | null;
  keypair: Keypair | null;
  rpcUrl: string;
  priorityFee: number;
  claimEnabled: boolean;
}

export function loadConfig(): Config {
  const apiUrl = process.env.UNCLAIMED_SOL_API_URL || DEFAULT_API_URL;

  const apiKey = process.env.UNCLAIMED_SOL_API_KEY || null;
  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;

  if (
    !rpcUrl.startsWith('https://') &&
    !rpcUrl.startsWith('http://localhost') &&
    !rpcUrl.startsWith('http://127.0.0.1')
  ) {
    console.error('Warning: SOLANA_RPC_URL is not HTTPS. Insecure for mainnet.');
  }

  // Load keypair — SOLANA_KEYPAIR_PATH takes priority
  let keypair: Keypair | null = null;
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
  const privateKey = process.env.SOLANA_PRIVATE_KEY;

  if (keypairPath) {
    try {
      const resolved = keypairPath.startsWith('~')
        ? path.join(process.env.HOME || '', keypairPath.slice(1))
        : keypairPath;
      const fileContent = fs.readFileSync(resolved, 'utf-8');
      const secretKey = Uint8Array.from(JSON.parse(fileContent));
      keypair = Keypair.fromSecretKey(secretKey);
    } catch (err) {
      throw new Error(
        `Failed to load keypair from SOLANA_KEYPAIR_PATH: ${(err as Error).message}`,
      );
    }
  } else if (privateKey) {
    console.error(
      'Warning: Using SOLANA_PRIVATE_KEY. For better security, use SOLANA_KEYPAIR_PATH instead.',
    );
    try {
      const trimmed = privateKey.trim();
      const secretKey = trimmed.startsWith('[')
        ? Uint8Array.from(JSON.parse(trimmed))
        : bs58.decode(trimmed);
      keypair = Keypair.fromSecretKey(secretKey);
    } catch (err) {
      throw new Error(
        `Failed to parse SOLANA_PRIVATE_KEY: ${(err as Error).message}`,
      );
    }
  }

  // Priority fee with bounds
  let priorityFee = PRIORITY_FEE_DEFAULT;
  if (process.env.SOLANA_PRIORITY_FEE) {
    const parsed = parseInt(process.env.SOLANA_PRIORITY_FEE, 10);
    if (isNaN(parsed)) {
      console.error('Warning: SOLANA_PRIORITY_FEE invalid. Using default.');
    } else if (parsed > PRIORITY_FEE_MAX) {
      console.error(
        `Warning: SOLANA_PRIORITY_FEE (${parsed}) exceeds max (${PRIORITY_FEE_MAX}). Clamped.`,
      );
      priorityFee = PRIORITY_FEE_MAX;
    } else {
      priorityFee = Math.max(PRIORITY_FEE_MIN, parsed);
    }
  }

  // API URL allowlist + HTTPS enforcement for claim mode
  const claimEnabled = keypair !== null;
  if (claimEnabled) {
    const parsed = new URL(apiUrl);
    if (!API_URL_ALLOWLIST.includes(parsed.hostname)) {
      throw new Error(
        `API URL hostname "${parsed.hostname}" not in allowlist for claim mode. Allowed: ${API_URL_ALLOWLIST.join(', ')}`,
      );
    }
    const isLocal =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLocal) {
      throw new Error(
        'UNCLAIMED_SOL_API_URL must use HTTPS in claim mode (MITM risk). ' +
          'HTTP is only allowed for localhost/127.0.0.1.',
      );
    }
  }

  return { apiUrl, apiKey, keypair, rpcUrl, priorityFee, claimEnabled };
}

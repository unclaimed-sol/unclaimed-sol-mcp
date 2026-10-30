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

const CONFIG_ERROR_MESSAGES = {
  keypairFileUnreadable: 'Cannot read SOLANA_KEYPAIR_PATH; check the file path and permissions.',
  keypairFileInvalid: 'Keypair file is not valid JSON or not a 64-byte secret key.',
  privateKeyInvalid: 'SOLANA_PRIVATE_KEY must contain a valid 64-byte secret key as base58 or a JSON byte array.',
  apiUrlInvalid: 'UNCLAIMED_SOL_API_URL must be a valid URL.',
  apiUrlSensitive: 'UNCLAIMED_SOL_API_URL must not contain credentials, query parameters, or fragments.',
  apiHostDisallowed: 'UNCLAIMED_SOL_API_URL must use unclaimedsol.com unless UNCLAIMED_SOL_ALLOW_DEV_API=true.',
  apiHttpsRequired: 'UNCLAIMED_SOL_API_URL must use HTTPS; local HTTP requires localhost/127.0.0.1 and UNCLAIMED_SOL_ALLOW_DEV_API=true.',
} as const;

/** Only fixed messages may cross the startup logging boundary. */
export class ConfigError extends Error {
  constructor(code: keyof typeof CONFIG_ERROR_MESSAGES) {
    super(CONFIG_ERROR_MESSAGES[code]);
    this.name = 'ConfigError';
  }
}

function keypairFromJson(value: string): Keypair {
  const bytes: unknown = JSON.parse(value);
  if (!Array.isArray(bytes) || bytes.length !== 64 ||
      !bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error('Invalid secret-key byte array');
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
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
    const resolved = keypairPath.startsWith('~')
      ? path.join(process.env.HOME || '', keypairPath.slice(1))
      : keypairPath;
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(resolved, 'utf-8');
    } catch {
      throw new ConfigError('keypairFileUnreadable');
    }
    try {
      keypair = keypairFromJson(fileContent);
    } catch {
      throw new ConfigError('keypairFileInvalid');
    }
  } else if (privateKey) {
    console.error(
      'Warning: Using SOLANA_PRIVATE_KEY. For better security, use SOLANA_KEYPAIR_PATH instead.',
    );
    try {
      const trimmed = privateKey.trim();
      keypair = trimmed.startsWith('[')
        ? keypairFromJson(trimmed)
        : Keypair.fromSecretKey(bs58.decode(trimmed));
    } catch {
      throw new ConfigError('privateKeyInvalid');
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
  if (claimEnabled || apiKey) {
    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new ConfigError('apiUrlInvalid');
    }
    const developmentOverride = process.env.UNCLAIMED_SOL_ALLOW_DEV_API === 'true';
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new ConfigError('apiUrlSensitive');
    }
    if (!developmentOverride && !API_URL_ALLOWLIST.includes(parsed.hostname)) {
      throw new ConfigError('apiHostDisallowed');
    }
    const isLocal =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(developmentOverride && isLocal && parsed.protocol === 'http:')) {
      throw new ConfigError('apiHttpsRequired');
    }
  }

  return { apiUrl, apiKey, keypair, rpcUrl, priorityFee, claimEnabled };
}

/** Never log URL paths, credentials, queries, or fragments. */
export function logHost(value: string): string {
  try { return new URL(value).hostname; } catch { return '[invalid URL]'; }
}

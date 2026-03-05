import {
  PROGRAM_ID as SDK_PROGRAM_ID,
  FEE_RECIPIENT as SDK_FEE_RECIPIENT,
} from '@unclaimedsol/spl-burn-close-sdk';

// Use the program ID and fee recipient directly from the SDK — single source of truth
export const PROGRAM_ID = SDK_PROGRAM_ID.toBase58();
export const FEE_VAULT = SDK_FEE_RECIPIENT.toBase58();

// BPF Loader Upgradeable — needed for buffer close validation
export const BPF_LOADER_UPGRADEABLE =
  'BPFLoaderUpgradeab1e11111111111111111111111';

// API URL allowlist for claim mode
export const API_URL_ALLOWLIST = [
  'unclaimedsol.com',
  'localhost',
  '127.0.0.1',
];

// Expected program IDs for pre-sign validation
export const EXPECTED_PROGRAM_IDS = [
  PROGRAM_ID,
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  '11111111111111111111111111111111', // System Program
  BPF_LOADER_UPGRADEABLE, // BPF Loader (buffers)
  'ComputeBudget111111111111111111111111111111', // Compute Budget
];

// Fee rate caps (basis points, 1 bp = 0.01%).
// Rewards: hardcoded at 15% in backend rewards.ts.
// Stakes: configurable via STAKES_REWARD_FEE env var, defaults to 10%.
// The MCP enforces these as hard ceilings — transactions with higher fees are rejected.
export const REWARDS_FEE_BPS = 1_500; // 15%
export const STAKES_FEE_BPS = 1_000; // 10%

// Priority fee bounds (microlamports per CU)
export const PRIORITY_FEE_MIN = 0;
export const PRIORITY_FEE_MAX = 200_000;
export const PRIORITY_FEE_DEFAULT = 1_000;

// Execution token
export const EXECUTION_TOKEN_TTL_MS = 60_000;
export const MAX_ACTIVE_TOKENS = 50;

// Defaults
export const DEFAULT_MAX_TRANSACTIONS = 10;
export const SCAN_CACHE_TTL_MS = 60_000;
export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
export const DEFAULT_API_URL = 'https://unclaimedsol.com';

// URLs
export const WEBSITE_URL = 'https://unclaimedsol.com';

// Token batching — how many pairs per burn-and-close instruction.
// Each pair adds ~2 accounts (mint + ATA) = ~66 bytes. Legacy tx limit is 1232 bytes
// with ~323 bytes fixed overhead, so max ~13 pairs. Using 12 for safe margin.
export const TOKEN_PAIRS_PER_IX = 12;

// Buffer batching — how many buffers per close instruction.
// Each buffer adds 1 writable account. Safe to batch ~25 per instruction.
export const BUFFERS_PER_IX = 25;

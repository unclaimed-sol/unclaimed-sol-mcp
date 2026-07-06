# Unclaimed SOL MCP

**The first Vibe Claiming MCP server — let your AI agent scan and reclaim dormant SOL on Solana.**

[![npm version](https://img.shields.io/npm/v/%40unclaimed-sol%2Fmcp)](https://www.npmjs.com/package/@unclaimed-sol/mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40unclaimed-sol%2Fmcp)](https://www.npmjs.com/package/@unclaimed-sol/mcp)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/unclaimed-sol/unclaimed-sol-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/unclaimed-sol/unclaimed-sol-mcp/actions/workflows/ci.yml)

Unclaimed SOL MCP — the first Vibe Claiming MCP server. One server, six reclaim categories: dormant token accounts (incl. Token-2022), spam NFTs, program buffers, deactivated stakes, DeFi rewards, and excess lamports. Read-only scanning with zero config; claiming with dry-run previews, 60-second single-use execution tokens, and local signing. Your keypair never leaves your machine. No seed phrases, ever.

MCP server for [UnclaimedSOL](https://unclaimedsol.com) — works with AI agents and assistants (Claude, Cursor, Windsurf, Codex CLI, and any [Model Context Protocol](https://modelcontextprotocol.io) client).

See also:

- [Security model](./SECURITY.md)
- [Changelog](./CHANGELOG.md)
- [npm package](https://www.npmjs.com/package/@unclaimed-sol/mcp)
- [UnclaimedSOL website](https://unclaimedsol.com)

## Why agents use this

- **Earn, don't just spend** — Solana agents pay network fees, but wallets can also hold reclaimable SOL in old accounts, buffers, stakes, and rewards.
- **Safe by default** — read-only scan mode works with zero config; claiming requires a dry run and a 60-second single-use execution token.
- **Local signing** — no seed phrases, program allowlist validation, and fee caps before transactions are signed.
- **Agent-ready** — works in Claude Desktop/Code, Cursor, Windsurf, Codex CLI, and other MCP clients.

## Coverage

Coverage as of July 2026:

| Capability | Typical token-account cleaners | Unclaimed SOL MCP |
|---|---|---|
| Dormant token accounts | Yes | Yes, including Token-2022 |
| Spam NFTs | Sometimes | Yes |
| Program buffers | Rare | Yes |
| Deactivated stakes | Rare | Yes |
| DeFi rewards | Rare | Yes |
| Excess lamports | Rare | Yes |
| Read-only scan mode zero config | Sometimes | Yes |
| Keypair-file option | Sometimes | Yes, via `SOLANA_KEYPAIR_PATH` |

## What it does

Solana wallets accumulate rent-locked SOL in dormant token accounts (including Token-2022), spam NFTs, program buffer accounts, deactivated stakes, DeFi rewards, and excess lamports. This MCP server lets AI agents and assistants:

- **Scan** any wallet to check for reclaimable SOL in dormant token accounts and program buffers.
- **Claim** (Vibe Claiming) — burn worthless token balances, close dormant accounts, and reclaim the rent SOL. Signs and broadcasts transactions locally via the UnclaimedSOL on-chain program. Token cleanup lets users keep up to 0.002 SOL per closed account; buffers use a 5% fee.
- **Claim rewards** — claim uncollected DeFi rewards (cashback, creator fees, etc.). Pump/PumpSwap are 3% capped at 1 SOL or 100 USDC; other rewards are 15%.
- **Claim stakes** — claim SOL from deactivated stake accounts. 3% fee.

### Fees

| Category | Fee |
|---|---:|
| Scanning | Free |
| Token cleanup | User keeps up to 0.002 SOL per closed account |
| Program buffers | 5% |
| DeFi rewards | 15% general |
| Pump/PumpSwap rewards | 3%, capped at 1 SOL / 100 USDC |
| Deactivated stakes | 3% |

No funds pass through the MCP server.

## Tools

### `scan_claimable_sol`

**Annotation title:** Scan Wallet for Claimable SOL

Scan a wallet for SOL locked in dormant token accounts (incl. Token-2022) and program buffer accounts. Read-only — no transactions, no keypair needed. DeFi rewards and deactivated stakes are discovered through the `claim_rewards` and `claim_stakes` dry runs.

**Input:** `wallet_address` (base58 public key; optional in claim-enabled mode, defaults to configured keypair wallet)

### `claim_sol`

**Annotation title:** Claim Dormant SOL (Vibe Claiming)

Claim reclaimable SOL. Requires a configured keypair. Uses a two-step flow:

1. **Dry run** (default) — shows a breakdown of reclaimable accounts, estimated SOL, fee, and transaction count. Returns a one-time `execution_token` valid for 60 seconds.
2. **Execute** — call again with `dry_run: false` and the `execution_token` to sign and broadcast.

**Inputs:** `wallet_address` (optional in claim-enabled mode, defaults to configured keypair wallet), `dry_run` (default true), `execution_token`, `max_transactions` (default 10), `exclude` (optional token symbols/names to skip on execute)

This action is irreversible — closed accounts cannot be recovered.

### `claim_rewards`

**Annotation title:** Claim DeFi Rewards

Claim uncollected DeFi rewards (cashback, creator fees, and more). Requires a configured keypair. Uses the same two-step dry-run/execute flow as `claim_sol`. Pump/PumpSwap are 3% capped at 1 SOL or 100 USDC; other rewards are 15%.

**Inputs:** `wallet_address` (optional in claim-enabled mode, defaults to configured keypair wallet), `dry_run` (default true), `execution_token`

### `claim_stakes`

**Annotation title:** Claim Deactivated Stakes

Claim SOL from deactivated stake accounts. Requires a configured keypair. Uses the same two-step dry-run/execute flow. Optionally pass specific stake account addresses to claim.

**Inputs:** `wallet_address` (optional in claim-enabled mode, defaults to configured keypair wallet), `dry_run` (default true), `execution_token`, `stake_accounts` (optional array)

## Example prompts

- "Scan my wallet for reclaimable SOL"
- "How much SOL can I reclaim?"
- "Do a dry run to see what I can claim"
- "Claim my dormant token accounts"
- "Claim rewards for my wallet"
- "Claim my deactivated stakes"
- "How much SOL can I reclaim from `<wallet_address>`?"
- "Scan `<wallet_address>` for reclaimable SOL"
- "Every morning, scan my wallet and tell me if there's more than 0.05 SOL to reclaim"
- "Dry-run a full claim and show me the fee breakdown before executing"
- "Claim everything except my BONK accounts"

## Setup

### Prerequisites

- Node.js 18+
- npm

### Quick install (recommended)

No clone/build required if your MCP client supports package commands:

```bash
npx -y @unclaimed-sol/mcp
```

### Install and build (alternative)

```bash
git clone https://github.com/unclaimed-sol/unclaimed-sol-mcp.git && cd unclaimed-sol-mcp
npm install
npm run build
```

## Configuration

### Vibe Claiming mode (recommended)

All tools are exposed (`scan_claimable_sol`, `claim_sol`, `claim_rewards`, `claim_stakes`). Transactions are signed locally with your keypair and broadcast to the Solana network.

### For Claude Desktop / Cursor / Windsurf

Using npm package (recommended):

```json
{
  "mcpServers": {
    "unclaimed-sol": {
      "command": "npx",
      "args": ["-y", "@unclaimed-sol/mcp"],
      "env": {
        "SOLANA_KEYPAIR_PATH": "~/.config/solana/id.json",
        "SOLANA_RPC_URL": "https://your-rpc-provider.com"
      }
    }
  }
}
```

Using local build:

```json
{
  "mcpServers": {
    "unclaimed-sol": {
      "command": "node",
      "args": ["/absolute/path/to/unclaimed-sol-mcp/dist/index.js"],
      "env": {
        "SOLANA_KEYPAIR_PATH": "~/.config/solana/id.json",
        "SOLANA_RPC_URL": "https://your-rpc-provider.com"
      }
    }
  }
}
```

### For Claude Code

Using npm package (recommended):

```bash
claude mcp add unclaimed-sol \
  -e SOLANA_KEYPAIR_PATH=~/.config/solana/id.json \
  -e SOLANA_RPC_URL=https://your-rpc-provider.com \
  -- npx -y @unclaimed-sol/mcp
```

Using local build:

```bash
claude mcp add unclaimed-sol \
  -e SOLANA_KEYPAIR_PATH=~/.config/solana/id.json \
  -e SOLANA_RPC_URL=https://your-rpc-provider.com \
  -- node /absolute/path/to/unclaimed-sol-mcp/dist/index.js
```

### For Codex CLI

Using npm package (recommended):

```bash
codex mcp add unclaimed-sol \
  --env SOLANA_KEYPAIR_PATH=~/.config/solana/id.json \
  --env SOLANA_RPC_URL=https://your-rpc-provider.com \
  -- npx -y @unclaimed-sol/mcp
```

Using local build:

```bash
codex mcp add unclaimed-sol \
  --env SOLANA_KEYPAIR_PATH=~/.config/solana/id.json \
  --env SOLANA_RPC_URL=https://your-rpc-provider.com \
  -- node /absolute/path/to/unclaimed-sol-mcp/dist/index.js
```

### Optional scan-only mode (no keypair)

Only the `scan_claimable_sol` tool is exposed. No transactions are signed or sent.

Using npm package:

```json
{
  "mcpServers": {
    "unclaimed-sol": {
      "command": "npx",
      "args": ["-y", "@unclaimed-sol/mcp"]
    }
  }
}
```

Using local build:

```json
{
  "mcpServers": {
    "unclaimed-sol": {
      "command": "node",
      "args": ["/absolute/path/to/unclaimed-sol-mcp/dist/index.js"]
    }
  }
}
```

## Verify installation

- Claude Code: `claude mcp list` and confirm `unclaimed-sol` is present.
- Codex CLI: `codex mcp list` and confirm `unclaimed-sol` is present.
- Smoke test: ask your assistant to run `scan wallet <your_wallet>` and confirm `scan_claimable_sol` executes.

## Troubleshooting

- If tools do not appear, restart your MCP client after config changes.
- If using local build, ensure `dist/index.js` exists (`npm run build`) and path is absolute.
- If claim tools are missing, confirm `SOLANA_KEYPAIR_PATH` (or `SOLANA_PRIVATE_KEY`) is set.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `UNCLAIMED_SOL_API_URL` | No | Backend API URL. Defaults to `https://unclaimedsol.com`. |
| `UNCLAIMED_SOL_API_KEY` | No | API key sent as `Authorization: Bearer` header. |
| `SOLANA_KEYPAIR_PATH` | No | Path to Solana keypair JSON file. Enables Vibe Claiming. |
| `SOLANA_PRIVATE_KEY` | No | Private key as base58 string or JSON byte array. Use `SOLANA_KEYPAIR_PATH` instead when possible. |
| `SOLANA_RPC_URL` | No | Solana RPC endpoint. Defaults to `https://api.mainnet-beta.solana.com`. A dedicated RPC is recommended for claiming. |
| `SOLANA_PRIORITY_FEE` | No | Priority fee in microlamports per compute unit. Default: 1,000. Max: 200,000. |

## Security

- **HTTPS enforced** — Claim mode requires HTTPS for the API URL (HTTP only allowed for localhost).
- **API URL allowlist** — Claim mode only connects to `unclaimedsol.com`, `localhost`, or `127.0.0.1`.
- **Pre-sign validation** — Every transaction is validated before signing: program allowlist, exact instruction account layouts pinned to locally-derived PDAs, fee cap enforcement, and per-transaction claim requirement. For stakes, fee caps are derived from proven on-chain withdraw amounts. For rewards, fee caps are cross-checked against an independent scan (see trust model below).
- **Execution tokens** — Claims require a dry run first. Tokens are single-use, single-wallet, and expire in 60 seconds.
- **Keypair stays local** — Your private key never leaves your machine. Transactions are signed locally.
- **Safety filtering** — Token accounts are filtered server-side (`maxClaimMode: false`) to exclude valuable tokens and NFTs. Frozen accounts are skipped.
- **Request timeouts** — All API calls have a 15-second timeout.

## How claiming works

### Token/buffer claims (`claim_sol`)

1. The MCP server calls the UnclaimedSOL backend to fetch reclaimable token and buffer accounts.
2. Instructions are built using the [`@unclaimedsol/spl-burn-close-sdk`](https://www.npmjs.com/package/@unclaimedsol/spl-burn-close-sdk) — token balances are burned and accounts are closed via the UnclaimedSOL on-chain program.
3. Transactions are signed locally with your keypair and broadcast to the Solana network.
4. The on-chain program collects recovered token-account rent above 0.002 SOL per successfully closed account, plus 5% for buffers. No funds pass through the MCP server.

### Rewards claims (`claim_rewards`)

1. The backend builds unsigned transactions containing DeFi reward claim instructions and a fee transfer.
2. The MCP validates every instruction: exact account layouts, discriminators, and locally-derived PDAs. Fee is capped at 15% of an independently-scanned reward total, while Pump/PumpSwap pricing is expected to be lower.
3. Transactions are signed locally and broadcast.

### Stake claims (`claim_stakes`)

1. The backend builds unsigned transactions containing Stake Withdraw instructions and a fee transfer.
2. The MCP validates every instruction: withdraw-only, exact account counts, and fee capped at 3% of proven withdraw amounts extracted from instruction data.
3. Transactions are signed locally and broadcast.

## Validator trust model

The pre-sign validator (`validateTransactionPrograms`) provides different levels of protection depending on the claim type:

- **`claim_sol`** — Instructions are built locally using the SDK. The validator checks program IDs and fee vault presence.
- **`claim_stakes`** — **Full value-level safety.** Withdraw amounts are proven from Stake instruction data. The fee cap is locally derived and does not depend on any backend-reported value.
- **`claim_rewards`** — **Structural safety.** DeFi reward claim amounts are determined on-chain at execution time and are not encoded in instruction data. The fee cap is cross-checked against an independent `/scan` call, which protects against accidental drift between backend endpoints but not against a fully compromised backend.

In all cases: instruction shapes are pinned exactly (every account position verified against locally-derived PDAs, exact account counts, known discriminators only).

## Project structure

```
src/
  index.ts              MCP server entry point (stdio transport)
  constants.ts          Program IDs, fee vault, fee caps, batching limits
  config.ts             Environment variable loading and validation
  validation.ts         Wallet address validation
  formatter.ts          SOL display formatting
  cache.ts              In-memory scan cache (60s TTL)
  execution-token-store.ts  Generic two-step dry-run/execute token management
  tools/
    scan.ts             scan_claimable_sol tool handler
    claim.ts            claim_sol tool handler (tokens + buffers)
    claim-rewards.ts    claim_rewards tool handler (DeFi rewards)
    claim-stakes.ts     claim_stakes tool handler (deactivated stakes)
  services/
    scanner.ts          Backend API client (scan, tokens, buffers, rewards, stakes)
    transaction.ts      Transaction building + pre-sign validation
    signer.ts           Batch sign, send, confirm with retry
```

## License

MIT

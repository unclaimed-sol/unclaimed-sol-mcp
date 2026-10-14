# Unclaimed SOL MCP

**The first Vibe Claiming MCP server — let your AI agent scan and reclaim dormant SOL on Solana.**

[![npm version](https://img.shields.io/npm/v/%40unclaimed-sol%2Fmcp)](https://www.npmjs.com/package/@unclaimed-sol/mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40unclaimed-sol%2Fmcp)](https://www.npmjs.com/package/@unclaimed-sol/mcp)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/unclaimed-sol/unclaimed-sol-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/unclaimed-sol/unclaimed-sol-mcp/actions/workflows/ci.yml)

Unclaimed SOL MCP — the first Vibe Claiming MCP server. Reclaim categories: dormant token accounts (incl. Token-2022), spam NFTs, program buffers, deactivated stakes, DeFi rewards. Read-only scanning with zero config; claiming with dry-run previews, 60-second single-use execution tokens, and local signing. Your keypair never leaves your machine. No seed phrases, ever.

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
| Read-only scan mode zero config | Sometimes | Yes |
| Keypair-file option | Sometimes | Yes, via `SOLANA_KEYPAIR_PATH` |

## What it does

Solana wallets accumulate rent-locked SOL in dormant token accounts (including Token-2022), spam NFTs, program buffer accounts, deactivated stakes, DeFi rewards. This MCP server lets AI agents and assistants:

- **Scan** any wallet to check for reclaimable SOL in dormant token accounts and program buffers.
- **Claim** (Vibe Claiming) — preview explicitly selected token balances and buffers, and empty canonical token accounts. Cleanup execution is unavailable until checked on-chain instructions and SDK builders are deployed. Token cleanup lets users keep up to 0.002 SOL per closed account; buffers use a 5% fee.
- **Claim rewards** — claim uncollected DeFi rewards (cashback, creator fees, etc.). Only Pump/PumpSwap reward execution is supported, at 3% capped at 1 SOL or 100 USDC.
- **Claim stakes** — claim SOL from deactivated stake accounts. 3% fee.

### Fees

| Category | Fee |
|---|---:|
| Scanning | Free |
| Token cleanup | User keeps up to 0.002 SOL per closed account |
| Program buffers | 5% |
| Pump/PumpSwap rewards | 3%, capped at 1 SOL / 100 USDC |
| Deactivated stakes | 3% |

No funds pass through the MCP server.

## Tools

### `scan_claimable_sol`

**Annotation title:** Scan Wallet for Claimable SOL

Scan a wallet for SOL locked in dormant token accounts (incl. Token-2022) and program buffer accounts. Read-only — no transactions, no keypair needed. DeFi rewards and deactivated stakes are discovered through the `claim_rewards` and `claim_stakes` dry runs.

**Inputs:** `wallet_address` (base58 public key; optional in claim-enabled mode, defaults to configured keypair wallet), `include_explicit_candidates` (default false; lists positive token accounts and buffers as non-automatic candidates)

### `claim_sol`

**Annotation title:** Preview Dormant SOL

Shows locally verified accounts, estimated recovery, fees and transaction count. Requires a configured keypair but does not sign or submit anything. No execution token or approval objects are issued.

**Inputs:** `wallet_address` (defaults to configured keypair wallet), `dry_run` (default true), `max_transactions` (default 10, maximum 25), `exclude` (symbols/names), `token_accounts` and `buffer_accounts` (optional exact address selections). Only empty canonical ATAs are automatic; positive tokens and buffers require explicit selection. Wrapped SOL is excluded.

`dry_run: false` returns `CHECKED_CLEANUP_UNAVAILABLE` immediately. Safe cleanup execution needs checked instructions in the program and matching SDK builders; the currently published SDK 1.3.0 does not provide them.

### `claim_rewards`

**Annotation title:** Claim DeFi Rewards

Claim uncollected DeFi rewards (cashback, creator fees, and more). Requires a configured keypair. Uses the same two-step dry-run/execute flow as `claim_sol`. Only Pump/PumpSwap reward execution is supported, at 3% capped at 1 SOL or 100 USDC.

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
npx -y @unclaimed-sol/mcp@1.3.1
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
      "args": ["-y", "@unclaimed-sol/mcp@1.3.1"],
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
  -- npx -y @unclaimed-sol/mcp@1.3.1
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
  -- npx -y @unclaimed-sol/mcp@1.3.1
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
      "args": ["-y", "@unclaimed-sol/mcp@1.3.1"]
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

- **HTTPS enforced** — Signing or configuring an API key requires HTTPS and the production API host.
- **API URL allowlist** — The production host is `unclaimedsol.com`. `UNCLAIMED_SOL_ALLOW_DEV_API=true` permits custom HTTPS hosts and local HTTP for development.
- **Pre-sign validation** — Every transaction is validated before signing: program allowlist, exact instruction account layouts pinned to locally-derived PDAs, fee cap enforcement, and per-transaction claim requirement. For stakes, fee caps use bigint withdrawal amounts and the configured RPC verifies account state and full-withdrawal simulation. For Pump/PumpSwap rewards, fee caps also use locally derived accounts and live RPC balances with integer arithmetic.
- **Execution tokens** — Claims require a dry run first. Tokens are consumed atomically before execution network calls, are single-wallet, and expire in 60 seconds. Failed or uncertain attempts require a fresh dry run.
- **Keypair stays local** — Your private key never leaves your machine. Transactions are signed locally.
- **Safety filtering** — Automatic cleanup previews require locally verified empty canonical ATAs. Positive balances and buffers are explicit candidates, never automatically selected. Frozen accounts are skipped.
- **Request bounds** — Scans time out after 15 seconds; builds after 30 seconds. Responses are limited to 1 MiB, target arrays to 256, and batches to 25 transactions of at most 1,232 serialized bytes. The scan cache retains at most 256 entries.

## How claiming works

Program ID: `UNCaXzXkR3vp8mbCJyxWUvwuRk5uHgzrwe6jcWPfiUR` (from the pinned SDK).

### Token/buffer claims (`claim_sol`)

1. The MCP server calls the UnclaimedSOL backend to fetch reclaimable token and buffer accounts.
2. Instructions are built using the [`@unclaimedsol/spl-burn-close-sdk`](https://www.npmjs.com/package/@unclaimedsol/spl-burn-close-sdk) to estimate transaction count and fees; these instructions are never signed.
3. Cleanup previews remain available, but execution fails closed because SDK 1.3.0 only builds legacy selectors.
4. The current program source charges the greater of 2% of recovered token-account lamports or the amount above 0.002 SOL, plus 5% for buffers. Verify the deployed binary before changing fee policy. No funds pass through the MCP server.

### Rewards claims (`claim_rewards`)

1. The backend builds unsigned transactions containing DeFi reward claim instructions and a fee transfer.
2. The MCP validates instruction layouts, discriminators, and locally-derived PDAs. Builds explicitly request Pump/PumpSwap only. The configured RPC independently supplies source balances and rent reserves for native SOL and USDC fee caps. Backend totals are additional cross-checks.
3. Transactions are signed locally and broadcast.

### Stake claims (`claim_stakes`)

1. The backend builds unsigned transactions containing Stake Withdraw instructions and a fee transfer.
2. The MCP validates every instruction: withdraw-only, exact account counts, and fee capped at 3% of proven withdraw amounts extracted from instruction data.
3. Transactions are signed locally and broadcast.

## Validator trust model

The pre-sign validator (`validateTransactionPrograms`) provides different levels of protection depending on the claim type:

- **`claim_sol`** — Preview targets are independently decoded through RPC, including authority, mint, balance and buffer state. Execution is blocked until checked on-chain instructions and SDK builders exist.
- **`claim_stakes`** — Withdraw amounts are checked against live account balances, wallet withdrawal authority, lockup, sysvars, and full-withdrawal simulation during preview and execution. Fee arithmetic uses bigint.
- **`claim_rewards`** — Pump/PumpSwap only. Discriminators and account addresses are checked against locally derived PDAs/ATAs. Native SOL and USDC service fees are capped using live source balances, rent reserves and integer arithmetic at preview and execution.

RPC reads are snapshots, not atomic on-chain assertions. Reward balances may change before execution; a fee bounded by the last observed reward is not a guarantee of realized proceeds. Checked cleanup selectors must enforce expected amounts atomically before cleanup execution can be enabled. The backend currently has an unversioned contract; MCP rejects any advertised contract version until its schema is implemented. See [SECURITY.md](SECURITY.md) for upstream acceptance criteria.

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

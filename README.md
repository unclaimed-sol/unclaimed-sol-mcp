# Unclaimed SOL MCP

**The first Vibe Claiming MCP server — let your AI agent scan and reclaim dormant SOL on Solana.**

[![npm version](https://img.shields.io/npm/v/%40unclaimed-sol%2Fmcp)](https://www.npmjs.com/package/@unclaimed-sol/mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40unclaimed-sol%2Fmcp)](https://www.npmjs.com/package/@unclaimed-sol/mcp)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/unclaimed-sol/unclaimed-sol-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/unclaimed-sol/unclaimed-sol-mcp/actions/workflows/ci.yml)

Unclaimed SOL MCP — the first Vibe Claiming MCP server. Reclaim categories: dormant token accounts (incl. Token-2022), program buffers, deactivated stakes, DeFi rewards. Read-only scanning with zero config; claiming with dry-run previews, 60-second single-use execution tokens, and local signing. Your keypair never leaves your machine. No seed phrases, ever.

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
| Program buffers | Rare | Yes |
| Deactivated stakes | Rare | Yes |
| Pump/PumpSwap rewards | Rare | Yes |
| Read-only scan mode zero config | Sometimes | Yes |
| Keypair-file option | Sometimes | Yes, via `SOLANA_KEYPAIR_PATH` |

## What it does

Solana wallets accumulate rent-locked SOL in dormant token accounts (including Token-2022), program buffer accounts, deactivated stakes, DeFi rewards. This MCP server lets AI agents and assistants:

- **Scan** any wallet to check for reclaimable SOL in dormant token accounts and program buffers.
- **Claim** (Vibe Claiming) — preview backend-selected token and buffer accounts, then sign and submit locally using a single-use execution token. Token cleanup lets users keep up to 0.002 SOL per closed account; buffers use a 5% fee.
- **Claim rewards** — claim uncollected DeFi rewards (cashback, creator fees, etc.). Only Pump/PumpSwap reward execution is supported, at 3% capped at 1 SOL or 100 USDC.
- **Claim stakes** — claim SOL from deactivated stake accounts. 3% fee.

### Fees

| Category | Fee |
|---|---:|
| Scanning | Free |
| Token cleanup | User keeps up to 0.002 SOL per closed account |
| Program buffers | 5% |
| Pump/PumpSwap accumulator rent close | 5% |
| Pump/PumpSwap rewards | 3%, capped at 1 SOL / 100 USDC |
| Deactivated stakes | 3% |

No funds pass through the MCP server.

## Tools

### `scan_claimable_sol`

**Annotation title:** Scan Wallet for Claimable SOL

Scan a wallet for SOL locked in dormant token accounts (incl. Token-2022) and program buffer accounts. Read-only — no transactions, no keypair needed. DeFi rewards and deactivated stakes are discovered through the `claim_rewards` and `claim_stakes` dry runs.

**Inputs:** `wallet_address` (base58 public key; optional in claim-enabled mode, defaults to configured keypair wallet)

### `claim_sol`

**Annotation title:** Claim Dormant SOL (Vibe Claiming)

Closes empty token accounts and program buffers to reclaim rent. A dry run checks backend safe-mode candidates through the configured RPC and shows eligible accounts, estimated recovery, fees and transaction count. It returns a 60-second single-use `execution_token`. Call with `dry_run: false` and that token to sign and submit locally.

**Inputs:** `wallet_address` (defaults to configured keypair wallet), `dry_run` (default true), `execution_token`, `max_transactions` (default 10, maximum 25), `exclude` (optional symbols/names to skip during execution).

Cleanup targets are revalidated via RPC before signing. Token cleanup uses SDK 1.4.0's close-empty instruction (selector 2), which checks eligibility during execution and never burns tokens. Accounts receiving new token deposits or newly funded wrapped SOL are skipped at execution. Empty wrapped SOL is accepted only when its lamports equal its recorded native reserve; funded and unsynchronized WSOL are skipped. There is no fallback to legacy burning.

Token-2022 support follows the program's conservative extension set: token accounts may have `ImmutableOwner` and/or `TransferFeeAmount`; mints may have `TransferFeeConfig`. Transfer-fee extensions must match. Other extensions, including metadata extensions, are skipped before the 256-eligible-account preview limit. The execution simulation must provide a complete, attributable cleanup summary; an all-skipped transaction is not submitted. Accounts can still change after simulation, so a confirmed transaction does not guarantee every target closed. Previews are estimates, and reported wallet balance changes include network fees and concurrent activity. Buffers retain their existing close instruction and authority checks.

### `claim_rewards`

**Annotation title:** Claim DeFi Rewards

Claim uncollected DeFi rewards (cashback, creator fees, and more). Requires a configured keypair. A dry run returns a 60-second single-use `execution_token`; `dry_run: false` with that token executes the claim. Only Pump/PumpSwap reward execution is supported, at 3% capped at 1 SOL or 100 USDC.

**Inputs:** `wallet_address` (optional in claim-enabled mode, defaults to configured keypair wallet), `dry_run` (default true), `execution_token`

### `claim_stakes`

**Annotation title:** Claim Deactivated Stakes

Claim SOL from deactivated stake accounts. Requires a configured keypair. Uses the same two-step dry-run/execute flow. Optionally pass specific stake account addresses to claim.

**Inputs:** `wallet_address` (optional in claim-enabled mode, defaults to configured keypair wallet), `dry_run` (default true), `execution_token`, `stake_accounts` (optional array)

When `stake_accounts` is supplied for a dry run, the backend must build exactly that set or the preview fails. Leave out accounts that are still deactivating or otherwise cannot be withdrawn. Execution uses the set saved with the execution token; changing `stake_accounts` requires a new dry run.

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

- Node.js 20+
- npm

### Release status

Version **2.0.0** requires Node.js 20 or newer. The package commands below install the latest published release. To use a local checkout instead, run `npm ci`, `npm run build`, and point your MCP client at `node dist/index.js`.

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
| `SOLANA_RPC_URL` | No | Solana RPC endpoint. Defaults to `https://api.mainnet-beta.solana.com`. Claim dry runs read account state, including Token-2022 mints, and simulate stake withdrawals. Token cleanup is also simulated before submission, so a dedicated RPC is strongly recommended for claiming. |
| `SOLANA_PRIORITY_FEE` | No | Priority fee in microlamports per compute unit. Default: 1,000. Max: 200,000. |

## Security

- **HTTPS enforced** — Signing or configuring an API key requires HTTPS and the production API host.
- **API URL allowlist** — The production host is `unclaimedsol.com`. `UNCLAIMED_SOL_ALLOW_DEV_API=true` permits custom HTTPS hosts and local HTTP for development.
- **Pre-sign validation** — Every transaction is validated before signing: program allowlist, exact instruction account layouts pinned to locally-derived PDAs, fee cap enforcement, and per-transaction claim requirement. For stakes, fee caps use bigint withdrawal amounts and the configured RPC verifies account state and full-withdrawal simulation. For Pump/PumpSwap rewards, fee caps also use locally derived accounts and live RPC balances with integer arithmetic.
- **Execution tokens** — Claims require a dry run first. Tokens are consumed atomically before execution network calls, are single-wallet, and expire in 60 seconds. Failed or uncertain attempts require a fresh dry run.
- **Keypair stays local** — Your private key never leaves your machine. Transactions are signed locally.
- **Safety filtering** — Cleanup requests backend safe-mode candidates (`maxClaimMode: false`), independently checks their state and authority via RPC, and revalidates the previewed targets before signing. Ineligible targets are skipped and counted; RPC failures abort the request.
- **Request bounds** — Scans time out after 15 seconds; builds after 30 seconds. Responses are limited to 1 MiB, and batches to 25 transactions of at most 1,232 serialized bytes. Cleanup previews validate candidates in order and stop at 256 eligible accounts per dry run. The scan cache retains at most 256 entries.

## How claiming works

Program ID: `UNCaXzXkR3vp8mbCJyxWUvwuRk5uHgzrwe6jcWPfiUR` (from the pinned SDK).

### Token/buffer claims (`claim_sol`)

1. The MCP server calls the UnclaimedSOL backend to fetch reclaimable token and buffer accounts.
2. Token instructions use `buildCloseEmptyTokenAccountsInstruction` from pinned [`@unclaimedsol/spl-burn-close-sdk` 1.4.0](https://www.npmjs.com/package/@unclaimedsol/spl-burn-close-sdk). Buffer instructions are built locally using their existing selector 1.
3. Execution atomically consumes the token before network calls, revalidates targets and instructions, simulates token cleanup, and signs each transaction immediately before its first send. A rejected or unverified simulation is not submitted; there is no legacy retry.
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

- **`claim_sol`** — Discovery and estimates use the backend safe-mode response. RPC checks require empty token accounts with the expected mint, program, wallet owner, close authority, native reserve and supported Token-2022 extensions, or loader-owned buffers with wallet authority. All previewed targets are revalidated before signing. Transactions are built locally; pre-sign validation rejects legacy token cleanup selector 0 and direct token burns. Selector 2 enforces token eligibility during execution. Buffers continue to use selector 1.
- **`claim_stakes`** — Withdraw amounts are checked against live account balances, wallet withdrawal authority, lockup, sysvars, and full-withdrawal simulation during preview and execution. Fee arithmetic uses bigint.
- **`claim_rewards`** — Pump/PumpSwap only. Discriminators and account addresses are checked against locally derived PDAs/ATAs. Native SOL and USDC service fees are capped using live source balances, rent reserves and integer arithmetic at preview and execution.

RPC reads and simulations are snapshots. Selector 2 prevents burning newly deposited tokens and closing funded WSOL, but does not guarantee exact proceeds, account counts or buffer-content approvals. Reward balances may change before execution; a fee bounded by the last observed reward is not a guarantee of realized proceeds. See [SECURITY.md](SECURITY.md) for the trust assumptions.

The configured cluster must have selector 2 deployed. Mainnet program bytes were verified on 2026-10-30 against Rust commit `1f2b10a` and SBF SHA-256 `40c9eb68c0a6e835d8789e87da2aa5f67b9cb18498814078b75e2129b44054aa`. The [deployment verification record and remaining release check](https://github.com/unclaimed-sol/unclaimed-sol-mcp/blob/c3d9a9adad21ee44accaf45e38eba5c987e8b0d5/docs/verification/2026-10-30-upstream.md) preserve the evidence. This is a dated deployment check, not runtime attestation of future upgrades.

## Local cleanup integration test

After `npm ci`, run `npm run test:cleanup-runtime -- /path/to/unclaimed-sol-rust-program`. This requires `solana-test-validator` and the reviewed Rust SBF artifact. It uses an isolated local ledger and generated test keys, exercises MCP preview/build/sign/send against both token programs, and checks late deposits, exact fees and all-skipped submissions. No production wallet or funds are used. Unit tests run with `npm test`.

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
    cleanup-validation.ts  RPC eligibility and bounded candidate selection
    cleanup-extensions.ts  Supported Token-2022 extension filter
    cleanup-simulation.ts  Attributed close-empty simulation summaries
    signer.ts           Simulate cleanup, sign, send once, and confirm
```

## License

MIT

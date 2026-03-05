# @unclaimed-sol/mcp

MCP server for [UnclaimedSOL](https://unclaimedsol.com) — scan and reclaim dormant SOL from Solana wallets directly from AI assistants like Claude, ChatGPT, and others that support the [Model Context Protocol](https://modelcontextprotocol.io).

## What it does

Solana wallets accumulate rent-locked SOL in dormant token accounts (zero-balance ATAs) and program buffer accounts. This MCP server lets AI assistants:

- **Scan** any wallet to check for reclaimable SOL
- **Claim** (Vibe Claiming) — burn worthless token balances, close dormant accounts, and reclaim the rent SOL. Signs and broadcasts transactions locally via the UnclaimedSOL on-chain program. A 5% service fee applies.
- **Claim rewards** — claim uncollected DeFi rewards (cashback, creator fees, etc.). 15% fee.
- **Claim stakes** — claim SOL from deactivated stake accounts. 10% fee.

## Tools

### `scan_claimable_sol`

Check how much SOL a wallet can reclaim. Read-only — no transactions, no keypair needed.

**Input:** `wallet_address` (base58 public key; optional in claim-enabled mode, defaults to configured keypair wallet)

### `claim_sol`

Claim reclaimable SOL. Requires a configured keypair. Uses a two-step flow:

1. **Dry run** (default) — shows a breakdown of reclaimable accounts, estimated SOL, fee, and transaction count. Returns a one-time `execution_token` valid for 60 seconds.
2. **Execute** — call again with `dry_run: false` and the `execution_token` to sign and broadcast.

**Inputs:** `wallet_address` (optional in claim-enabled mode, defaults to configured keypair wallet), `dry_run` (default true), `execution_token`, `max_transactions` (default 10), `exclude` (optional token symbols/names to skip on execute)

This action is irreversible — closed accounts cannot be recovered.

### `claim_rewards`

Claim uncollected DeFi rewards (cashback, creator fees, and more). Requires a configured keypair. Uses the same two-step dry-run/execute flow as `claim_sol`. A 15% service fee applies.

**Inputs:** `wallet_address` (optional in claim-enabled mode, defaults to configured keypair wallet), `dry_run` (default true), `execution_token`

### `claim_stakes`

Claim SOL from deactivated stake accounts. Requires a configured keypair. Uses the same two-step dry-run/execute flow. Optionally pass specific stake account addresses to claim.

**Inputs:** `wallet_address` (optional in claim-enabled mode, defaults to configured keypair wallet), `dry_run` (default true), `execution_token`, `stake_accounts` (optional array)

## Setup

### Prerequisites

- Node.js 18+
- npm

### Install and build

```bash
git clone https://github.com/unclaimed-sol/unclaimed-sol-mcp.git && cd unclaimed-sol-mcp
npm install
npm run build
```

## Configuration

### Scan-only mode (no keypair)

Only the `scan_claimable_sol` tool is exposed. No transactions are signed or sent.

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "unclaimed-sol": {
      "command": "node",
      "args": ["/absolute/path/to/unclaimed-sol-mcp/dist/index.js"],
    }
  }
}
```

### Vibe Claiming mode (with keypair)

All tools are exposed (`scan_claimable_sol`, `claim_sol`, `claim_rewards`, `claim_stakes`). Transactions are signed locally with your keypair and broadcast to the Solana network.

### For Claude Desktop / Cursor / Windsurf

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

```bash
# Scan only
claude mcp add unclaimed-sol \
  -- node /absolute/path/to/unclaimed-sol-mcp/dist/index.js

# Scan + Vibe Claiming
claude mcp add unclaimed-sol \
  -e SOLANA_KEYPAIR_PATH=~/.config/solana/id.json \
  -e SOLANA_RPC_URL=https://your-rpc-provider.com \
  -- node /absolute/path/to/unclaimed-sol-mcp/dist/index.js
```

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
4. A 5% service fee is collected on-chain by the program. No funds pass through the MCP server.

### Rewards claims (`claim_rewards`)

1. The backend builds unsigned transactions containing DeFi reward claim instructions and a fee transfer.
2. The MCP validates every instruction: exact account layouts, discriminators, and locally-derived PDAs. Fee is capped at 15% of an independently-scanned reward total.
3. Transactions are signed locally and broadcast.

### Stake claims (`claim_stakes`)

1. The backend builds unsigned transactions containing Stake Withdraw instructions and a fee transfer.
2. The MCP validates every instruction: withdraw-only, exact account counts, and fee capped at 10% of proven withdraw amounts extracted from instruction data.
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

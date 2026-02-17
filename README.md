# @unclaimed-sol/mcp

MCP server for [UnclaimedSOL](https://unclaimedsol.com) — scan and reclaim dormant SOL from Solana wallets directly from AI assistants like Claude, ChatGPT, and others that support the [Model Context Protocol](https://modelcontextprotocol.io).

## What it does

Solana wallets accumulate rent-locked SOL in dormant token accounts (zero-balance ATAs) and program buffer accounts. This MCP server lets AI assistants:

- **Scan** any wallet to check for reclaimable SOL
- **Claim** (Vibe Claiming) — burn worthless token balances, close dormant accounts, and reclaim the rent SOL. Signs and broadcasts transactions locally via the UnclaimedSOL on-chain program. A 5% service fee applies.

## Tools

### `scan_claimable_sol`

Check how much SOL a wallet can reclaim. Read-only — no transactions, no keypair needed.

**Input:** `wallet_address` (base58 public key)

### `claim_sol`

Claim reclaimable SOL. Requires a configured keypair. Uses a two-step flow:

1. **Dry run** (default) — shows a breakdown of reclaimable accounts, estimated SOL, fee, and transaction count. Returns a one-time `execution_token` valid for 60 seconds.
2. **Execute** — call again with `dry_run: false` and the `execution_token` to sign and broadcast.

**Inputs:** `wallet_address`, `dry_run` (default true), `execution_token`, `max_transactions` (default 10)

This action is irreversible — closed accounts cannot be recovered.

## Setup

### Prerequisites

- Node.js 18+
- npm

### Install and build

```bash
git clone <repo-url> && cd unclaimed-sol-mcp
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

Both `scan_claimable_sol` and `claim_sol` tools are exposed. Transactions are signed locally with your keypair and broadcast to the Solana network.

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
- **Pre-sign validation** — Every transaction is validated before signing: only expected program IDs, fee vault presence verified, no SOL transfers to unknown accounts.
- **Execution tokens** — Claims require a dry run first. Tokens are single-use, single-wallet, and expire in 60 seconds.
- **Keypair stays local** — Your private key never leaves your machine. Transactions are signed locally.
- **Safety filtering** — Token accounts are filtered server-side (`maxClaimMode: false`) to exclude valuable tokens and NFTs. Frozen accounts are skipped.
- **Request timeouts** — All API calls have a 15-second timeout.

## How claiming works

1. The MCP server calls the UnclaimedSOL backend to fetch reclaimable token and buffer accounts.
2. Instructions are built using the [`@unclaimedsol/spl-burn-close-sdk`](https://www.npmjs.com/package/@unclaimedsol/spl-burn-close-sdk) — token balances are burned and accounts are closed via the UnclaimedSOL on-chain program.
3. Transactions are signed locally with your keypair and broadcast to the Solana network.
4. A 5% service fee is collected on-chain by the program. No funds pass through the MCP server.

Stake account claims are not supported via MCP — use [unclaimedsol.com](https://unclaimedsol.com) for those.

## Project structure

```
src/
  index.ts              MCP server entry point (stdio transport)
  constants.ts          Program IDs, fee vault, batching limits
  config.ts             Environment variable loading and validation
  validation.ts         Wallet address validation
  formatter.ts          SOL display formatting
  cache.ts              In-memory scan cache (60s TTL)
  tools/
    scan.ts             scan_claimable_sol tool handler
    claim.ts            claim_sol tool handler + execution token management
  services/
    scanner.ts          Backend API client
    transaction.ts      Transaction building + pre-sign validation
    signer.ts           Batch sign, send, confirm with retry
```

## License

MIT

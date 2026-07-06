# How Your Solana Agent Can Earn Extra SOL by Integrating One MCP

July 2026

AI agents are getting good at spending SOL. They pay priority fees, rebalance wallets, execute swaps, mint assets, manage positions, and keep workflows moving. Almost none of them reclaim what the wallet already owns.

That leaves a simple opportunity: give the agent a safe way to find dormant SOL and, when the owner approves, reclaim it. Unclaimed SOL MCP is built for that job. It is an MCP server for agents and assistants that scan Solana wallets for claimable SOL, run dry-run previews, and execute claims with local signing.

Unclaimed SOL MCP — the first Vibe Claiming MCP server. One server, six reclaim categories: dormant token accounts (incl. Token-2022), spam NFTs, program buffers, deactivated stakes, DeFi rewards, and excess lamports. Read-only scanning with zero config; claiming with dry-run previews, 60-second single-use execution tokens, and local signing. Your keypair never leaves your machine. No seed phrases, ever.

## Rent-Locked SOL

Solana accounts carry rent. When a wallet accumulates old token accounts, spam NFTs, unused program buffers, and inactive stake accounts, some SOL can remain locked in places the owner no longer needs. Individually these amounts may look small. Across active wallets, bot wallets, trading wallets, and old DeFi wallets, they can add up.

Most agents see wallet balances and recent transactions. They do not automatically inspect the full reclaim surface. That means they can spend SOL for work while ignoring SOL that is already available to recover.

## Six Reclaim Categories

Coverage as of July 2026 includes six categories from one MCP server:

| Category | What the agent can do |
|---|---|
| Dormant token accounts | Find and close unused token accounts, including Token-2022 accounts |
| Spam NFTs | Burn worthless token balances and reclaim account rent where safe |
| Program buffers | Close reclaimable buffer accounts |
| Deactivated stakes | Dry-run and claim withdrawable stake accounts |
| DeFi rewards | Dry-run and claim uncollected cashback, creator fees, and related rewards |
| Excess lamports | Surface extra reclaimable SOL where supported |

Scan mode is read-only and requires no keypair. Claim mode uses Vibe Claiming: the agent shows a dry-run plan, receives a short-lived execution token, and only then can execute with local signing.

## Three-Step Integration

First, add the MCP server to the agent runtime:

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

Second, ask the agent to scan:

```text
Scan my wallet and tell me if there is more than 0.05 SOL to reclaim.
```

Third, if the owner wants to proceed, ask for a dry run before execution:

```text
Dry-run a full claim and show me the fee breakdown before executing.
```

The agent can also apply filters, such as:

```text
Claim everything except my BONK accounts.
```

## Safety Model

The server is designed for local custody. `scan_claimable_sol` is read-only and works without any keypair. Claim tools require a configured keypair path, build or validate transactions locally, and use a two-step dry-run flow.

Every claim starts with `dry_run: true`. The dry run returns a plan and a single-use execution token that expires in 60 seconds. Execution requires calling the same tool again with `dry_run: false` and that token. The server signs locally. The keypair never leaves the machine running the MCP server.

It also never asks for or accepts seed phrases. The recommended configuration is `SOLANA_KEYPAIR_PATH`, which points to a standard Solana keypair JSON file. A private key environment variable is supported for compatibility, but the keypair file path is preferred.

Before signing, transactions are checked against known program IDs and fee caps. Token and buffer claims use the UnclaimedSOL on-chain program. Rewards and stakes use additional validation paths, including fee cap checks and instruction-shape validation.

## Fees

| Category | Fee |
|---|---:|
| Scanning | Free |
| Token cleanup | User keeps up to 0.002 SOL per closed account |
| Program buffers | 5% |
| DeFi rewards | 15% general |
| Pump/PumpSwap rewards | 3%, capped at 1 SOL / 100 USDC |
| Deactivated stakes | 3% |

No funds pass through the MCP server. Claiming happens through signed Solana transactions, with collection enforced on-chain or validated before signing.

## Why This Fits Agents

Agents are best when they can turn routine maintenance into a repeatable workflow. A wallet owner can ask for a daily scan, a threshold-based alert, or a dry-run report before claiming. A trading or operations agent can include reclaim checks as part of wallet hygiene.

The integration is small: one MCP server, four tools, and standard stdio transport. The result is an agent that does not only spend SOL to operate, but can also help recover dormant SOL the wallet already controls.

Start with the npm package at `@unclaimed-sol/mcp`, or visit https://unclaimedsol.com for the web app and product details.

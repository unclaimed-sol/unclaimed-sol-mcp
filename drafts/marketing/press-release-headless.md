# UnclaimedSOL Goes Headless: Vibe Claiming Comes to AI Agents Everywhere

July 2026

UnclaimedSOL today announced Unclaimed SOL MCP, an MCP server that lets AI agents and assistants scan and reclaim dormant SOL on Solana through local signing workflows.

Unclaimed SOL MCP is the first Vibe Claiming MCP server. Dated as of July 2026, it offers the broadest reclaim surface for Solana agents from one MCP server: dormant token accounts, spam NFTs, program buffers, deactivated stakes, DeFi rewards, and excess lamports.

The server exposes four tools:

- `scan_claimable_sol` — read-only wallet scan for dormant token accounts and program buffers.
- `claim_sol` — Vibe Claiming for dormant token accounts, spam NFTs, and program buffers.
- `claim_rewards` — dry-run and claim DeFi rewards such as cashback and creator fees.
- `claim_stakes` — dry-run and claim deactivated stake accounts.

Safety is built into the flow. Scan mode is read-only and needs no keypair. Claiming requires a dry-run preview and a single-use execution token that expires in 60 seconds. Transactions are signed locally, the keypair never leaves the user's machine, and the server never asks for or accepts seed phrases. Program allowlists and fee caps are checked before signing.

[QUOTE PLACEHOLDER]

Unclaimed SOL MCP is available now through npm:

```bash
npx -y @unclaimed-sol/mcp
```

The project is MIT licensed and available on GitHub at https://github.com/unclaimed-sol/unclaimed-sol-mcp.

Fees are transparent: scanning is free; token cleanup lets the user keep up to 0.002 SOL per closed account; program buffers are 5%; DeFi rewards are 15% general; Pump/PumpSwap rewards are 3% capped at 1 SOL / 100 USDC; deactivated stakes are 3%.

## About UnclaimedSOL

UnclaimedSOL helps Solana users find and reclaim dormant SOL across token accounts, spam NFTs, program buffers, deactivated stakes, DeFi rewards, and excess lamports. The web app is available at https://unclaimedsol.com.

[CONTACT]

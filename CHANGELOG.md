# Changelog

## 1.3.1 - 2026-08-28

- Recognize common Solana blockhash-expiry responses and rebuild/re-sign transactions with a fresh blockhash.
- Keep unrelated errors and unknown-outcome confirmation timeouts non-retryable.

## 1.3.0 - 2026-07-06

- Add MCP tool annotations for scan, token/buffer claims, DeFi rewards, and deactivated stake claims.
- Report the real package version at server startup instead of the stale hardcoded 1.0.0 value.
- Clarify tool descriptions for scan coverage and claim routing.
- Add npm package metadata for homepage, bugs, author, and keywords.
- Add `server.json` for MCP registry submission.
- Add GitHub Actions CI for Node.js 18, 20, and 22.
- Reposition the README around the first Vibe Claiming MCP server.
- Add a SECURITY note that the server never asks for or accepts seed phrases.

## 1.2.5 - 2026-06-17

- Lowered fees: Pump/PumpSwap rewards are 3% capped at 1 SOL or 100 USDC, and stakes are 3%.

## 1.2.4 - 2026-03-05

- Updated package metadata and MCP registry name.
- Added Glama configuration.

## 1.2.3 - 2026-03-05

- Updated package metadata.

## 1.2.2 - 2026-03-05

- Release maintenance for package metadata.

## 1.2.1 - 2026-03-05

- Improved README install and configuration guides.
- Added MIT license and security model documentation.

## 1.2.0 - 2026-03-05

- Added scoped token exclusions.
- Added safe-vs-max scan upsell behavior.
- Added regression tests.

## 1.1.0 - 2026-03-05

- Added `claim_rewards` and `claim_stakes`.
- Hardened transaction validation.
- Added the Vitest suite.

## 1.0.0 - 2026-02-18

- Initial Unclaimed SOL MCP server release.

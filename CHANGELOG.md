# Changelog

## 2.0.0 - Unreleased

- Migration from 1.x: dust token accounts with a positive balance are now skipped as ineligible instead of being burned.
- Report specific, sanitized startup configuration errors without exposing key material, file paths or endpoint URLs. Use RPC-read balances for cleanup preview estimates.
- Require Node.js 20 or newer; signing/API-key configurations now require the production HTTPS host unless the development override is explicitly enabled.
- Preserve token/buffer cleanup's dry-run and execution-token flow and exclusions. Use SDK 1.4.0's selector 2 for token cleanup, enforcing empty balances at execution without burning or falling back to selector 0. Buffer selector 1 is unchanged.
- Revalidate targets at preview and execution, including native reserves and supported Token-2022 account/mint extensions before applying the eligible-account limit. Skip funded and unsynchronized WSOL.
- Simulate standalone token cleanup before signing; do not submit all-skipped, rejected or unverified simulations. Report transaction targets and observed wallet balance changes without promising exact closures or proceeds.
- Upgrade Zod to 4.6.7 and refresh compatible transitive dependencies to resolve new high-severity audit findings; retain the documented web3.js/Jayson moderate advisories.
- Consume execution tokens atomically, sign each unsent transaction with a fresh blockhash, and never retry an ambiguous submission. Preserve signatures when post-submit balance reads fail.
- Report proven preflight rejections (Transaction simulation failed) as failed and continue with the next transaction; ambiguous send/confirmation errors still stop the batch without retry.
- Allow token-only cleanup previews when buffer discovery reports an expected scanner error, with an explicit unavailable notice. Unexpected buffer errors still fail.
- Repair buffer/stake response compatibility, validate Pump/PumpSwap rewards and stakes with RPC data, and restrict reward execution to supported sources.
- Bound requests, transaction sizes and batches; redact endpoint logs, pin runtime dependencies, and add production-audit CI.
- Validate cleanup candidates in order and stop at 256 eligible accounts per dry run, reporting the unread remainder. Report invalid tool arguments and backend contract mismatches with specific messages.
- Let the RPC rebroadcast identical signed bytes until expiry; local re-signing remains disabled.
- Stake inactivity is established by full-withdrawal simulation only, so a stake deactivated in its activation epoch is claimable immediately.


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

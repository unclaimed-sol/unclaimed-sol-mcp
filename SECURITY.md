# Security

This project is designed as a local-signing MCP server for Solana claims.
The main security boundary is: **transactions are validated locally before signing, and private keys never leave the machine running this MCP server**.

## Security Model

### Trust assumptions

- The machine running this MCP server is trusted.
- The configured Solana keypair is controlled by the user.
- The configured Solana RPC and deployed program are trusted. RPC reads and simulation support token cleanup and stake validation. Token cleanup requires the deployed selector 2 instruction.
- Cleanup discovery and scan estimates come from the backend. Claim previews use RPC-read account balances for estimates. Targets are independently checked via RPC during preview and revalidated before signing: account existence, program, state, mint, wallet ownership/authority, and zero balance for token accounts. Buffers require loader ownership and wallet authority. Reward and stake transactions also receive independent RPC checks.

### Core guarantees

- **Local key custody**: key material is loaded from `SOLANA_KEYPAIR_PATH` or `SOLANA_PRIVATE_KEY` and used only for local signing.
- **No seed phrases**: this server never asks for or accepts a seed phrase/mnemonic. It loads a standard Solana keypair file (`SOLANA_KEYPAIR_PATH`, recommended) or a private key environment variable, and signs locally.
- **No blind signing**: every transaction is validated before signing.
- **Two-step execution for claims**: `dry_run -> execution_token -> execute`.
- **Short-lived, single-wallet execution tokens**: 60s TTL, one active token per wallet, consumed atomically before execution network calls, including failed or ambiguous attempts.
- **Cleanup previews**: a dry run shows RPC-validated accounts and issues a single-use execution token. Ineligible accounts are skipped and counted before the eligible-account limit, including unsupported Token-2022 extensions and funded/unsynchronized WSOL. Empty WSOL must match its recorded native reserve. RPC failures propagate as errors. Exclusions can only reduce the previewed selection.
- **Execution-time token safety**: SDK 1.4.0 builds selector 2, which never burns tokens and skips newly funded accounts at execution. Local validation rejects selector 0 and direct token burns. There is no fallback. Buffer selector 1 remains unchanged.
- **Simulation evidence**: standalone token-cleanup transactions require a complete successful simulation with an attributable program summary before signing. Zero-recovery batches are not submitted. Simulations do not settle earlier submissions or prove future account closures; ambiguous send/confirmation outcomes still stop the batch without retry.
- **Bounded fees and instruction validation**:
  - `claim_sol`: local instruction construction + program allowlist checks.
  - `claim_rewards` and `claim_stakes`: strict structural checks on backend-built transactions, including account layouts, discriminators, claim requirements, and fee caps.

## Threat Model

### Threats mitigated

- Unexpected instruction programs and layouts in backend-built reward/stake transactions.
- Unexpected fee transfers exceeding configured caps.
- Replay or accidental reuse of stale execute intent.
- Wallet mismatch between requested address and configured keypair.

### Threats not fully mitigated

- Compromise of the local machine or local key material.
- Backend omissions or inaccurate estimates, and changes after RPC validation. Token eligibility is enforced on-chain, but previews do not bind exact proceeds or account counts. Buffer balances/content are not atomically approved by the preview. Wallet balance changes can include unrelated activity.
- Reward fee caps use observed balances, not guaranteed realized proceeds.
- Malicious or unstable RPC behavior causing failed or delayed execution.

## Operational Recommendations

- Use a dedicated hot wallet for MCP claiming; avoid storing large balances.
- Keep `SOLANA_KEYPAIR_PATH` permissions strict (`chmod 600` equivalent).
- Prefer a dedicated, reliable RPC endpoint.
- Keep this package updated to latest stable release.
- Review dry-run output before executing irreversible operations.

## Vulnerability Reporting

If you find a security issue, open a private security advisory in the GitHub repository instead of filing a public issue with exploit details.

## Remaining dependency advisories

Reviewed 2026-10-30; owner: MCP repository maintainer (@nedim1511); expires
2026-11-13. Production audit: zero critical/high, five moderate affected packages
(including parent dependency propagation). CI rejects any critical/high finding.

- `stream-json` via `jayson`: GHSA-528h-pc64-c93x, GHSA-hqr4-qq8f-hg3x,
  GHSA-mjw6-4jj6-33hc. Web3 imports `jayson/lib/client/browser`, which uses
  ordinary JSON parsing rather than Jayson's server stream parser. The MCP
  exposes stdio, not a Jayson server. No reachable vulnerable stream path was
  identified in this runtime. This is a scoped code assessment, not proof for
  every package consumer.
- `uuid` via `jayson`: GHSA-w5hq-g745-h8pq concerns v3/v5/v6 buffer writes.
  Jayson's browser client and request generator call v4 without a caller-supplied
  buffer. No affected call was identified.
- `@solana/web3.js` and `@unclaimedsol/spl-burn-close-sdk` inherit these moderate
  findings. npm reports no compatible automatic fix; major transitive overrides
  require a separate compatibility review. Reassess at the expiry above.

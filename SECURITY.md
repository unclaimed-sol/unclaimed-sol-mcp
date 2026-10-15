# Security

This project is designed as a local-signing MCP server for Solana claims.
The main security boundary is: **transactions are validated locally before signing, and private keys never leave the machine running this MCP server**.

## Security Model

### Trust assumptions

- The machine running this MCP server is trusted.
- The configured Solana keypair is controlled by the user.
- The configured Solana RPC and deployed program are trusted. RPC account reads and simulation are part of stake validation.
- Cleanup discovery and estimates come from the backend. Targets are independently checked via RPC during preview and revalidated before signing: account existence, program, state, mint, wallet ownership/authority, and zero balance for canonical token accounts. Buffers require loader ownership and wallet authority. Reward and stake transactions also receive independent RPC checks.

### Core guarantees

- **Local key custody**: key material is loaded from `SOLANA_KEYPAIR_PATH` or `SOLANA_PRIVATE_KEY` and used only for local signing.
- **No seed phrases**: this server never asks for or accepts a seed phrase/mnemonic. It loads a standard Solana keypair file (`SOLANA_KEYPAIR_PATH`, recommended) or a private key environment variable, and signs locally.
- **No blind signing**: every transaction is validated before signing.
- **Two-step execution for claims**: `dry_run -> execution_token -> execute`.
- **Short-lived, single-wallet execution tokens**: 60s TTL, one active token per wallet, consumed atomically before execution network calls, including failed or ambiguous attempts.
- **Cleanup previews**: a dry run shows RPC-validated accounts and issues a single-use execution token. Ineligible accounts are skipped and counted at preview and execution; empty WSOL is accepted and funded WSOL is dropped. RPC failures propagate as errors. Exclusions can only reduce the previewed selection.
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
- Backend omissions or inaccurate estimates, and changes after RPC validation. The legacy cleanup program does not bind amounts atomically; pre-sign checks do not eliminate the race between reading account state and execution.
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

Reviewed 2026-10-14; owner: MCP repository maintainer (@nedim1511); expires
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

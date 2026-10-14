# Security

This project is designed as a local-signing MCP server for Solana claims.
The main security boundary is: **transactions are validated locally before signing, and private keys never leave the machine running this MCP server**.

## Security Model

### Trust assumptions

- The machine running this MCP server is trusted.
- The configured Solana keypair is controlled by the user.
- The configured Solana RPC and deployed program are trusted. RPC account reads and simulation are part of stake validation.
- Backend discovery and build responses are untrusted. Targets and reward fee bases are independently checked with the configured RPC. RPC snapshots cannot provide atomic execution-time amount guarantees.

### Core guarantees

- **Local key custody**: key material is loaded from `SOLANA_KEYPAIR_PATH` or `SOLANA_PRIVATE_KEY` and used only for local signing.
- **No seed phrases**: this server never asks for or accepts a seed phrase/mnemonic. It loads a standard Solana keypair file (`SOLANA_KEYPAIR_PATH`, recommended) or a private key environment variable, and signs locally.
- **No blind signing**: every transaction is validated before signing.
- **Two-step execution for rewards and stakes**: `dry_run -> execution_token -> execute`.
- **Short-lived, single-wallet execution tokens**: 60s TTL, one active token per wallet, consumed atomically before execution network calls, including failed or ambiguous attempts.
- **Explicit cleanup selection**: automatic previews only include empty canonical ATAs; positive tokens and buffers require explicit selection. Previews issue no execution tokens or approval objects. Wrapped SOL is rejected. Cleanup execution is blocked until checked selectors and SDK builders exist.
- **Bounded fees and instruction validation**:
  - `claim_sol`: local instruction construction + program allowlist checks.
  - `claim_rewards` and `claim_stakes`: strict structural checks on backend-built transactions, including account layouts, discriminators, claim requirements, and fee caps.

## Threat Model

### Threats mitigated

- Backend returns unexpected or dangerous instructions.
- Unexpected fee transfers exceeding configured caps.
- Replay or accidental reuse of stale execute intent.
- Wallet mismatch between requested address and configured keypair.

### Threats not fully mitigated

- Compromise of the local machine or local key material.
- Concurrent on-chain state changes after the last RPC read. Cleanup execution fails closed because legacy selectors cannot enforce exact amounts. Reward fee caps use observed balances, not guaranteed realized proceeds.
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

## Upstream handoff (2026-10-14)

No other repository was modified. These are follow-ups, not filed GitHub tickets.

### Required to enable safe MCP cleanup

1. **Rust program:** add checked instructions that reject changed token balances
   or buffer lamports/length atomically. Validate authority and state, preserve
   wrapped SOL principal, and roll back on failed closes or fees. Keep legacy
   instructions for the existing app. Add program tests for the new behavior.
2. **SDK:** expose builders for those checked instructions, with serialized
   transaction size limits. SDK 1.3.0 does not contain these builders. Keep
   existing exports for app compatibility.
3. **MCP:** integrate the checked builders and exact approvals once available,
   verify deployment, and smoke-test before enabling cleanup execution.

An RPC read before signing cannot enforce balances at execution time. This
patch therefore keeps cleanup preview-only; it does not issue unusable tokens
or build a future approval workflow.

### Separate backend improvements — not cleanup prerequisites

- Start with shared response fixtures. A versioned contract with integer-string
  amounts is useful later, but MCP already adapts to the current fields; no
  frontend rewrite or mandatory v2 migration is required for this patch.
- Consolidate stake fees under the shared policy; remove the override that can
  exceed MCP's 3% cap.
- Replace raw wallet/weak IP analytics identifiers with keyed HMAC identifiers;
  omit identifiers when no key is configured. Redact provider URLs and return
  stable public error codes.
- Audit the final production lockfile and assess the app/backend SDK upgrade
  separately. The reviewed locks use SDK 1.2.1; MCP pins 1.3.0.

No package was published, transaction submitted, or deployment changed.

# Security

This project is designed as a local-signing MCP server for Solana claims.
The main security boundary is: **transactions are validated locally before signing, and private keys never leave the machine running this MCP server**.

## Security Model

### Trust assumptions

- The machine running this MCP server is trusted.
- The configured Solana keypair is controlled by the user.
- The Solana RPC endpoint can be untrusted for liveness, but not for signing authority.
- The backend API can be unavailable or malicious; local pre-sign validation is intended to prevent unsafe transaction execution.

### Core guarantees

- **Local key custody**: key material is loaded from `SOLANA_KEYPAIR_PATH` or `SOLANA_PRIVATE_KEY` and used only for local signing.
- **No blind signing**: every transaction is validated before signing.
- **Two-step execution for claims**: `dry_run -> execution_token -> execute`.
- **Short-lived, single-wallet execution tokens**: 60s TTL, one active token per wallet, single-use on success.
- **Safe-mode token scanning** for `claim_sol`: MCP requests claimable token accounts with `maxClaimMode: false`.
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
- Full backend compromise that can consistently lie across multiple related endpoints (especially for dynamic on-chain reward amounts).
- Malicious or unstable RPC behavior causing failed or delayed execution.

## Operational Recommendations

- Use a dedicated hot wallet for MCP claiming; avoid storing large balances.
- Keep `SOLANA_KEYPAIR_PATH` permissions strict (`chmod 600` equivalent).
- Prefer a dedicated, reliable RPC endpoint.
- Keep this package updated to latest stable release.
- Review dry-run output before executing irreversible operations.

## Vulnerability Reporting

If you find a security issue, open a private security advisory in the GitHub repository instead of filing a public issue with exploit details.

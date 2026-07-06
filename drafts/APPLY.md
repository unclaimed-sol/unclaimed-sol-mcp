# Draft Apply Map

Nothing in `drafts/` ships in the npm package. The package `files` list includes only `dist`, and npm always includes the required package metadata and selected root docs.

| Draft file | Destination |
|---|---|
| `drafts/marketing/article-earn-extra-sol.md` | Blog or guest post |
| `drafts/marketing/press-release-headless.md` | Press release draft |
| `drafts/site/llms.txt` | Website root: `/llms.txt` |
| `drafts/site/well-known/mcp/server-card.json` | Website: `/.well-known/mcp/server-card.json` |
| `drafts/site/well-known/agent-skills/index.json` | Website: `/.well-known/agent-skills/index.json` |
| `drafts/site/robots-sitemap-notes.md` | Website/internal deployment checklist |
| `drafts/internal/COMPETITIVE.md` | Internal docs only |

## Launch checklist

- Publish package version 1.3.0.
- Refresh the MCP registry using root `server.json`.
- Deploy site files, then re-run isitagentready.com.
- Publish the article.
- Send the PR.
- Submit or refresh listings on Glama, PulseMCP, mcp.so, Smithery, and devhunt.
- Re-validate the Server Card shape against isitagentready.com at deploy.

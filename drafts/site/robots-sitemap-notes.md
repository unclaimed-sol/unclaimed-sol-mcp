# Agent Readiness Deployment Notes

Checklist from Cloudflare Agent Readiness:

- Serve `/llms.txt`.
- Serve `/.well-known/mcp/server-card.json`.
- Serve `/.well-known/agent-skills/index.json`.
- Update `robots.txt` with a `Sitemap` reference.
- Add AI-agent allow rules to `robots.txt`.
- Add content-signals metadata where the site supports it.
- Publish `sitemap.xml`.
- Add markdown content negotiation for `Accept: text/markdown`.
- Add an RFC 9727 API catalog if the public API is documented.
- Add RFC 8288 `Link` headers for discoverability.
- Re-run isitagentready.com and log the score.

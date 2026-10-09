# 04: Any OAuth remote MCP client via one redirect list

**What to build:** A deployer can connect Kimi web or any other OAuth-capable remote MCP client by appending its callback to `ALLOWED_REDIRECT_URIS`. Allowed CORS origins are derived from the hostnames in that list plus the Worker's own host and localhost, instead of hard-coding Claude and ChatGPT. The default list still covers Claude and ChatGPT.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Test: with a custom entry (e.g. `https://client.example/cb`) appended, dynamic client registration and the full OAuth login succeed for that redirect, and its origin is accepted on `/mcp`.
- [ ] Test: an origin not derived from the list is refused. Redirect matching rules (exact match, or prefix only for entries ending in `/`, no userinfo/fragment) are unchanged and their existing tests pass.
- [ ] Default behavior for Claude and ChatGPT is unchanged (existing oauth tests green).

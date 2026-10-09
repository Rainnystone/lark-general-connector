# 10: (Parked, optional) Live verification on Lark international

**What to build:** Confirm against a real Lark tenant that the `lark` region works on the separate test Worker, and document the result. Covered: OAuth login, the 25 scopes, MCP-backed tools via `mcp.larksuite.com`, and OpenAPI tools. If Lark MCP rejects the proxy's header style or lacks tools, the README's Lark section recommends a specific `TOOL_BACKENDS` value. The code does not change.

**Blocked by:** 02, 05

**Status:** parked: optional, needs a Lark international account (none available today). Nothing blocks on this ticket. Until it is done, Lark ships as beta per ticket 09.

- [ ] Every scope in the code's scope list can be added in the Lark developer console. Any that are missing are listed in the README (the set is not changed).
- [ ] Smoke checklist from ticket 05 run with `FEISHU_REGION=lark` from at least one client. Results recorded without ids or content.
- [ ] README Lark section updated to "live-tested", or to "beta: use this TOOL_BACKENDS value".

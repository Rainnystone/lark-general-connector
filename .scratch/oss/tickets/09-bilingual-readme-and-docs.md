# 09: Bilingual README, disclaimers and generalized CONTEXT

**What to build:** A README (中文 + English) that covers:
- what the connector does and its architecture (unchanged from the private README, de-personalized)
- the Deploy button, the wizard and AGENTS.md
- the config table from SPEC
- region notes: Lark is **beta (supported, not live-tested)**, with the OpenAPI fallback recipe (`TOOL_BACKENDS` with every switchable tool set to `openapi`)
- the kill switch, `TOOL_BACKENDS`, `P2P_DISCOVERY`, re-auth and audit events
- the supported-clients statement ("any OAuth remote MCP client", tested: ChatGPT, Claude)
- the three disclaimers: permissions/admin approval are the deployer's responsibility; the official Feishu MCP may change or be retired; free Cloudflare plan limits apply

CONTEXT.md is de-personalized ("Connector client" = any OAuth MCP client).

**Blocked by:** 02, 03, 04, 06

**Status:** ready-for-agent

- [ ] The README contains no private names, URLs or branch references. The secret scan stays green.
- [ ] Every config name in the README exists in the code, and every var or secret in the code is documented. This is checked by the repo's scan script.
- [ ] Both language sections carry the same facts (reviewer checklist in the PR).

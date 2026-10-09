# 02: One config value switches Feishu China ↔ Lark international

**What to build:** Setting `FEISHU_REGION=lark` makes the whole connector use Lark international: the login redirect goes to `accounts.larksuite.com`, the token exchange goes there too, every OpenAPI call goes to `open.larksuite.com`, and proxied tools go to `mcp.larksuite.com/mcp`. The default `feishu` behaves exactly as today. This is implemented at the single outbound seam: literals and the endpoint allowlist stay canonical, the allowlist is checked first, and the host is rewritten for the region just before fetch. The authorize-URL builder uses the same mapping. Tool modules are not touched.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `FEISHU_REGION` declared as a committed var with default `feishu`, and present in the env type.
- [ ] With `lark`, an end-to-end test covers the OAuth login plus one call each of a proxied tool, a direct OpenAPI tool and delete_doc. Every outbound URL and the authorize `Location` use larksuite hosts, and zero use `feishu.cn`.
- [ ] With the default/`feishu`, the existing suite passes unchanged and a test asserts that no larksuite host is contacted.
- [ ] Any other value fails closed: `/mcp`, `/authorize` and `/callback` answer 503 with a clear "invalid FEISHU_REGION" message, make no outbound call, and write an audit event.
- [ ] Endpoint allowlist dump is unchanged. A test proves that a non-allowlisted path is still refused under `lark` (the rewrite cannot widen the list).
- [ ] No diff in `src/mcp/*` tool modules.

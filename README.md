# lark-general-connector

[中文](./README.zh-CN.md) | English

## What this is

One person deploys this into their own Cloudflare account, against their own Feishu or Lark custom app, and pastes one `/mcp` URL into a connector client. The Worker acts as that one owner. It reads and writes the owner's docs. Contacts and chats are read-only: it never sends messages, and it never creates, updates, or deletes chats. Deleting a doc only moves one cloud-space docx to the recycle bin, and only after the caller confirms the doc's exact title. Wiki docs are never deletable.

Login finishes, and `/mcp` answers, only when the Feishu open_id equals `OWNER_OPEN_ID`. Any other value, including `pending` or a blank, counts as not configured: nobody can connect, and the bootstrap page shows only the caller's own open_id.

## Architecture

The Worker is an OAuth authorization server for connector clients and the MCP resource server at `/mcp`. It is a thin proxy. It does not reimplement Feishu. A proxied tool calls Feishu's remote MCP unless its default or `TOOL_BACKENDS` selects OpenAPI. `search_docs` defaults to OpenAPI. Direct tools always call OpenAPI. The endpoint allowlist is a fixed list of method and path pairs on canonical `*.feishu.cn` hosts. The allowlist is checked before any host rewrite, so a region change cannot add endpoints.

`FEISHU_REGION` selects the hosts. `feishu` means Feishu. `lark` means Lark. Source literals stay on Feishu hosts. Just before fetch, and for the browser authorize redirect, the Worker rewrites:

| Feishu | Lark |
| --- | --- |
| `open.feishu.cn` | `open.larksuite.com` |
| `accounts.feishu.cn` | `accounts.larksuite.com` |
| `mcp.feishu.cn` | `mcp.larksuite.com` |

`OAUTH_KV` stores OAuth state. `FEISHU_TOKENS` is a SQLite Durable Object, class `FeishuTokenStore`, migration `v1`, and holds the owner's Feishu tokens. One invocation may make at most 40 outbound calls. Secrets stay in Cloudflare encrypted secrets. The repo does not contain secret values.

Sixteen tools:

- Docs: `search_docs`, `fetch_doc`, `list_wiki_docs`, `get_doc_comments`, `create_doc`, `update_doc`, `add_doc_comment`, `fetch_doc_media`, `delete_doc`
- People: `whoami`, `get_user`, `search_users`
- Chats, read-only: `list_chats`, `list_chat_messages`, `search_messages`, `get_message`

## How to deploy

Three paths. They share one order, below. Do not follow more than one path in the same session.

**Deploy to Cloudflare.** The button clones this repo into your GitHub account, provisions `OAUTH_KV` and `FEISHU_TOKENS`, prompts for `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `COOKIE_SECRET`, and `OWNER_OPEN_ID` with the descriptions in `package.json`, and lets you edit `FEISHU_REGION`. Deploy runs `wrangler deploy`. The button points at this GitHub repo. It contains no account id, KV id, or Worker hostname.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Rainnystone/lark-general-connector)

**Wizard.** From the repo root, after `npm ci`, run `npm run setup`. The wizard prints 中文 and English and uses only Node, with no extra dependencies. It asks for the region (`feishu` is the default; `lark` is the other valid value), then a Worker name. It runs `wrangler login`. If login fails, it stops and nothing is deployed. If that name already exists in the account, it refuses unless you type the name back. Any other answer stops, and nothing is deployed. It prints the region's console URL and pauses while you create the app. It then asks for `FEISHU_APP_ID` and `FEISHU_APP_SECRET` without echoing them or writing them to a file. It deploys. If deploy fails, it stops and no secrets are written. It generates `COOKIE_SECRET`. `openssl rand -hex 32` produces the same kind of 32-byte secret. It puts the four secrets, with `OWNER_OPEN_ID` set to `pending`. It prints the console URL, the hosts, the exact scope list, and `<origin>/callback`, and pauses while you add the scopes, set the redirect, and publish or request admin approval. It prints the `/mcp` URL and pauses while you connect a client. The bootstrap page denies access and shows only your open_id. It then asks for that open_id, sets `OWNER_OPEN_ID`, and prints the `/mcp` URL again so you can reconnect.

**AGENTS.md.** The same steps, written for a coding agent. Human-only steps tell the agent to stop and wait. The agent must not paste secrets into files, commits, or chat logs.

## Setup order

Create the app, deploy, set the redirect, publish, connect a client, bootstrap login shows the open_id, set `OWNER_OPEN_ID`, reconnect.

`feishu` uses `https://open.feishu.cn/app`. `lark` uses `https://open.larksuite.com/app`. Enable every scope the wizard prints, and no others. The redirect URI is the Worker origin plus `/callback`. The client URL is that origin plus `/mcp`. Enable the Bot capability (机器人) on the custom app before publishing.

## Configuration

| Kind | Name | Default | Notes |
| --- | --- | --- | --- |
| Secret | `FEISHU_APP_ID` | — | Prompted. App ID from the open-platform credentials page. Listed in `.dev.vars.example`. |
| Secret | `FEISHU_APP_SECRET` | — | Prompted. App Secret from the same page. |
| Secret | `COOKIE_SECRET` | — | Prompted. `openssl rand -hex 32`. The wizard generates it. Signs the login cookie. |
| Secret | `OWNER_OPEN_ID` | `pending` | Prompted. A value that is not an open_id (`ou_` plus letters and digits) is not configured. |
| Committed var | `FEISHU_REGION` | `feishu` | `feishu` means Feishu. `lark` means Lark. Any other value returns 503 on every route and sends nothing upstream. |
| Committed var | `PUBLIC_URL` | empty | Empty uses the request's own origin. Set a full origin only to pin a custom domain. |
| Committed var | `ALLOWED_REDIRECT_URIS` | Claude and ChatGPT callbacks | Comma-separated. Append other clients. Allowed CORS hosts are these hostnames, the Worker's own host, and `localhost`. |
| Dashboard var | `MCP_DISABLED` | unset | Kill switch. See below. `keep_vars` retains it. Not prompted. |
| Dashboard var | `TOOL_BACKENDS` | unset | Per-tool `mcp` or `openapi`. See below. `keep_vars` retains it. Not prompted. |
| Dashboard var | `P2P_DISCOVERY` | unset | `auto`, `types_param`, or `search`. See below. `keep_vars` retains it. Not prompted. |
| Binding | `OAUTH_KV` | auto-provisioned | KV namespace. No id in config. |
| Binding | `FEISHU_TOKENS` | Durable Object `FeishuTokenStore`, migration `v1` | Owner token store. |

The committed default of `ALLOWED_REDIRECT_URIS` is `https://claude.ai/api/mcp/auth_callback,https://chatgpt.com/connector_platform_oauth_redirect,https://chatgpt.com/connector/oauth/`.

Dashboard vars are not in `wrangler.jsonc`. A committed var with the same name as a secret would break deploy, so the four secrets are not committed vars either.

## Region

`feishu` is the default and needs no change. Lark is **beta (supported, not live-tested)**. If Lark misbehaves, do not change code. Set `TOOL_BACKENDS` so every switchable tool is `openapi`:

```json
{
  "search_docs": "openapi",
  "fetch_doc": "openapi",
  "list_wiki_docs": "openapi",
  "get_doc_comments": "openapi",
  "create_doc": "openapi",
  "update_doc": "openapi",
  "add_doc_comment": "openapi",
  "get_user": "openapi",
  "search_users": "openapi",
  "fetch_doc_media": "openapi"
}
```

## Kill switch

`MCP_DISABLED` stops tools without a deploy. Only an unset value, an empty string, `0`, or `false` leaves the connector enabled. Any other value blocks `/mcp`, `/authorize`, and `/callback`. `/mcp` returns 503 with the JSON-RPC message `disabled by owner`. The other two paths return the disabled page. The audit event is `killswitch_block`.

## Tool backends

`TOOL_BACKENDS` is a JSON object. Keys are proxied tools. Values are `mcp` or `openapi`. An omitted key uses that tool's default. `search_docs` defaults to `openapi`. These default to `mcp`: `fetch_doc`, `list_wiki_docs`, `get_doc_comments`, `create_doc`, `update_doc`, `add_doc_comment`, `get_user`, `search_users`, `fetch_doc_media`. A value other than `mcp` or `openapi` is invalid: that tool stays on `mcp`, and the Worker logs `tool_backends_invalid`. Invalid JSON keeps every default and logs the same event. These direct tools are OpenAPI only and are not switchable: `whoami`, `delete_doc`, `list_chats`, `list_chat_messages`, `search_messages`, `get_message`.

## P2P discovery

`P2P_DISCOVERY` controls how `list_chats` finds p2p chats. `auto` is the default for an unset, empty, or unknown value: list with the types parameter, then search messages if that list fails or finishes with no p2p chat. `types_param` lists only. `search` discovers p2p chats only by message search. Search can miss chats that have no searchable messages.

## Re-auth

When the Feishu refresh token is dead, the token store marks re-auth required. `/mcp` then returns `invalid_token`. Tools return `Feishu authorization expired; reconnect the connector`. Disconnect the client and connect it again to the same `/mcp` URL. The audit event is `reauth_required`. Refresh attempts log `token_refresh`.

## Audit events

Each audit event is one content-free JSON line in Workers Logs. Events: `auth_ok`, `auth_rejected`, `token_refresh`, `reauth_required`, `killswitch_block`, `invalid_region`, `tool_backends_invalid`, and `tool_call`. `tool_call` records the tool name, a target id, ok, a code, and duration. It does not record document or message text.

## Clients

Any OAuth remote MCP client can connect. Add that client's redirect URI to `ALLOWED_REDIRECT_URIS`. Tested clients are ChatGPT and Claude. Other clients should work; they are not claimed as tested.

## Disclaimers

Feishu or Lark permissions and admin approval are the deployer's responsibility. The official Feishu remote MCP may change or be retired. The OpenAPI fallback is `TOOL_BACKENDS`, including the Lark recipe above, and needs no code change. Cloudflare Workers free-plan limits apply, in addition to the connector's own cap of 40 outbound calls per invocation.

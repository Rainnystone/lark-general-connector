# lark-general-connector

## English

### What this is

One person deploys this into their own Cloudflare account, against their own Feishu or Lark custom app, and pastes one `/mcp` URL into a connector client. The Worker acts as that one owner. It reads and writes the owner's docs. Contacts and chats are read-only: it never sends messages, and it never creates, updates, or deletes chats. Deleting a doc only moves one cloud-space docx to the recycle bin, and only after the caller confirms the doc's exact title. Wiki docs are never deletable.

Login finishes, and `/mcp` answers, only when the Feishu open_id equals `OWNER_OPEN_ID`. Any other value, including `pending` or a blank, counts as not configured: nobody can connect, and the bootstrap page shows only the caller's own open_id.

### Architecture

The Worker is an OAuth authorization server for connector clients and the MCP resource server at `/mcp`. It is a thin proxy. It does not reimplement Feishu. A proxied tool calls Feishu's remote MCP unless its default or `TOOL_BACKENDS` selects OpenAPI. `search_docs` defaults to OpenAPI. Direct tools always call OpenAPI. The endpoint allowlist is a fixed list of method and path pairs on canonical `*.feishu.cn` hosts. The allowlist is checked before any host rewrite, so a region change cannot add endpoints.

`FEISHU_REGION` selects the hosts. Source literals stay on Feishu China. Just before fetch, and for the browser authorize redirect, the Worker rewrites:

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

### How to deploy

Three paths. They share one order, below. Do not follow more than one path in the same session.

**Deploy to Cloudflare.** The button clones this repo into your GitHub account, provisions `OAUTH_KV` and `FEISHU_TOKENS`, prompts for `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `COOKIE_SECRET`, and `OWNER_OPEN_ID` with the descriptions in `package.json`, and lets you edit `FEISHU_REGION`. Deploy runs `wrangler deploy`. The link below is a placeholder. Replace `<owner>/<repo>` with the GitHub repo you deploy from. It contains no account id, KV id, or Worker hostname.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<owner>/<repo>)

**Wizard.** From the repo root, after `npm ci`, run `npm run setup`. The wizard is bilingual and uses only Node, with no extra dependencies. It asks for the region (`feishu` is the default; `lark` is the other valid value), then a Worker name. It runs `wrangler login`. If login fails, it stops and nothing is deployed. If that name already exists in the account, it refuses unless you type the name back. Any other answer stops, and nothing is deployed. It prints the region's console URL and pauses while you create the app. It then asks for `FEISHU_APP_ID` and `FEISHU_APP_SECRET` without echoing them or writing them to a file. It deploys. If deploy fails, it stops and no secrets are written. It generates `COOKIE_SECRET`. `openssl rand -hex 32` produces the same kind of 32-byte secret. It puts the four secrets, with `OWNER_OPEN_ID` set to `pending`. It prints the console URL, the hosts, the exact scope list, and `<origin>/callback`, and pauses while you add the scopes, set the redirect, and publish or request admin approval. It prints the `/mcp` URL and pauses while you connect a client. The bootstrap page denies access and shows only your open_id. It then asks for that open_id, sets `OWNER_OPEN_ID`, and prints the `/mcp` URL again so you can reconnect.

**AGENTS.md.** The same steps, written for a coding agent, in both languages. Human-only steps tell the agent to stop and wait. The agent must not paste secrets into files, commits, or chat logs.

### Setup order

Create the app, deploy, set the redirect, publish, connect a client, bootstrap login shows the open_id, set `OWNER_OPEN_ID`, reconnect.

`feishu` uses `https://open.feishu.cn/app`. `lark` uses `https://open.larksuite.com/app`. Enable every scope the wizard prints, and no others. The redirect URI is the Worker origin plus `/callback`. The client URL is that origin plus `/mcp`.

### Configuration

| Kind | Name | Default | Notes |
| --- | --- | --- | --- |
| Secret | `FEISHU_APP_ID` | — | Prompted. App ID from the open-platform credentials page. Listed in `.dev.vars.example`. |
| Secret | `FEISHU_APP_SECRET` | — | Prompted. App Secret from the same page. |
| Secret | `COOKIE_SECRET` | — | Prompted. `openssl rand -hex 32`. The wizard generates it. Signs the login cookie. |
| Secret | `OWNER_OPEN_ID` | `pending` | Prompted. A value that is not an open_id (`ou_` plus letters and digits) is not configured. |
| Committed var | `FEISHU_REGION` | `feishu` | `feishu` or `lark`. Any other value returns 503 on every route and sends nothing upstream. |
| Committed var | `PUBLIC_URL` | empty | Empty uses the request's own origin. Set a full origin only to pin a custom domain. |
| Committed var | `ALLOWED_REDIRECT_URIS` | Claude and ChatGPT callbacks | Comma-separated. Append other clients. Allowed CORS hosts are these hostnames, the Worker's own host, and `localhost`. |
| Dashboard var | `MCP_DISABLED` | unset | Kill switch. See below. `keep_vars` retains it. Not prompted. |
| Dashboard var | `TOOL_BACKENDS` | unset | Per-tool `mcp` or `openapi`. See below. `keep_vars` retains it. Not prompted. |
| Dashboard var | `P2P_DISCOVERY` | unset | `auto`, `types_param`, or `search`. See below. `keep_vars` retains it. Not prompted. |
| Binding | `OAUTH_KV` | auto-provisioned | KV namespace. No id in config. |
| Binding | `FEISHU_TOKENS` | Durable Object `FeishuTokenStore`, migration `v1` | Owner token store. |

The committed default of `ALLOWED_REDIRECT_URIS` is `https://claude.ai/api/mcp/auth_callback,https://chatgpt.com/connector_platform_oauth_redirect,https://chatgpt.com/connector/oauth/`.

Dashboard vars are not in `wrangler.jsonc`. A committed var with the same name as a secret would break deploy, so the four secrets are not committed vars either.

### Region

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

### Kill switch

`MCP_DISABLED` stops tools without a deploy. Only an unset value, an empty string, `0`, or `false` leaves the connector enabled. Any other value blocks `/mcp`, `/authorize`, and `/callback`. `/mcp` returns 503 with the JSON-RPC message `disabled by owner`. The other two paths return the disabled page. The audit event is `killswitch_block`.

### Tool backends

`TOOL_BACKENDS` is a JSON object. Keys are proxied tools. Values are `mcp` or `openapi`. An omitted key uses that tool's default. `search_docs` defaults to `openapi`. These default to `mcp`: `fetch_doc`, `list_wiki_docs`, `get_doc_comments`, `create_doc`, `update_doc`, `add_doc_comment`, `get_user`, `search_users`, `fetch_doc_media`. A value other than `mcp` or `openapi` is invalid: that tool stays on `mcp`, and the Worker logs `tool_backends_invalid`. Invalid JSON keeps every default and logs the same event. These direct tools are OpenAPI only and are not switchable: `whoami`, `delete_doc`, `list_chats`, `list_chat_messages`, `search_messages`, `get_message`.

### P2P discovery

`P2P_DISCOVERY` controls how `list_chats` finds p2p chats. `auto` is the default for an unset, empty, or unknown value: list with the types parameter, then search messages if that list fails or finishes with no p2p chat. `types_param` lists only. `search` discovers p2p chats only by message search. Search can miss chats that have no searchable messages.

### Re-auth

When the Feishu refresh token is dead, the token store marks re-auth required. `/mcp` then returns `invalid_token`. Tools return `Feishu authorization expired; reconnect the connector`. Disconnect the client and connect it again to the same `/mcp` URL. The audit event is `reauth_required`. Refresh attempts log `token_refresh`.

### Audit events

Each audit event is one content-free JSON line in Workers Logs. Events: `auth_ok`, `auth_rejected`, `token_refresh`, `reauth_required`, `killswitch_block`, `invalid_region`, `tool_backends_invalid`, and `tool_call`. `tool_call` records the tool name, a target id, ok, a code, and duration. It does not record document or message text.

### Clients

Any OAuth remote MCP client can connect. Add that client's redirect URI to `ALLOWED_REDIRECT_URIS`. Tested clients are ChatGPT and Claude. Other clients should work; they are not claimed as tested.

### Disclaimers

Feishu or Lark permissions and admin approval are the deployer's responsibility. The official Feishu remote MCP may change or be retired. The OpenAPI fallback is `TOOL_BACKENDS`, including the Lark recipe above, and needs no code change. Cloudflare Workers free-plan limits apply, in addition to the connector's own cap of 40 outbound calls per invocation.

## 中文

### 这是什么

一个人把它部署到自己的 Cloudflare 账号，对接自己的飞书或 Lark 自建应用，再把一个 `/mcp` 地址粘贴到连接器客户端。这个 Worker 只代表这一位所有者。它可以读、写所有者的文档。通讯录和聊天是只读的：它不发送消息，也不创建、更新或删除聊天。删除文档只会把一篇云空间 docx 移进回收站，而且调用方必须先确认文档的真实标题。知识库文档永远不能删。

只有飞书 open_id 等于 `OWNER_OPEN_ID` 时，登录才会完成，`/mcp` 才会应答。其他任何值，包括 `pending` 和空白，都算未配置：谁都不能连接，引导页只显示当前调用者自己的 open_id。

### 架构

Worker 同时是连接器客户端的 OAuth 授权服务器，以及 `/mcp` 上的 MCP 资源服务器。它是一层薄代理，不重新实现飞书。代理工具调用飞书远程 MCP，除非该工具的默认值或 `TOOL_BACKENDS` 选择了 OpenAPI。`search_docs` 默认是 OpenAPI。直连工具始终调用 OpenAPI。端点允许列表是固定的一组方法加路径，主机保持规范的 `*.feishu.cn`。允许列表在改写主机之前检查，所以切换区域不能增加端点。

`FEISHU_REGION` 决定主机。源码里的字面量保持飞书中国。真正 fetch 之前，以及浏览器授权跳转时，Worker 才改写主机：

| 飞书 | Lark |
| --- | --- |
| `open.feishu.cn` | `open.larksuite.com` |
| `accounts.feishu.cn` | `accounts.larksuite.com` |
| `mcp.feishu.cn` | `mcp.larksuite.com` |

`OAUTH_KV` 保存 OAuth 状态。`FEISHU_TOKENS` 是 SQLite Durable Object，类名 `FeishuTokenStore`，迁移 `v1`，保存所有者的飞书令牌。一次调用最多 40 次出站请求。密钥只放在 Cloudflare 加密密钥里。仓库里没有密钥的值。

十六个工具：

- 文档：`search_docs`、`fetch_doc`、`list_wiki_docs`、`get_doc_comments`、`create_doc`、`update_doc`、`add_doc_comment`、`fetch_doc_media`、`delete_doc`
- 人员：`whoami`、`get_user`、`search_users`
- 聊天，只读：`list_chats`、`list_chat_messages`、`search_messages`、`get_message`

### 如何部署

三条路径。它们共用下面的同一顺序。同一次操作不要走多于一条路径。

**Deploy to Cloudflare。** 这个按钮把本仓库克隆到你的 GitHub 账号，创建 `OAUTH_KV` 和 `FEISHU_TOKENS`，并按 `package.json` 里的说明提示填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`COOKIE_SECRET` 和 `OWNER_OPEN_ID`，同时允许你修改 `FEISHU_REGION`。部署命令是 `wrangler deploy`。下面的链接是占位符。把 `<owner>/<repo>` 换成你要部署的 GitHub 仓库。这里没有账号 id、KV id 或 Worker 主机名。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<owner>/<repo>)

**向导。** 在仓库根目录先 `npm ci`，再运行 `npm run setup`。向导中英双语，只用 Node，没有额外依赖。它先问区域（直接回车是 `feishu`，另一个有效值是 `lark`），再问 Worker 名称。然后执行 `wrangler login`。登录失败就停止，且不会部署。该名称若已在账号里存在，向导会拒绝，除非你把这个名称原样再输入一次。其他回答都会停止，且不会部署。它打印该区域的控制台地址，并在你创建应用时停下。接着它询问 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`，不回显，也不写入文件。然后部署。部署失败就停止，且不会写入密钥。`COOKIE_SECRET` 由向导生成。`openssl rand -hex 32` 生成同一种 32 字节密钥。它写入四个密钥，其中 `OWNER_OPEN_ID` 先设为 `pending`。然后它打印控制台地址、主机、完整权限列表和 `<origin>/callback`，并在你开通权限、设置重定向、发布或申请管理员审批时停下。它打印 `/mcp` 地址，并在你连接客户端时停下。引导页会拒绝访问，且只显示你的 open_id。然后它询问这个 open_id，写入 `OWNER_OPEN_ID`，并再次打印 `/mcp` 地址，供你重新连接。

**AGENTS.md。** 同样的步骤，写给编码代理，中英双语。人类才能做的步骤会要求代理停下来等待。代理不得把密钥写进文件、提交或对话记录。

### 安装顺序

创建应用，部署，设置重定向，发布，连接客户端，引导登录显示 open_id，设置 `OWNER_OPEN_ID`，重新连接。

`feishu` 使用 `https://open.feishu.cn/app`。`lark` 使用 `https://open.larksuite.com/app`。向导打印的每一项权限都要开通，不要多开。重定向 URI 是 Worker 源加上 `/callback`。客户端地址是该源加上 `/mcp`。

### 配置

| 种类 | 名称 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 密钥 | `FEISHU_APP_ID` | — | 会提示。开放平台凭证页上的 App ID。列在 `.dev.vars.example`。 |
| 密钥 | `FEISHU_APP_SECRET` | — | 会提示。同一页上的 App Secret。 |
| 密钥 | `COOKIE_SECRET` | — | 会提示。`openssl rand -hex 32`。向导会生成。用来签名登录 cookie。 |
| 密钥 | `OWNER_OPEN_ID` | `pending` | 会提示。不是 open_id（`ou_` 加字母和数字）的值都算未配置。 |
| 提交的变量 | `FEISHU_REGION` | `feishu` | `feishu` 或 `lark`。其他值让每个路由返回 503，且不会向上游发送任何请求。 |
| 提交的变量 | `PUBLIC_URL` | 空 | 空则使用本次请求自己的源。只有要固定自定义域名时才填写完整源。 |
| 提交的变量 | `ALLOWED_REDIRECT_URIS` | Claude 与 ChatGPT 回调 | 逗号分隔。其他客户端追加在后面。允许的 CORS 主机是这些主机名、Worker 自己的主机，以及 `localhost`。 |
| 控制台变量 | `MCP_DISABLED` | 未设置 | 紧急开关。见下文。`keep_vars` 会保留它。安装时不提示。 |
| 控制台变量 | `TOOL_BACKENDS` | 未设置 | 按工具选择 `mcp` 或 `openapi`。见下文。`keep_vars` 会保留它。安装时不提示。 |
| 控制台变量 | `P2P_DISCOVERY` | 未设置 | `auto`、`types_param` 或 `search`。见下文。`keep_vars` 会保留它。安装时不提示。 |
| 绑定 | `OAUTH_KV` | 自动创建 | KV 命名空间。配置里没有 id。 |
| 绑定 | `FEISHU_TOKENS` | Durable Object `FeishuTokenStore`，迁移 `v1` | 所有者令牌存储。 |

`ALLOWED_REDIRECT_URIS` 提交进仓库的默认值是 `https://claude.ai/api/mcp/auth_callback,https://chatgpt.com/connector_platform_oauth_redirect,https://chatgpt.com/connector/oauth/`。

控制台变量不写在 `wrangler.jsonc` 里。与密钥同名的提交变量会破坏部署，所以这四个密钥也不是提交变量。

### 区域

`feishu` 是默认值，不用改。Lark 是 **beta（已支持，未经线上实测）**。Lark 行为不对时，不要改代码。把 `TOOL_BACKENDS` 设成每个可切换工具都是 `openapi`：

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

### 紧急开关

`MCP_DISABLED` 不用重新部署就能停掉工具。只有未设置、空字符串、`0` 或 `false` 会保持开启。其他值会拦住 `/mcp`、`/authorize` 和 `/callback`。`/mcp` 返回 503，JSON-RPC 消息是 `disabled by owner`。另外两个路径返回禁用页。审计事件是 `killswitch_block`。

### 工具后端

`TOOL_BACKENDS` 是一个 JSON 对象。键是代理工具，值是 `mcp` 或 `openapi`。省略的键用该工具的默认值。`search_docs` 默认是 `openapi`。这些默认是 `mcp`：`fetch_doc`、`list_wiki_docs`、`get_doc_comments`、`create_doc`、`update_doc`、`add_doc_comment`、`get_user`、`search_users`、`fetch_doc_media`。不是 `mcp` 或 `openapi` 的值无效：该工具留在 `mcp`，Worker 记下 `tool_backends_invalid`。非法 JSON 则全部保持默认，并记下同一事件。这些直连工具只用 OpenAPI，不能切换：`whoami`、`delete_doc`、`list_chats`、`list_chat_messages`、`search_messages`、`get_message`。

### 单聊发现

`P2P_DISCOVERY` 控制 `list_chats` 如何找到单聊。未设置、空或未知值都是 `auto`：先用 types 参数列出，若这次列出失败，或列完仍没有单聊，再搜索消息。`types_param` 只列出。`search` 只通过搜索消息发现单聊。没有可搜索消息的聊天可能被漏掉。

### 重新授权

飞书刷新令牌失效后，令牌存储会标记需要重新授权。此后 `/mcp` 返回 `invalid_token`。工具返回 `Feishu authorization expired; reconnect the connector`。断开客户端，再连到同一个 `/mcp`。审计事件是 `reauth_required`。刷新尝试记下 `token_refresh`。

### 审计事件

每条审计事件是 Workers Logs 里的一行不含正文的 JSON。事件有：`auth_ok`、`auth_rejected`、`token_refresh`、`reauth_required`、`killswitch_block`、`invalid_region`、`tool_backends_invalid` 和 `tool_call`。`tool_call` 记录工具名、目标 id、是否成功、代码和耗时。它不记录文档或消息正文。

### 客户端

任何 OAuth 远程 MCP 客户端都可以连接。把该客户端的重定向 URI 追加到 `ALLOWED_REDIRECT_URIS`。实测过的客户端是 ChatGPT 和 Claude。其他客户端应当可以工作，但不算已实测。

### 声明

飞书或 Lark 的权限开通和管理员审批由部署者自己负责。飞书官方远程 MCP 可能变更或下线。OpenAPI 后备是 `TOOL_BACKENDS`，包括上面的 Lark 配方，不需要改代码。Cloudflare Workers 免费套餐的限额同样适用，另外连接器自己每次调用最多 40 次出站请求。

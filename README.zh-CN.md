# lark-general-connector

中文 | [English](./README.md)

## 这是什么

一个人把它部署到自己的 Cloudflare 账号，对接自己的飞书或 Lark 自建应用，再把一个 `/mcp` 地址粘贴到连接器客户端。这个 Worker 只代表这一位所有者。它可以读、写所有者的文档。通讯录和聊天是只读的：它不发送消息，也不创建、更新或删除聊天。删除文档只会把一篇云空间 docx 移进回收站，而且调用方必须先确认文档的真实标题。知识库文档永远不能删。

只有飞书 open_id 等于 `OWNER_OPEN_ID` 时，登录才会完成，`/mcp` 才会应答。其他任何值，包括 `pending` 和空白，都算未配置：谁都不能连接，引导页只显示当前调用者自己的 open_id。

## 架构

Worker 同时是连接器客户端的 OAuth 授权服务器，以及 `/mcp` 上的 MCP 资源服务器。它是一层薄代理，不重新实现飞书。代理工具调用飞书远程 MCP，除非该工具的默认值或 `TOOL_BACKENDS` 选择了 OpenAPI。`search_docs` 默认是 OpenAPI。直连工具始终调用 OpenAPI。端点允许列表是固定的一组方法加路径，主机保持规范的 `*.feishu.cn`。允许列表在改写主机之前检查，所以切换区域不能增加端点。

`FEISHU_REGION` 决定主机。`feishu` 表示飞书。`lark` 表示 Lark。源码里的字面量保持飞书主机。真正 fetch 之前，以及浏览器授权跳转时，Worker 才改写主机：

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

## 如何部署

三条路径。它们共用下面的同一顺序。同一次操作不要走多于一条路径。

**Deploy to Cloudflare。** 这个按钮把本仓库克隆到你的 GitHub 账号，创建 `OAUTH_KV` 和 `FEISHU_TOKENS`，并按 `package.json` 里的说明提示填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`COOKIE_SECRET` 和 `OWNER_OPEN_ID`，同时允许你修改 `FEISHU_REGION`。在 Advanced settings 里选择 "create new token"，并关闭 "Enable preview builds"。部署命令是 `wrangler deploy`。按钮指向本 GitHub 仓库。这里没有账号 id、KV id 或 Worker 主机名。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Rainnystone/lark-general-connector)

**向导。** 在仓库根目录先 `npm ci`，再运行 `npm run setup`。向导同时打印中文和 English，只用 Node，没有额外依赖。它先问区域（直接回车是 `feishu`，另一个有效值是 `lark`），再问 Worker 名称。然后执行 `wrangler login`。登录失败就停止，且不会部署。该名称若已在账号里存在，向导会拒绝，除非你把这个名称原样再输入一次。其他回答都会停止，且不会部署。它打印该区域的控制台地址，并在你创建应用时停下。接着它询问 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`，不回显，也不写入文件。然后部署。部署失败就停止，且不会写入密钥。`COOKIE_SECRET` 由向导生成。`openssl rand -hex 32` 生成同一种 32 字节密钥。它写入四个密钥，其中 `OWNER_OPEN_ID` 先设为 `pending`。然后它打印控制台地址、主机、完整权限列表和 `<origin>/callback`，并在你开通权限、设置重定向、发布或申请管理员审批时停下。它打印 `/mcp` 地址，并在你连接客户端时停下。引导页会拒绝访问，且只显示你的 open_id。然后它询问这个 open_id，写入 `OWNER_OPEN_ID`，并再次打印 `/mcp` 地址，供你重新连接。

**AGENTS.zh-CN.md。** 同样的步骤，写给编码代理。人类才能做的步骤会要求代理停下来等待。代理不得把密钥写进文件、提交或对话记录。

## 安装顺序

创建应用，部署，设置重定向，发布，连接客户端，引导登录显示 open_id，设置 `OWNER_OPEN_ID`，重新连接。

`feishu` 使用 `https://open.feishu.cn/app`。`lark` 使用 `https://open.larksuite.com/app`。向导打印的每一项权限都要开通，不要多开。重定向 URI 是 Worker 源加上 `/callback`。客户端地址是该源加上 `/mcp`。发布之前，在自建应用里开通机器人能力（Bot）。

## 配置

| 种类 | 名称 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 密钥 | `FEISHU_APP_ID` | — | 会提示。开放平台凭证页上的 App ID。列在 `.dev.vars.example`。 |
| 密钥 | `FEISHU_APP_SECRET` | — | 会提示。同一页上的 App Secret。 |
| 密钥 | `COOKIE_SECRET` | — | 会提示。`openssl rand -hex 32`。向导会生成。用来签名登录 cookie。 |
| 密钥 | `OWNER_OPEN_ID` | `pending` | 会提示。不是 open_id（`ou_` 加字母和数字）的值都算未配置。 |
| 提交的变量 | `FEISHU_REGION` | `feishu` | `feishu` 表示飞书。`lark` 表示 Lark。其他值让每个路由返回 503，且不会向上游发送任何请求。 |
| 控制台变量 | `PUBLIC_URL` | 未设置 | 可选覆盖。未设置则使用本次请求自己的源。只有要固定自定义域名时才填写完整源。 |
| 提交的变量 | `ALLOWED_REDIRECT_URIS` | Claude 与 ChatGPT 回调 | 逗号分隔。其他客户端追加在后面。允许的 CORS 主机是这些主机名、Worker 自己的主机，以及 `localhost`。 |
| 控制台变量 | `MCP_DISABLED` | 未设置 | 紧急开关。见下文。`keep_vars` 会保留它。安装时不提示。 |
| 控制台变量 | `TOOL_BACKENDS` | 未设置 | 按工具选择 `mcp` 或 `openapi`。见下文。`keep_vars` 会保留它。安装时不提示。 |
| 控制台变量 | `P2P_DISCOVERY` | 未设置 | `auto`、`types_param` 或 `search`。见下文。`keep_vars` 会保留它。安装时不提示。 |
| 绑定 | `OAUTH_KV` | 自动创建 | KV 命名空间。配置里没有 id。 |
| 绑定 | `FEISHU_TOKENS` | Durable Object `FeishuTokenStore`，迁移 `v1` | 所有者令牌存储。 |

`ALLOWED_REDIRECT_URIS` 提交进仓库的默认值是 `https://claude.ai/api/mcp/auth_callback,https://chatgpt.com/connector_platform_oauth_redirect,https://chatgpt.com/connector/oauth/`。

控制台变量不写在 `wrangler.jsonc` 里。与密钥同名的提交变量会破坏部署，所以这四个密钥也不是提交变量。

## 区域

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

## 紧急开关

`MCP_DISABLED` 不用重新部署就能停掉工具。只有未设置、空字符串、`0` 或 `false` 会保持开启。其他值会拦住 `/mcp`、`/authorize` 和 `/callback`。`/mcp` 返回 503，JSON-RPC 消息是 `disabled by owner`。另外两个路径返回禁用页。审计事件是 `killswitch_block`。

## 工具后端

`TOOL_BACKENDS` 是一个 JSON 对象。键是代理工具，值是 `mcp` 或 `openapi`。省略的键用该工具的默认值。`search_docs` 默认是 OpenAPI。这些默认是 `mcp`：`fetch_doc`、`list_wiki_docs`、`get_doc_comments`、`create_doc`、`update_doc`、`add_doc_comment`、`get_user`、`search_users`、`fetch_doc_media`。不是 `mcp` 或 `openapi` 的值无效：该工具留在 `mcp`，Worker 记下 `tool_backends_invalid`。非法 JSON 则全部保持默认，并记下同一事件。这些直连工具只用 OpenAPI，不能切换：`whoami`、`delete_doc`、`list_chats`、`list_chat_messages`、`search_messages`、`get_message`。

## 单聊发现

`P2P_DISCOVERY` 控制 `list_chats` 如何找到单聊。未设置、空或未知值都是 `auto`：先用 types 参数列出，若这次列出失败，或列完仍没有单聊，再搜索消息。`types_param` 只列出。`search` 只通过搜索消息发现单聊。没有可搜索消息的聊天可能被漏掉。

## 重新授权

飞书刷新令牌失效后，令牌存储会标记需要重新授权。此后 `/mcp` 返回 `invalid_token`。工具返回 `Feishu authorization expired; reconnect the connector`。断开客户端，再连到同一个 `/mcp`。审计事件是 `reauth_required`。刷新尝试记下 `token_refresh`。

## 审计事件

每条审计事件是 Workers Logs 里的一行不含正文的 JSON。事件有：`auth_ok`、`auth_rejected`、`token_refresh`、`reauth_required`、`killswitch_block`、`invalid_region`、`tool_backends_invalid` 和 `tool_call`。`tool_call` 记录工具名、目标 id、是否成功、代码和耗时。它不记录文档或消息正文。

## 客户端

任何 OAuth 远程 MCP 客户端都可以连接。把该客户端的重定向 URI 追加到 `ALLOWED_REDIRECT_URIS`。实测过的客户端是 ChatGPT 和 Claude。其他客户端应当可以工作，但不算已实测。

## 声明

飞书或 Lark 的权限开通和管理员审批由部署者自己负责。飞书官方远程 MCP 可能变更或下线。OpenAPI 后备是 `TOOL_BACKENDS`，包括上面的 Lark 配方，不需要改代码。Cloudflare Workers 免费套餐的限额同样适用，另外连接器自己每次调用最多 40 次出站请求。

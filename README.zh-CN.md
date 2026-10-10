# lark-general-connector

中文 | [English](./README.md)

**让 Claude、ChatGPT 这类 AI 助手直接读写你的飞书文档、查看你的飞书聊天。**

部署好之后，你可以在 Claude 或 ChatGPT 里直接说：

- "帮我找一下上周关于 Q3 预算的飞书文档，总结要点。"
- "把这份会议纪要整理好，新建成一篇飞书文档。"
- "看看'产品讨论群'今天聊了什么，有没有提到我。"
- "在这篇文档下面留个评论：数据口径需要再确认。"

它是一个开源的"连接器"（connector）：你把它部署到**你自己的** Cloudflare 账号上，它就成了 AI 助手和你的飞书之间的一座小桥。整个过程不需要写代码，跟着下面的步骤点点鼠标、复制粘贴即可，大约需要 30 分钟。

> 同时支持飞书和 Lark（飞书国际版）。Lark 目前是 beta：功能已支持，但还没用真实账号测试过。

---

## 目录

- [它能做什么、不能做什么](#它能做什么不能做什么)
- [安全吗？](#安全吗)
- [开始之前要准备什么](#开始之前要准备什么)
- [部署步骤](#部署步骤)
- [连接到 Claude 或 ChatGPT](#连接到-claude-或-chatgpt)
- [常见问题](#常见问题)
- [技术参考（给开发者）](#技术参考给开发者)

---

## 它能做什么、不能做什么

| | 能做 | 不能做 |
| --- | --- | --- |
| **文档** | 搜索、阅读、新建、编辑文档；读取和添加评论；查看知识库；下载文档里的图片 | 删除知识库里的文档 |
| **删除文档** | 只能删你云空间里的普通文档，而且只是**移进回收站**（可以找回），还必须先说对文档的完整标题 | 永久删除任何东西 |
| **人员** | 查你自己的信息、查同事的基本信息、按名字搜人 | 修改通讯录 |
| **聊天** | 列出你的群聊和单聊、读消息、搜索消息 | **发消息**、建群、改群、删群 —— 聊天完全只读 |

---

## 安全吗？

- **只为你一个人服务。** 部署完成后，连接器会记住你的飞书身份（open_id）。除你以外，任何人登录都会被拒绝。
- **数据不经过第三方。** 连接器运行在你自己的 Cloudflare 账号里，代码完全开源可查。飞书的登录凭证保存在你自己的 Cloudflare 加密存储里，这个代码仓库里不包含任何密钥。
- **不会替你说话。** 它没有发消息的能力，不会以你的名义在飞书里发任何东西。
- **随时可以一键关闭。** 见[如何紧急停用](#如何紧急停用连接器)。
- **日志不记内容。** 连接器只记录"什么时候调用了哪个功能、成功没有"，从不记录文档或消息的正文。

---

## 开始之前要准备什么

1. **一个 Cloudflare 账号**（免费版就够用）：<https://dash.cloudflare.com/sign-up>
2. **一个 GitHub 账号**（用"一键部署"按钮时需要）：<https://github.com/signup>
3. **一个能创建"企业自建应用"的飞书账号。** 如果你是所在飞书组织的管理员，可以自己创建并发布；如果是公司的飞书，发布时可能需要管理员审批（下面会说到）。
4. **Claude 或 ChatGPT**，并且你的套餐支持添加自定义连接器。

---

## 部署步骤

整体流程是这样的，**顺序不能乱**：

```
① 在飞书创建应用  →  ② 部署到 Cloudflare  →  ③ 回飞书填回调地址
→  ④ 开通权限、开机器人能力、发布应用  →  ⑤ 在 Claude/ChatGPT 里连接
→  ⑥ 页面会拒绝你并显示你的 open_id（这是正常的！）
→  ⑦ 把 open_id 填回 Cloudflare  →  ⑧ 重新连接，完成
```

为什么第 ⑥ 步会被拒绝？因为一开始连接器还不知道"主人"是谁，所以谁都不让进，只告诉你"你的 ID 是这个"。你把这个 ID 填回去，连接器就认定你是唯一的主人了。

部署有三种方式，**选一种就好，不要混着用**：

| 方式 | 适合谁 |
| --- | --- |
| **A. 一键部署按钮**（推荐） | 不写代码的人。全程在网页上操作。 |
| **B. 命令行向导** | 会用终端的人。向导会一步步提示，自动生成和保存密钥。 |
| **C. 交给 AI 编码助手** | 用 Claude Code、Codex 之类工具的人。让它读 [AGENTS.zh-CN.md](./AGENTS.zh-CN.md) 照做，需要你动手的步骤它会停下来等你。 |

下面详细讲方式 A。方式 B 见[命令行向导](#方式-b命令行向导)。

### ① 在飞书创建应用

1. 打开飞书开放平台：飞书用户打开 <https://open.feishu.cn/app>，Lark 用户打开 <https://open.larksuite.com/app>。
2. 点 **创建企业自建应用**，名字随便起（比如"我的 AI 连接器"）。
3. 进入应用，打开 **凭证与基础信息** 页面，记下 **App ID** 和 **App Secret**。下一步要用。

> ⚠️ App Secret 相当于密码，不要发给任何人，也不要贴到聊天里。

### ② 部署到 Cloudflare

1. 点这个按钮：

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Rainnystone/lark-general-connector)

2. 按提示登录 Cloudflare 和 GitHub。按钮会把代码复制一份到你的 GitHub，并自动创建需要的存储。
3. 页面会让你填几个值：

   | 要填的项 | 填什么 |
   | --- | --- |
   | `FEISHU_APP_ID` | 第 ① 步记下的 App ID |
   | `FEISHU_APP_SECRET` | 第 ① 步记下的 App Secret |
   | `COOKIE_SECRET` | 一串随机字符，用来给登录信息签名。Mac 用户可以打开"终端"，运行 `openssl rand -hex 32`，把输出的那串字符粘贴进来；也可以用任意密码生成器生成一串 32 位以上的随机字母数字。 |
   | `OWNER_OPEN_ID` | 先填 `pending`（意思是"待定"），第 ⑦ 步再改 |
   | `FEISHU_REGION` | 飞书用户保持 `feishu` 不动；Lark 用户改成 `lark` |

4. 展开 **Advanced settings（高级设置）**：选 **create new token**，并**关掉** **Enable preview builds**。
5. 点部署，等它完成。
6. 部署成功后，你会得到一个网址，形如 `https://lark-general-connector.<你的子域>.workers.dev`。**把这个网址记下来**，后面叫它"你的连接器地址"。

### ③ 回飞书填回调地址

回到飞书开放平台你的应用里，打开 **安全设置**，在 **重定向 URL** 里添加：

```
你的连接器地址/callback
```

例如 `https://lark-general-connector.<你的子域>.workers.dev/callback`。保存。

### ④ 开通权限、开机器人能力、发布应用

1. **开通权限。** 打开 **权限管理**，把[权限清单](#权限清单)里的每一项都开通，**不多开也不少开**。如果控制台让你选身份，选 **用户身份**。
2. **开机器人能力。** 发布之前，在自建应用里开通机器人能力（Bot）。（在 **添加应用能力** 里找到"机器人"并添加。）
3. **发布。** 打开 **版本管理与发布**，创建一个版本并发布。如果你在公司的飞书里，这一步可能需要管理员审批，等审批通过再继续。

### ⑤ 在 Claude 或 ChatGPT 里连接

把下面这个地址添加为自定义连接器（具体怎么加见[连接到 Claude 或 ChatGPT](#连接到-claude-或-chatgpt)）：

```
你的连接器地址/mcp
```

添加后会弹出授权流程：先是一个确认页面，点 **Approve**；然后跳到飞书登录页，登录并同意授权。

### ⑥ 看到"Owner not configured"页面 —— 这是正常的

登录后你会看到一个标题为 **Owner not configured** 的页面，写着这个飞书账号不是主人，下面还有一行：

```
open_id: ou_xxxxxxxxxxxxxxxx
```

**这正是我们要的。** 把 `ou_` 开头的那串字符复制下来，这就是你的飞书身份 ID。

### ⑦ 把 open_id 填回 Cloudflare

1. 打开 Cloudflare 控制台 <https://dash.cloudflare.com>，进入 **Workers & Pages**，点开你的连接器。
2. 进入 **Settings（设置）→ Variables and Secrets（变量和机密）**。
3. 找到 `OWNER_OPEN_ID`，把值从 `pending` 改成你刚才复制的 open_id，保存。

### ⑧ 重新连接

回到 Claude 或 ChatGPT，**断开**这个连接器，再用同一个 `/mcp` 地址**重新连接**一次。这次登录就会成功。

🎉 完成！现在你可以在对话里让 AI 帮你处理飞书了。

### 方式 B：命令行向导

需要电脑上装了 Node.js 和 git。在终端里：

```bash
git clone https://github.com/Rainnystone/lark-general-connector.git
```

```bash
cd lark-general-connector && npm ci && npm run setup
```

向导用中英文双语提示，流程和上面 ①–⑧ 完全一样，区别是：

- 它会帮你登录 Cloudflare（`wrangler login`）、部署，并在每个需要你去飞书操作的地方停下来等你。
- App ID、App Secret 和 open_id 是在终端里输入的，**输入时不显示、不写进任何文件**。
- `COOKIE_SECRET` 由向导自动生成，`OWNER_OPEN_ID` 也会自动先设成 `pending`。
- 它会打印出回调地址、`/mcp` 地址和完整的权限清单，直接照着复制就行。
- 如果你起的 Worker 名称在账号里已经存在，向导会要求你把名字再输一遍确认，防止误覆盖。

---

## 连接到 Claude 或 ChatGPT

> 两家的菜单名称可能随版本调整，大致位置如下。

**Claude**：打开 **设置 → 连接器（Connectors）→ 添加自定义连接器（Add custom connector）**，名称随便填，URL 填 `你的连接器地址/mcp`。

**ChatGPT**：打开 **设置 → 应用与连接器（Apps & Connectors）**，在高级设置里开启**开发者模式**，然后 **创建（Create）** 一个连接器，URL 填 `你的连接器地址/mcp`，认证方式选 **OAuth**。

其他支持 OAuth 远程 MCP 的客户端理论上也能用，但需要先把它的回调地址加进 `ALLOWED_REDIRECT_URIS`（见[技术参考](#配置项)）。目前实测过的只有 Claude 和 ChatGPT。

---

## 常见问题

### 登录时显示"Owner not configured"，是不是坏了？

第一次连接时出现是**正常的**，见第 ⑥ 步。如果你已经填过 `OWNER_OPEN_ID` 还看到它，检查一下：填的值是不是以 `ou_` 开头、有没有多复制空格、是不是保存了。

### 显示"This Feishu account is not the owner."

你登录的飞书账号和 `OWNER_OPEN_ID` 里填的不是同一个人。换回主人的账号登录。

### AI 说"Feishu authorization expired; reconnect the connector"

飞书的登录授权过期了（比如很久没用）。在 Claude 或 ChatGPT 里断开连接器，再用同一个地址重新连接即可。

### 公司的飞书创建不了应用 / 发布不了

企业版飞书一般需要管理员审批。在发布时按控制台提示提交申请，等管理员通过。开通权限和审批由部署的人自己负责。

### 如何紧急停用连接器？

不用重新部署：在 Cloudflare 控制台 → 你的连接器 → **Settings → Variables and Secrets**，添加一个变量 `MCP_DISABLED`，值填 `1`，保存。连接器会立刻停止响应。要恢复时删掉它，或改成 `0`。

### 用 Lark 遇到问题怎么办？

Lark 支持目前是 beta。如果某些功能不正常，不需要改代码，按[区域](#区域)一节把 `TOOL_BACKENDS` 设成全部走 openapi 试试。

### 要花钱吗？

Cloudflare Workers 免费版的额度对个人使用一般足够。飞书自建应用本身免费。

---

## 技术参考（给开发者）

以下内容面向想了解实现细节或调整配置的人。普通使用可以跳过。

### 架构

Worker 同时是连接器客户端的 OAuth 授权服务器，以及 `/mcp` 上的 MCP 资源服务器。它是一层薄代理，不重新实现飞书。代理工具调用飞书远程 MCP，除非该工具的默认值或 `TOOL_BACKENDS` 选择了 OpenAPI。`search_docs` 默认是 OpenAPI。直连工具始终调用 OpenAPI。端点允许列表是固定的一组方法加路径，主机保持规范的 `*.feishu.cn`。允许列表在改写主机之前检查，所以切换区域不能增加端点。

只有飞书 open_id 等于 `OWNER_OPEN_ID` 时，登录才会完成，`/mcp` 才会应答。其他任何值，包括 `pending` 和空白，都算未配置：谁都不能连接，引导页只显示当前调用者自己的 open_id。

`OAUTH_KV` 保存 OAuth 状态。`FEISHU_TOKENS` 是 SQLite Durable Object，类名 `FeishuTokenStore`，迁移 `v1`，保存所有者的飞书令牌。一次调用最多 40 次出站请求。密钥只放在 Cloudflare 加密密钥里，仓库里没有密钥的值。

十六个工具：

- 文档：`search_docs`、`fetch_doc`、`list_wiki_docs`、`get_doc_comments`、`create_doc`、`update_doc`、`add_doc_comment`、`fetch_doc_media`、`delete_doc`
- 人员：`whoami`、`get_user`、`search_users`
- 聊天，只读：`list_chats`、`list_chat_messages`、`search_messages`、`get_message`

### 配置项

| 种类 | 名称 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 密钥 | `FEISHU_APP_ID` | — | 部署时填写。开放平台凭证页上的 App ID。列在 `.dev.vars.example`。 |
| 密钥 | `FEISHU_APP_SECRET` | — | 部署时填写。同一页上的 App Secret。 |
| 密钥 | `COOKIE_SECRET` | — | 部署时填写。`openssl rand -hex 32`。向导会生成。用来签名登录 cookie。 |
| 密钥 | `OWNER_OPEN_ID` | `pending` | 部署时填写。不是 open_id（`ou_` 加字母和数字）的值都算未配置。 |
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

### 区域

`FEISHU_REGION` 决定主机。源码里的字面量保持飞书主机，真正 fetch 之前以及浏览器授权跳转时，Worker 才改写主机：

| 飞书 | Lark |
| --- | --- |
| `open.feishu.cn` | `open.larksuite.com` |
| `accounts.feishu.cn` | `accounts.larksuite.com` |
| `mcp.feishu.cn` | `mcp.larksuite.com` |

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

`TOOL_BACKENDS` 是一个 JSON 对象。键是代理工具，值是 `mcp` 或 `openapi`。省略的键用该工具的默认值。`search_docs` 默认是 OpenAPI。这些默认是 `mcp`：`fetch_doc`、`list_wiki_docs`、`get_doc_comments`、`create_doc`、`update_doc`、`add_doc_comment`、`get_user`、`search_users`、`fetch_doc_media`。不是 `mcp` 或 `openapi` 的值无效：该工具留在 `mcp`，Worker 记下 `tool_backends_invalid`。非法 JSON 则全部保持默认，并记下同一事件。这些直连工具只用 OpenAPI，不能切换：`whoami`、`delete_doc`、`list_chats`、`list_chat_messages`、`search_messages`、`get_message`。

### 单聊发现

`P2P_DISCOVERY` 控制 `list_chats` 如何找到单聊。未设置、空或未知值都是 `auto`：先用 types 参数列出，若这次列出失败，或列完仍没有单聊，再搜索消息。`types_param` 只列出。`search` 只通过搜索消息发现单聊。没有可搜索消息的聊天可能被漏掉。

### 重新授权

飞书刷新令牌失效后，令牌存储会标记需要重新授权。此后 `/mcp` 返回 `invalid_token`。工具返回 `Feishu authorization expired; reconnect the connector`。断开客户端，再连到同一个 `/mcp`。审计事件是 `reauth_required`。刷新尝试记下 `token_refresh`。

### 审计事件

每条审计事件是 Workers Logs 里的一行不含正文的 JSON。事件有：`auth_ok`、`auth_rejected`、`token_refresh`、`reauth_required`、`killswitch_block`、`invalid_region`、`tool_backends_invalid` 和 `tool_call`。`tool_call` 记录工具名、目标 id、是否成功、代码和耗时。它不记录文档或消息正文。

### 权限清单

在飞书开放平台的应用里开通下面每一项，不要多开。这份清单与 `src/scopes.ts` 一致，向导和 [AGENTS.zh-CN.md](./AGENTS.zh-CN.md) 打印的也是同一份。

```scopes
search:docs:read
docx:document:readonly
wiki:wiki:readonly
wiki:node:read
space:document:retrieve
docs:document.comment:read
docs:document.media:download
board:whiteboard:node:read
task:task:read
contact:contact.base:readonly
contact:user.base:readonly
contact:user:search
docx:document:create
docx:document:write_only
wiki:node:create
docs:document.media:upload
board:whiteboard:node:create
docs:document.comment:create
space:document:delete
im:chat:read
im:message:readonly
im:message.group_msg:get_as_user
im:message.p2p_msg:get_as_user
search:message
offline_access
```

### 声明

飞书或 Lark 的权限开通和管理员审批由部署者自己负责。飞书官方远程 MCP 可能变更或下线。OpenAPI 后备是 `TOOL_BACKENDS`，包括上面的 Lark 配方，不需要改代码。Cloudflare Workers 免费套餐的限额同样适用，另外连接器自己每次调用最多 40 次出站请求。

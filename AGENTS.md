# Setup for a coding agent

Deploy this connector into the human's own Cloudflare account and their own Feishu or Lark app. Use one path: `npm run setup`, or the wrangler commands below. Do not run both in the same session. This setup does not need a code change or a commit.

A later session has reached the bootstrap checkpoint when the human, on the Worker this session deployed, sees the 403 page titled `Owner not configured`. Do not stop the rest of the order there: set `OWNER_OPEN_ID`, then reconnect.

## English

The same order for both feishu and lark. Only the hosts change.

| Region | Console | Open API | Accounts | MCP |
| --- | --- | --- | --- | --- |
| feishu | https://open.feishu.cn/app | https://open.feishu.cn | https://accounts.feishu.cn | https://mcp.feishu.cn |
| lark | https://open.larksuite.com/app | https://open.larksuite.com | https://accounts.larksuite.com | https://mcp.larksuite.com |

Lark is supported and not live-tested. Do not edit code if Lark misbehaves.

From the repository root, run `npm ci`. Prefer `npm run setup` in a terminal the human can type into. The wizard is bilingual, pauses at each human-only step, generates `COOKIE_SECRET`, and sends every secret on stdin without echoing it. If stdin is not a terminal, do not invent secret answers. Use the wrangler commands instead, and let the human type the secrets.

Ask the human for the region. `feishu` is the default. `lark` is the only other valid value. Any other `FEISHU_REGION` is invalid: every route returns 503 with `invalid FEISHU_REGION`, and nothing is sent upstream.

Ask the human for a Worker name. Use lowercase letters, digits, and hyphens, with no leading or trailing hyphen, and at most 63 characters. The config's default name is `lark-general-connector`. Still pass `--name`. Do not omit it.

When `npm run setup` is running, do not run the wrangler commands in this file again. The wizard runs login, the name check, deploy, and secret put itself. You may relay only the human's region and Worker name into the wizard. You never type a secret or an overwrite confirmation.

Wrangler path:

`npx wrangler login`

Stop. Wait for the human. If login fails, stop. Nothing is deployed.

`npx wrangler deployments list --name <worker-name> --json`

Exit 0 means that name already exists. An empty list on exit 0 is still an existing name. Stop. Wait for the human. Never deploy over an existing Worker name without the human's confirmation. Do not type the existing Worker name yourself. The human types that name back. Surrounding whitespace is ignored. Any other answer stops, and nothing is deployed. `[code: 10007]` means the name is absent. Continue. Any other result: stop, and do not deploy.

Never write secrets into files, commits or chat. Never deploy over an existing Worker name without the human's confirmation. Never widen scopes, tools or the endpoint allowlist.

Send each secret on stdin, not as a command argument. Do not use `--secrets-file`. Do not write `.dev.vars`. Leave `.dev.vars.example` unchanged. Leave `PUBLIC_URL` empty. Leave `ALLOWED_REDIRECT_URIS` as committed unless the human gives you one extra client redirect to append. Do not remove the existing entries. Do not edit `wrangler.jsonc`, `src/scopes.ts`, `src/feishu/client.ts`, or `src/mcp/server.ts`. Do not add a scope, a tool, or an allowlist entry. Do not add larksuite hosts to the allowlist. The allowlist stays on canonical `*.feishu.cn` method and path pairs, and the region rewrite happens after that check.

### 1. Create the app

Print the console URL for the chosen region. Stop. Wait for the human. The human creates the custom app in that console. You do not create it.

The wizard prints `控制台 Console:` and waits on "Create the app".

Stop. Wait for the human. Do not ask for `FEISHU_APP_ID` or `FEISHU_APP_SECRET` in chat. On the wizard path, the human types them into the wizard's hidden prompts before deploy. On the wrangler path, the human types them at the `secret put` prompts in the next step.

### 2. Deploy

Wrangler path:

`npx wrangler deploy --name <worker-name> --var FEISHU_REGION:feishu`

Use `npx wrangler deploy --name <worker-name> --var FEISHU_REGION:lark` when the human chose lark. If deploy fails, stop. No secrets are written.

Copy the https origin wrangler printed. Do not build it from the Worker name. It looks like `https://<worker-name>.example.workers.dev`: the Worker name, then the account subdomain, then `.workers.dev`. `https://<worker-name>.workers.dev` is not this Worker. The callback is that origin plus `/callback`. The MCP URL is that origin plus `/mcp`. On the wizard path, use the Redirect URI and MCP URL the wizard prints. If no origin is printed, ask the human to paste the https origin only, with no user, password, or path.

On the wrangler path, after a successful deploy, the human puts the four values. stdin only. The human runs these commands. You do not type the secret values:

`npx wrangler secret put FEISHU_APP_ID --name <worker-name>`

`npx wrangler secret put FEISHU_APP_SECRET --name <worker-name>`

`openssl rand -hex 32 | npx wrangler secret put COOKIE_SECRET --name <worker-name>`

`npx wrangler secret put OWNER_OPEN_ID --name <worker-name>` with the value `pending`

Do not capture the `openssl` output. `pending` is not an open_id. Nobody can connect yet. The wizard puts these four values itself, in this order, with `COOKIE_SECRET` generated inside the process.

Print the console URL, the three hosts, `<origin>/callback`, and every line in the Scopes block. Stop. Wait for the human. The human enables every scope in that block and no others. The wizard waits on "Add the scopes".

### 3. Set the redirect

The redirect URI is `<origin>/callback`. Stop. Wait for the human. The human pastes it into the app. The wizard waits on "Set the redirect".

### 4. Publish

Do this only after the redirect is saved. Stop. Wait for the human. The human enables the Bot capability (机器人) on the custom app before publishing, then publishes the app, or requests the admin approval the console requires. The wizard waits on "Publish".

### 5. Connect a client

Print `<origin>/mcp`. Stop. Wait for the human. The human adds that URL to Claude or ChatGPT and starts login. Do not log in as the human. The wizard waits on "Connect a client".

### 6. Bootstrap login shows open_id

The bootstrap page is HTTP 403. The title is `Owner not configured`. The body says `This Feishu account is not the owner.` and shows `open_id:` for this caller only. That denial is the checkpoint. Stop. Wait for the human. Do not copy the open_id into chat or a file.

### 7. Set OWNER_OPEN_ID

Stop. Wait for the human. The value must be an open_id: `ou_` plus letters and digits. `pending` is not one. Do not copy it into chat or a file. On the wizard path, the human types it into the wizard prompt, which reads it without echoing. On the wrangler path, the human runs `npx wrangler secret put OWNER_OPEN_ID --name <worker-name>` and types it on stdin.

### 8. Reconnect

Stop. Wait for the human. The human disconnects the client and connects again to the same `/mcp` URL. The wizard prints that URL again after the owner is saved.

Contacts and chats stay read-only. Do not add message send, or chat create, update, or delete. Doc delete only moves one cloud-space docx to the recycle bin after the exact title is confirmed. Wiki docs are never deletable. Do not change the owner gate, the kill switch, the subrequest budget, or the audit logs. Secrets stay in Cloudflare encrypted secrets.

## 中文

feishu 和 lark 都用这一顺序。变的只有主机。

| 区域 | 控制台 | Open API | 账号 | MCP |
| --- | --- | --- | --- | --- |
| feishu | https://open.feishu.cn/app | https://open.feishu.cn | https://accounts.feishu.cn | https://mcp.feishu.cn |
| lark | https://open.larksuite.com/app | https://open.larksuite.com | https://accounts.larksuite.com | https://mcp.larksuite.com |

Lark 可用，但没有用真实账号实测过。Lark 行为不对时，不要改代码。

在仓库根目录运行 `npm ci`。优先在人类能打字的终端里运行 `npm run setup`。向导中英双语，会在每个人类步骤停下，自己生成 `COOKIE_SECRET`，并把每个密钥从 stdin 送入且不回显。如果 stdin 不是终端，不要编造密钥。改走 wrangler 命令，让人类自己输入。

问人类要区域。直接回车是 `feishu`。另一个有效值只有 `lark`。别的 `FEISHU_REGION` 都无效：部署成无效区域后，每个路由都返回 503，且不会向上游发任何请求。

问人类要 Worker 名称。只能用小写字母、数字和连字符，不能以连字符开头或结尾，最长 63 个字符。配置里的默认名称是 `lark-general-connector`。仍然要传 `--name`，不要省略。

`npm run setup` 已经在跑时，不要再执行本文里的 wrangler 命令。向导自己会登录、检查名称、部署并写入密钥。你最多把人类选定的区域和 Worker 名称转告向导。密钥和覆盖确认都不要由你输入。

Wrangler 路径：

`npx wrangler login`

停下来。等人类完成。登录失败就停止。不要部署。

`npx wrangler deployments list --name <worker-name> --json`

退出码 0 表示这个名称已经存在。退出码 0 时输出是空列表，也算已存在。停下来。等人类完成。未经人类确认，不要覆盖已存在的 Worker 名称。不要自己输入已存在的 Worker 名称。人类自己把这个名称再输入一遍。名称前后的空白不算。其他回答都停止，且不会部署。输出里有 `[code: 10007]` 表示名称不存在，可以继续。其他结果都停止，不要部署。

不要把密钥写入文件、提交或对话。未经人类确认，不要覆盖已存在的 Worker 名称。不要放宽权限、工具或端点允许列表。

每个密钥都从 stdin 送入，不要放进命令参数。不要使用 `--secrets-file`。不要写入 `.dev.vars`。不要改 `.dev.vars.example`。`PUBLIC_URL` 留空。除非人类给出一个要追加的客户端重定向，否则不要改 `ALLOWED_REDIRECT_URIS`，也不要删掉已有条目。不要改 `wrangler.jsonc`、`src/scopes.ts`、`src/feishu/client.ts` 或 `src/mcp/server.ts`。不要新增权限、工具或允许列表条目。不要把 larksuite 主机加进允许列表。允许列表只保留规范的 `*.feishu.cn` 方法加路径，区域改写发生在这次检查之后。

### 1. 创建应用

打印所选区域的控制台地址。停下来。等人类完成。人类在那个控制台里创建自建应用。你不要代劳。

向导会打印 `控制台 Console:`，并在「创建应用」处等待。

停下来。等人类完成。不要在对话里索要 `FEISHU_APP_ID` 或 `FEISHU_APP_SECRET`。走向导时，人类在部署前把它们输入到向导的隐藏提示里。走 wrangler 时，人类在下一步的 `secret put` 提示里输入。

### 2. 部署

Wrangler 路径：

`npx wrangler deploy --name <worker-name> --var FEISHU_REGION:feishu`

人类选了 lark 时，用 `npx wrangler deploy --name <worker-name> --var FEISHU_REGION:lark`。部署失败就停止。不要写入密钥。

照抄 wrangler 打印出来的 https 源。不要用 Worker 名称自己拼。它的形状是 `https://<worker-name>.example.workers.dev`：Worker 名称，然后是账号子域，然后是 `.workers.dev`。`https://<worker-name>.workers.dev` 不是这个 Worker。回调是该源加上 `/callback`。MCP 地址是该源加上 `/mcp`。走向导时，用向导打印的 Redirect URI 和 MCP 地址，不要替换。如果输出里没有源，只让人类粘贴 https 源，不要用户名、密码或路径。

如果走 wrangler，部署成功之后由人类写入这四个值。只能走 stdin。下面的命令由人类执行。你不要输入密钥：

`npx wrangler secret put FEISHU_APP_ID --name <worker-name>`

`npx wrangler secret put FEISHU_APP_SECRET --name <worker-name>`

`openssl rand -hex 32 | npx wrangler secret put COOKIE_SECRET --name <worker-name>`

`npx wrangler secret put OWNER_OPEN_ID --name <worker-name>`，值是 `pending`

不要捕获 `openssl` 的输出。`pending` 不是 open_id。此时谁都不能连接。向导会按这个顺序自己写入这四个值，并在进程内生成 `COOKIE_SECRET`。

打印控制台地址、三个主机、`<origin>/callback`，以及 Scopes 代码块里的每一行。停下来。等人类完成。人类开通其中每一项权限，并且不多开。向导在「开通权限」处等待。

### 3. 设置重定向

重定向 URI 是 `<origin>/callback`。停下来。等人类完成。人类把它填进应用。向导在「设置重定向」处等待。

### 4. 发布

先保存重定向，再做这一步。停下来。等人类完成。人类在发布之前，于自建应用开通机器人能力（Bot），然后发布应用，或按控制台要求申请管理员审批。向导在「发布」处等待。

### 5. 连接客户端

打印 `<origin>/mcp`。停下来。等人类完成。人类把这个地址加到 Claude 或 ChatGPT 并开始登录。不要代替人类登录。向导在「连接客户端」处等待。

### 6. 引导登录显示 open_id

引导页是 HTTP 403。标题是 `Owner not configured`。正文是 `This Feishu account is not the owner.`，并且只显示当前调用者的 `open_id:`。这次拒绝就是检查点。停下来。等人类完成。不要把 open_id 抄进对话或文件。

### 7. 设置 OWNER_OPEN_ID

停下来。等人类完成。这个值必须是 open_id：`ou_` 后面只跟字母和数字。`pending` 不是。不要把它抄进对话或文件。走向导时，人类把它输入到向导提示里，向导读取时不回显。走 wrangler 时，人类执行 `npx wrangler secret put OWNER_OPEN_ID --name <worker-name>`，并从 stdin 输入。

### 8. 重新连接

停下来。等人类完成。人类断开客户端，再用同一个 `/mcp` 地址连上。所有者写入之后，向导会再打印一次这个地址。

联系人和聊天保持只读。不要增加发消息，也不要增加创建、更新或删除聊天。删除文档只会把一篇云空间 docx 移进回收站，而且必须确认完整标题。知识库文档永远不能删。不要改所有者门闩、急停开关、子请求预算或审计日志。密钥只放在 Cloudflare 的加密密钥里。

## Scopes

Enable every line below and no others. 开通下面每一行，不要多开。 This block is `FEISHU_SCOPES` in `src/scopes.ts`.

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

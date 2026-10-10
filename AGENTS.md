# Setup for a coding agent

[中文](./AGENTS.zh-CN.md)

Deploy this connector into the human's own Cloudflare account and their own Feishu or Lark app. Use one path: `npm run setup`, or the wrangler commands below. Do not run both in the same session. This setup does not need a code change or a commit.

A later session has reached the bootstrap checkpoint when the human, on the Worker this session deployed, sees the 403 page titled `Owner not configured`. Do not stop the rest of the order there: set `OWNER_OPEN_ID`, then reconnect.

The same order for both feishu and lark. Only the hosts change. `feishu` means Feishu. `lark` means Lark.

| Region | Console | Open API | Accounts | MCP |
| --- | --- | --- | --- | --- |
| feishu | https://open.feishu.cn/app | https://open.feishu.cn | https://accounts.feishu.cn | https://mcp.feishu.cn |
| lark | https://open.larksuite.com/app | https://open.larksuite.com | https://accounts.larksuite.com | https://mcp.larksuite.com |

Lark is supported and not live-tested. Do not edit code if Lark misbehaves.

From the repository root, run `npm ci`. Prefer `npm run setup` in a terminal the human can type into. The wizard prints 中文 and English, pauses at each human-only step, generates `COOKIE_SECRET`, and sends every secret on stdin without echoing it. If stdin is not a terminal, do not invent secret answers. Use the wrangler commands instead, and let the human type the secrets.

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

## Scopes

Enable every line below and no others. This block is `FEISHU_SCOPES` in `src/scopes.ts`.

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

# Setup for a coding agent

This file is the deploy runbook. Follow it when the human asks you to deploy or set up this connector. For code changes, read `CONTEXT.md` and the tests instead: the deploy limits here (no code change, no commit, the files to leave alone) bind deployment only.

Deploy this connector into the human's own Cloudflare account and their own Feishu or Lark app. This setup does not need a code change or a commit. The human usually does not code: talk to them in their own language, keep each request short, give them exact links and commands, and do every other step yourself.

A later session has reached the bootstrap checkpoint when the human, on the Worker this session deployed, sees the 403 page titled `Owner not configured`. Do not stop the rest of the order there: set `OWNER_OPEN_ID`, then reconnect.

The same order for both feishu and lark. Only the hosts change. `feishu` means Feishu. `lark` means Lark.

| Region | Console | Open API | Accounts | MCP |
| --- | --- | --- | --- | --- |
| feishu | https://open.feishu.cn/app | https://open.feishu.cn | https://accounts.feishu.cn | https://mcp.feishu.cn |
| lark | https://open.larksuite.com/app | https://open.larksuite.com | https://accounts.larksuite.com | https://mcp.larksuite.com |

Lark is supported and not live-tested. Do not edit code if Lark misbehaves.

Every human-only step below has click-by-click instructions under the same number in the human's README ([README.md](./README.md) or [README.zh-CN.md](./README.zh-CN.md), "Setup steps"; the scopes sit under ④). Point the human to that numbered step instead of paraphrasing the console.

## Get the code

Work inside a copy of this repository: its `package.json` has `"name": "lark-general-connector"`. If the working directory is not one, get it. No GitHub account is needed. With git: `git clone https://github.com/Rainnystone/lark-general-connector.git`, then work in `lark-general-connector`. Without git: download `https://github.com/Rainnystone/lark-general-connector/archive/refs/heads/main.zip`, unzip it, and work in `lark-general-connector-main`.

Check `node --version` before any other command in this file. The wizard and the Lark CLI path need Node.js 22.6 or newer; older Node fails with `bad option: --experimental-strip-types`. If Node is older or missing, stop and ask the human to install the LTS release from https://nodejs.org.

## Choose a path

Use one path for the whole session. Do not mix them.

1. **Lark CLI path**, when the region is `feishu`. Feishu's official Lark CLI creates the app and reads the owner's open_id, so the human only confirms in the browser. It runs on the wrangler commands below, plus the "Lark CLI path" paragraph inside each numbered step. See "Lark CLI" below.
2. **Wizard**, when the region is `lark`, or the human declines the Lark CLI path. `npm run setup` in a terminal the human can type into.
3. **Wrangler path**, when neither fits: the wrangler commands below, with the human typing each secret.

A Lark CLI action that fails, expires, or that the human declines has a **fallback**: do that step's manual text instead and continue on the wrangler path. Do not retry a declined action, and do not switch to the wizard mid-session.

## Lark CLI

The Lark CLI is https://github.com/larksuite/cli. Below, `lark-cli` means the installed `lark-cli` when `lark-cli --version` succeeds, and `npx -y @larksuite/cli@1` otherwise.

- **Profile.** Name a Lark CLI profile after the Worker: `<profile>` is `<worker-name>`. Pass `--name <profile>` to `config init` and `--profile <profile>` to every other `lark-cli` command. Without it, Lark CLI acts on the human's default profile, which may be a different app. Never run `config remove`, and never run `config init` without `--name`.
- **Browser confirmations.** `config init --new` and `auth login` wait for the human to confirm in the browser. Run `config init --new` in the background and read the verification URL from its output. Run `auth login` with `--no-wait --json`, then `--device-code` once the human confirms. Give the human each URL verbatim. If `config init` refuses because it runs inside an agent workspace (`OPENCLAW_HOME` or `HERMES_HOME`), take the fallback; do not pass `--force-init` or run `config bind`.
- **Narrow login.** `auth login` without `--scope` requests every scope the app has. Always pass `--scope contact:user.base:readonly`, and run `auth logout` as soon as the open_id is stored.
- **App Secret.** `config init` prints the App Secret in its final output. Always run it through `grep --line-buffered -iv secret`, which drops every line naming a secret and still shows the verification URL as it appears. Take the App ID only from `config show`, filtered to the `cli_` id. Nothing in this file reads the App Secret. The human copies the App Secret from the console into `wrangler secret put`. If any output ever shows an App Secret, do not repeat it, and tell the human to reset the App Secret in the console after setup.
- **Preset scopes.** A new Lark CLI app starts with almost no user-identity scopes, so expect to print most of the Scopes block. The connector uses no app-identity (tenant) scopes, and those work with the App ID and App Secret alone, with no user consent: the human removes every app-identity scope before publishing.

## Deploy

From the repository root, run `npm ci`. On the wizard path, run `npm run setup` in a terminal the human can type into. The wizard prints 中文 and English, pauses at each human-only step, generates `COOKIE_SECRET`, and sends every secret on stdin without echoing it. If stdin is not a terminal, do not invent secret answers. Use the wrangler path instead, and let the human type the secrets.

Ask the human for the region. `feishu` is the default. `lark` is the only other valid value. Any other `FEISHU_REGION` is invalid: every route returns 503 with `invalid FEISHU_REGION`, and nothing is sent upstream.

Ask the human for a Worker name. Use lowercase letters, digits, and hyphens, with no leading or trailing hyphen, and at most 63 characters. The config's default name is `lark-general-connector`. Still pass `--name`. Do not omit it.

When `npm run setup` is running, do not run the wrangler commands in this file again. The wizard runs login, the name check, deploy, and secret put itself. You may relay only the human's region and Worker name into the wizard. You never type a secret or an overwrite confirmation.

Wrangler path, also used by the Lark CLI path:

`npx wrangler login`

Stop. Wait for the human. If login fails, stop. Nothing is deployed.

`npx wrangler deployments list --name <worker-name> --json`

Exit 0 means that name already exists. An empty list on exit 0 is still an existing name. Stop. Wait for the human. Do not type the existing Worker name yourself. The human types that name back. Surrounding whitespace is ignored. Any other answer stops, and nothing is deployed. `[code: 10007]` means the name is absent. Continue. Any other result: stop, and do not deploy.

Never write secrets into files, commits or chat. Never deploy over an existing Worker name without the human's confirmation. Never widen scopes, tools or the endpoint allowlist.

Send each secret on stdin, not as a command argument. Do not use `--secrets-file`. Do not write `.dev.vars`. Leave `.dev.vars.example` unchanged. Leave `PUBLIC_URL` empty. Leave `ALLOWED_REDIRECT_URIS` as committed unless the human gives you one extra client redirect to append. Do not remove the existing entries. Do not edit `wrangler.jsonc`, `src/scopes.ts`, `src/feishu/client.ts`, or `src/mcp/server.ts`. Do not add a scope, a tool, or an allowlist entry. Do not add larksuite hosts to the allowlist. The allowlist stays on canonical `*.feishu.cn` method and path pairs, and the region rewrite happens after that check.

### 1. Create the app

Lark CLI path: run `lark-cli config init --new --name <profile> --brand feishu 2>&1 | grep --line-buffered -iv secret` in the background. Give the human the verification URL from its output. Stop. Wait for the human. When it finishes, run `lark-cli --profile <profile> config show 2>&1 | grep -o 'cli_[0-9A-Za-z]*' | sort -u`. Exactly one line is the App ID. Anything else, or a failure: take the fallback.

Manual: print the console URL for the chosen region. Stop. Wait for the human. The human creates the custom app in that console. You do not create it.

The wizard prints `控制台 Console:` and waits on "Create the app".

Stop. Wait for the human. Do not ask for `FEISHU_APP_ID` or `FEISHU_APP_SECRET` in chat. On the wizard path, the human types them into the wizard's hidden prompts before deploy. On the wrangler path, the human types them at the `secret put` prompts in the next step.

### 2. Deploy

Wrangler path:

`npx wrangler deploy --name <worker-name> --var FEISHU_REGION:feishu`

Use `npx wrangler deploy --name <worker-name> --var FEISHU_REGION:lark` when the human chose lark. If deploy fails, stop. No secrets are written.

Copy the https origin wrangler printed. Do not build it from the Worker name. It looks like `https://<worker-name>.example.workers.dev`: the Worker name, then the account subdomain, then `.workers.dev`. `https://<worker-name>.workers.dev` is not this Worker. The callback is that origin plus `/callback`. The MCP URL is that origin plus `/mcp`. On the wizard path, use the Redirect URI and MCP URL the wizard prints. If no origin is printed, ask the human to paste the https origin only, with no user, password, or path.

On the wrangler path, after a successful deploy, put the four values. stdin only. You never type a secret value:

`npx wrangler secret put FEISHU_APP_ID --name <worker-name>`

`npx wrangler secret put FEISHU_APP_SECRET --name <worker-name>`

`openssl rand -hex 32 | npx wrangler secret put COOKIE_SECRET --name <worker-name>`

`npx wrangler secret put OWNER_OPEN_ID --name <worker-name>` with the value `pending`

The human runs the `FEISHU_APP_SECRET` command and pastes the App Secret from the app's Credentials page in the console. The human also runs the `FEISHU_APP_ID` command, except on the Lark CLI path, where you pipe the App ID yourself: `printf '%s' <app-id> | npx wrangler secret put FEISHU_APP_ID --name <worker-name>`. The App ID is not a secret. Run the `COOKIE_SECRET` pipe yourself, and do not capture the `openssl` output. Pipe `pending` into the `OWNER_OPEN_ID` command yourself: `printf pending | npx wrangler secret put OWNER_OPEN_ID --name <worker-name>`. `pending` is not an open_id. Nobody can connect yet. The wizard puts these four values itself, in this order, with `COOKIE_SECRET` generated inside the process.

Print the console URL, the three hosts, `<origin>/callback`, and every line in the Scopes block. Stop. Wait for the human. The human enables every scope in that block, and on an app created by hand, no others. The wizard waits on "Add the scopes".

Lark CLI path: run `lark-cli --profile <profile> auth scopes --json` first, compare its user scopes with the Scopes block, and print only the missing lines. When none are missing, tell the human this part is done. Then have the human open Permissions, switch to the app-identity (tenant_access_token) tab, and remove every scope there before step 4.

### 3. Set the redirect

The redirect URI is `<origin>/callback`. Stop. Wait for the human. The human pastes it into the app. The wizard waits on "Set the redirect". Lark CLI has no command for this; the Lark CLI path does it by hand too.

### 4. Publish

Do this only after the redirect is saved. Stop. Wait for the human. The human enables the Bot capability (机器人) on the custom app before publishing, then publishes the app, or requests the admin approval the console requires. The wizard waits on "Publish".

Lark CLI path: once the human has published, store the owner before anyone connects.

1. `lark-cli --profile <profile> auth login --scope contact:user.base:readonly --no-wait --json`. Give the human the verification URL. Stop. Wait for the human.
2. `lark-cli --profile <profile> auth login --device-code <device-code> >/dev/null 2>&1`. Its success message names the user and their open_id, so discard its output and check only the exit status.
3. `lark-cli --profile <profile> auth status --json | node --experimental-strip-types scripts/owner-open-id.mjs | npx wrangler secret put OWNER_OPEN_ID --name <worker-name>`. The script passes exactly one open_id through and prints nothing else. Never run `auth status` or `auth login --device-code` with its output visible: either prints the open_id.
4. `lark-cli --profile <profile> auth logout >/dev/null 2>&1`.

If any of these fails, pipe `pending` into `OWNER_OPEN_ID` again and take the fallback: steps 6 and 7 below.

### 5. Connect a client

Print `<origin>/mcp`. Stop. Wait for the human. The human adds that URL to Claude or ChatGPT and starts login. Do not log in as the human. The wizard waits on "Connect a client".

Lark CLI path: when the owner was stored in step 4, this login completes and the client lists the tools. Setup is done; skip steps 6 to 8. If the human sees `Owner not configured`, continue with step 6. If the human sees `This Feishu account is not the owner.` without an open_id, pipe `pending` into `OWNER_OPEN_ID`, have the human reconnect, and continue with step 6.

### 6. Bootstrap login shows open_id

The bootstrap page is HTTP 403. The title is `Owner not configured`. The body says `This Feishu account is not the owner.` and shows `open_id:` for this caller only. That denial is the checkpoint. Stop. Wait for the human. Do not copy the open_id into chat or a file.

### 7. Set OWNER_OPEN_ID

Stop. Wait for the human. The value must be an open_id: `ou_` plus letters and digits. `pending` is not one. Do not copy it into chat or a file. On the wizard path, the human types it into the wizard prompt, which reads it without echoing. On the wrangler path, the human runs `npx wrangler secret put OWNER_OPEN_ID --name <worker-name>` and types it on stdin.

### 8. Reconnect

Stop. Wait for the human. The human disconnects the client and connects again to the same `/mcp` URL. The wizard prints that URL again after the owner is saved.

Contacts and chats stay read-only. Do not add message send, or chat create, update, or delete. Doc delete only moves one cloud-space docx to the recycle bin after the exact title is confirmed. Wiki docs are never deletable. Do not change the owner gate, the kill switch, the subrequest budget, or the audit logs. Secrets stay in Cloudflare encrypted secrets.

## Scopes

Enable every line below. On an app created by hand, enable no others. This block is `FEISHU_SCOPES` in `src/scopes.ts`.

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

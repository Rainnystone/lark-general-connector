# lark-general-connector

[中文](./README.zh-CN.md) | English

**Let AI assistants like Claude and ChatGPT read and write your Feishu / Lark docs and look through your chats.**

Once it's set up, you can just say things like this in Claude or ChatGPT:

- "Find last week's Feishu doc about the Q3 budget and summarize it."
- "Clean up these meeting notes and save them as a new Feishu doc."
- "What did the product discussion group talk about today? Did anyone mention me?"
- "Leave a comment on this doc: the numbers need a second check."

This is an open-source "connector": you deploy it into **your own** Cloudflare account, and it becomes a small bridge between your AI assistant and your Feishu. No coding required. Follow the steps below, click through, copy and paste. It takes about 30 minutes.


---

## Contents

- [What it can and cannot do](#what-it-can-and-cannot-do)
- [Is it safe?](#is-it-safe)
- [What you need before you start](#what-you-need-before-you-start)
- [Setup steps](#setup-steps)
- [Connect it to Claude or ChatGPT](#connect-it-to-claude-or-chatgpt)
- [FAQ](#faq)
- [Technical reference (for developers)](#technical-reference-for-developers)

---

## What it can and cannot do

| | Can | Cannot |
| --- | --- | --- |
| **Docs** | Search, read, create, and edit docs; read and add comments; browse wikis; download images inside docs | Delete wiki docs |
| **Deleting docs** | Only regular docs in your own cloud space, only **to the recycle bin** (recoverable), and only after the exact title is confirmed | Permanently delete anything |
| **People** | Look up yourself, look up a colleague's basic info, search people by name | Change the contact directory |
| **Chats** | List your group and one-on-one chats, read and search messages | **Send messages**, create, change, or delete chats. Chats are strictly read-only |

---

## Is it safe?

- **It serves only you.** After setup, the connector remembers your Feishu identity (your open_id). Anyone else who tries to log in is rejected.
- **No third party in the middle.** The connector runs in your own Cloudflare account, and the code is fully open. Your Feishu login tokens live in your own Cloudflare encrypted storage. This repo contains no secrets.
- **It never speaks for you.** It has no ability to send messages, so it can't post anything in Feishu under your name.
- **You can switch it off at any time.** See [How do I shut the connector off in an emergency?](#how-do-i-shut-the-connector-off-in-an-emergency)
- **Logs carry no content.** The connector only records which feature was called, when, and whether it worked. It never logs document or message text.

---

## What you need before you start

1. **A Cloudflare account** (the free plan is enough): <https://dash.cloudflare.com/sign-up>
2. **A Feishu or Lark account that can create a custom app.** If you are an admin of your Feishu organization, you can create and publish it yourself. In a company tenant, publishing may need admin approval (covered below).
3. **Claude or ChatGPT**, on a plan that lets you add custom connectors.

Depending on the deploy path you pick (see below), you also need:

- **Path A**: a GitHub account: <https://github.com/signup>
- **Paths B and C**: Node.js 22.6 or newer on your computer (get the LTS release at <https://nodejs.org>). No GitHub account needed.

---

## Setup steps

Here is the whole flow. **The order matters:**

```
① Create an app in Feishu  →  ② Deploy to Cloudflare  →  ③ Add the callback URL in Feishu
→  ④ Add permissions, enable the bot, publish the app  →  ⑤ Connect in Claude/ChatGPT
→  ⑥ The page turns you away and shows your open_id (this is expected!)
→  ⑦ Put that open_id into Cloudflare  →  ⑧ Reconnect. Done.
```

Why does step ⑥ turn you away? At first the connector doesn't know who its owner is, so it lets nobody in and just tells you "your ID is this". Once you save that ID, the connector treats you as its one and only owner.

There are three ways to deploy. **Pick one. Don't mix them.**

| Path | Best for |
| --- | --- |
| **A. One-click deploy button** (recommended) | People who don't code. Everything happens in the browser. Needs a GitHub account. |
| **B. Command-line wizard** | People comfortable with a terminal. The wizard walks you through each step and generates and stores secrets for you. |
| **C. Hand it to an AI coding agent** | People already using Claude Code, Codex, or similar. Paste one message to it; it downloads the code, deploys, and stops whenever a step needs you. |

Steps ①–⑧ below follow path A. For path B, see [Command-line wizard](#path-b-command-line-wizard); for path C, see [Hand it to an AI coding agent](#path-c-hand-it-to-an-ai-coding-agent). Whichever path you take, steps ①–⑧ are the reference for where to click in Feishu and in Claude or ChatGPT.

### ① Create an app in Feishu

1. Open the developer console: Feishu users go to <https://open.feishu.cn/app>, Lark users go to <https://open.larksuite.com/app>.
2. Click **Create custom app** and give it any name (for example "My AI connector").
3. Open the app, go to **Credentials & Basic Info**, and note the **App ID** and **App Secret**. You'll need them in the next step.

> ⚠️ The App Secret works like a password. Don't share it with anyone or paste it into a chat.

### ② Deploy to Cloudflare

1. Click this button:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Rainnystone/lark-general-connector)

2. Sign in to Cloudflare and GitHub when asked. The button copies the code into your GitHub account and creates the storage it needs.
3. The page asks you for a few values:

   | Field | What to enter |
   | --- | --- |
   | `FEISHU_APP_ID` | The App ID from step ① |
   | `FEISHU_APP_SECRET` | The App Secret from step ① |
   | `COOKIE_SECRET` | A random string used to sign login data. On a Mac, open Terminal, run `openssl rand -hex 32`, and paste the output. Any password generator that gives you 32+ random letters and digits also works. |
   | `OWNER_OPEN_ID` | Enter `pending` for now. You'll change it in step ⑦. |
   | `FEISHU_REGION` | Feishu users keep `feishu`. Lark users change it to `lark`. |

4. Expand **Advanced settings**: choose **create new token**, and **turn off** **Enable preview builds**.
5. Click deploy and wait for it to finish.
6. When it's done, you get a URL that looks like `https://lark-general-connector.<your-subdomain>.workers.dev`. **Write it down.** We'll call it "your connector URL" from here on.

### ③ Add the callback URL in Feishu

Back in your app in the Feishu developer console, open **Security Settings** and add this under **Redirect URLs**:

```
your connector URL/callback
```

For example `https://lark-general-connector.<your-subdomain>.workers.dev/callback`. Save.

### ④ Add permissions, enable the bot, publish the app

1. **Permissions.** Open **Permissions & Scopes** (权限管理) and click **开通权限**. Switch to the **用户身份权限 (user_access_token)** tab before selecting scopes, then enable every item in the [scope list](#scope-list), **no more and no less**. Don't enable them under 应用身份权限 (tenant_access_token). (English console labels may differ.)
2. **Bot.** Enable the Bot capability (机器人) on the custom app before publishing. (Find "Bot" under **Add features** (添加应用能力) and add it; English labels may differ.) Feishu's message APIs require this: without it, reading chats fails with error 230006 "Bot ability is not activated".
3. **Publish.** Open **Version Management & Release**, create a version, and publish it. In a company tenant this may need admin approval; wait until it's approved before you continue.

### ⑤ Connect in Claude or ChatGPT

Add this URL as a custom connector (see [Connect it to Claude or ChatGPT](#connect-it-to-claude-or-chatgpt) for where):

```
your connector URL/mcp
```

An authorization flow opens: first a confirmation page, click **Approve**; then the Feishu login page, where you log in and grant access.

### ⑥ You see an "Owner not configured" page. That's expected.

After login you land on a page titled **Owner not configured**. It says this Feishu account is not the owner, followed by a line like:

```
open_id: ou_xxxxxxxxxxxxxxxx
```

**This is exactly what we want.** Copy the string starting with `ou_`. That's your Feishu identity ID.

### ⑦ Put the open_id into Cloudflare

1. Open the Cloudflare dashboard at <https://dash.cloudflare.com>, go to **Workers & Pages**, and open your connector.
2. Go to **Settings → Variables and Secrets**.
3. Find `OWNER_OPEN_ID`, change its value from `pending` to the open_id you just copied, and save.

### ⑧ Reconnect

Back in Claude or ChatGPT, **disconnect** the connector, then **connect it again** with the same `/mcp` URL. This time login succeeds.

🎉 Done! You can now ask your AI assistant to work with your Feishu.

### Path B: command-line wizard

You need Node.js 22.6 or newer. First get the code onto your computer, either way:

- With git: run `git clone https://github.com/Rainnystone/lark-general-connector.git` in a terminal. You get a `lark-general-connector` folder.
- Without git: download <https://github.com/Rainnystone/lark-general-connector/archive/refs/heads/main.zip> and unzip it. You get a `lark-general-connector-main` folder.

Then open a terminal in that folder and run:

```bash
npm ci && npm run setup
```

The wizard prints every prompt in Chinese and English and follows the same ①–⑧ order as above. The differences:

- It logs you into Cloudflare (`wrangler login`), deploys, and pauses at every step where you need to do something in Feishu.
- You type the App ID, App Secret, and open_id into the terminal. **They are not shown on screen and never written to a file.**
- It generates `COOKIE_SECRET` for you and sets `OWNER_OPEN_ID` to `pending` at first.
- It prints the callback URL, the `/mcp` URL, and the full scope list, ready to copy.
- If the Worker name you pick already exists in your account, it asks you to type the name again to confirm, so you don't overwrite something by accident.

### Path C: hand it to an AI coding agent

You need Node.js 22.6 or newer, and an AI coding agent that can run commands on your computer (for example Claude Code or Codex).

Open it in an empty folder and send it this message:

```
Download https://github.com/Rainnystone/lark-general-connector into this folder, then follow AGENTS.md in the repository to deploy it into my own Cloudflare account. Stop and wait for me at every step I need to do.
```

[AGENTS.md](./AGENTS.md) is the deploy runbook written for the agent. Roughly, the split is:

- **The agent**: downloads the code, logs into Cloudflare (a browser window opens for you to approve), checks the Worker name, deploys, and prints the callback URL, the scope list, and the `/mcp` URL for you.
- **You**: the Feishu developer console (①③④), connecting in Claude or ChatGPT (⑤⑥), and **typing the secrets yourself**. You enter the App ID, App Secret, and open_id in the terminal; don't paste them into the chat. The agent tells you where to type them.

---

## Connect it to Claude or ChatGPT

> Menu names may change between versions. This is roughly where to look.

**Claude**: open **Customize → Connectors → + Add → Add custom connector**. Any name is fine; set the URL to `your connector URL/mcp`. On Team/Enterprise, an Owner first adds it under **Organization settings → Connectors**, then you click **Connect**. The Free plan allows one custom connector.

**ChatGPT**: open **Settings → Apps → Advanced settings** and turn on **Developer mode**, then go to **Apps → Create**. Enter the URL `your connector URL/mcp`, choose **OAuth**, click **Scan Tools**, then **Create**. Some accounts show **Plugins → + → Add custom MCP server** instead. Plan availability and labels change over time, so check what your ChatGPT UI shows.

Other clients that support OAuth remote MCP should also work, but first add their callback URL to `ALLOWED_REDIRECT_URIS` (see [Configuration](#configuration)). Only Claude and ChatGPT have been tested.

---

## FAQ

### Login shows "Owner not configured". Is it broken?

The first time you connect, this is **expected**. See step ⑥. If you've already set `OWNER_OPEN_ID` and still see it, check that the value starts with `ou_`, has no extra spaces, and was saved.

### It says "This Feishu account is not the owner."

The Feishu account you logged in with isn't the one in `OWNER_OPEN_ID`. Log in with the owner's account.

### The AI says "Feishu authorization expired; reconnect the connector"

Your Feishu authorization expired (for example, after a long time unused). Disconnect the connector in Claude or ChatGPT and connect it again with the same URL.

### My company's Feishu won't let me create or publish the app

Company tenants usually need admin approval. Submit the request when you publish, as the console prompts, and wait for your admin to approve it. Getting permissions and approval is the deployer's responsibility.

### How do I shut the connector off in an emergency?

No redeploy needed. In the Cloudflare dashboard → your connector → **Settings → Variables and Secrets**, add a variable `MCP_DISABLED` with the value `1` and save. The connector stops answering right away. To turn it back on, delete the variable or set it to `0`.

### Something isn't working on Lark

Lark support is beta. If a feature misbehaves, you don't need to change code. Follow the [Region](#region) section and set `TOOL_BACKENDS` so every tool uses openapi.

### Does it cost anything?

The Cloudflare Workers free plan is usually enough for one person. Feishu custom apps are free.

---

## Technical reference (for developers)

Everything below is for people who want implementation details or need to change configuration. Regular users can skip it.

### Architecture

The Worker is an OAuth authorization server for connector clients and the MCP resource server at `/mcp`. It is a thin proxy. It does not reimplement Feishu. A proxied tool calls Feishu's remote MCP unless its default or `TOOL_BACKENDS` selects OpenAPI. `search_docs` defaults to OpenAPI. Direct tools always call OpenAPI. The endpoint allowlist is a fixed list of method and path pairs on canonical `*.feishu.cn` hosts. The allowlist is checked before any host rewrite, so a region change cannot add endpoints.

Login finishes, and `/mcp` answers, only when the Feishu open_id equals `OWNER_OPEN_ID`. Any other value, including `pending` or a blank, counts as not configured: nobody can connect, and the bootstrap page shows only the caller's own open_id.

`OAUTH_KV` stores OAuth state. `FEISHU_TOKENS` is a SQLite Durable Object, class `FeishuTokenStore`, migration `v1`, and holds the owner's Feishu tokens. One invocation may make at most 40 outbound calls. Secrets stay in Cloudflare encrypted secrets. The repo does not contain secret values.

Sixteen tools:

- Docs: `search_docs`, `fetch_doc`, `list_wiki_docs`, `get_doc_comments`, `create_doc`, `update_doc`, `add_doc_comment`, `fetch_doc_media`, `delete_doc`
- People: `whoami`, `get_user`, `search_users`
- Chats, read-only: `list_chats`, `list_chat_messages`, `search_messages`, `get_message`

### Configuration

| Kind | Name | Default | Notes |
| --- | --- | --- | --- |
| Secret | `FEISHU_APP_ID` | — | Prompted. App ID from the open-platform credentials page. Listed in `.dev.vars.example`. |
| Secret | `FEISHU_APP_SECRET` | — | Prompted. App Secret from the same page. |
| Secret | `COOKIE_SECRET` | — | Prompted. `openssl rand -hex 32`. The wizard generates it. Signs the login cookie. |
| Secret | `OWNER_OPEN_ID` | `pending` | Prompted. A value that is not an open_id (`ou_` plus letters and digits) is not configured. |
| Committed var | `FEISHU_REGION` | `feishu` | `feishu` means Feishu. `lark` means Lark. Any other value returns 503 on every route and sends nothing upstream. |
| Dashboard var | `PUBLIC_URL` | unset | Optional override. Unset uses the request's own origin. Set a full origin only to pin a custom domain. |
| Committed var | `ALLOWED_REDIRECT_URIS` | Claude and ChatGPT callbacks | Comma-separated. Append other clients. Allowed CORS hosts are these hostnames, the Worker's own host, and `localhost`. |
| Dashboard var | `MCP_DISABLED` | unset | Kill switch. See below. `keep_vars` retains it. Not prompted. |
| Dashboard var | `TOOL_BACKENDS` | unset | Per-tool `mcp` or `openapi`. See below. `keep_vars` retains it. Not prompted. |
| Dashboard var | `P2P_DISCOVERY` | unset | `auto`, `types_param`, or `search`. See below. `keep_vars` retains it. Not prompted. |
| Binding | `OAUTH_KV` | auto-provisioned | KV namespace. No id in config. |
| Binding | `FEISHU_TOKENS` | Durable Object `FeishuTokenStore`, migration `v1` | Owner token store. |

The committed default of `ALLOWED_REDIRECT_URIS` is `https://claude.ai/api/mcp/auth_callback,https://chatgpt.com/connector_platform_oauth_redirect,https://chatgpt.com/connector/oauth/`.

Dashboard vars are not in `wrangler.jsonc`. A committed var with the same name as a secret would break deploy, so the four secrets are not committed vars either.

### Region

`FEISHU_REGION` selects the hosts. Source literals stay on Feishu hosts. Just before fetch, and for the browser authorize redirect, the Worker rewrites:

| Feishu | Lark |
| --- | --- |
| `open.feishu.cn` | `open.larksuite.com` |
| `accounts.feishu.cn` | `accounts.larksuite.com` |
| `mcp.feishu.cn` | `mcp.larksuite.com` |

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

### Scope list

Enable every line below in your app in the Feishu developer console, and no others. This list matches `src/scopes.ts`; the wizard and [AGENTS.md](./AGENTS.md) print the same list.

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

### Disclaimers

Feishu or Lark permissions and admin approval are the deployer's responsibility. The official Feishu remote MCP may change or be retired. The OpenAPI fallback is `TOOL_BACKENDS`, including the Lark recipe above, and needs no code change. Cloudflare Workers free-plan limits apply, in addition to the connector's own cap of 40 outbound calls per invocation.

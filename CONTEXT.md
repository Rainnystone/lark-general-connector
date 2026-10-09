# Feishu connector

The Worker acts as one owner in Feishu and exposes that owner's documents and chats to a connector client.

## Language

**Owner**:
The single human this Worker acts for, identified by their Feishu open_id for this app.
_Avoid_: user, admin

**Connector client**:
Any OAuth MCP client of the Worker.
_Avoid_: app, plugin

**Worker**:
This Cloudflare Worker. It is both the authorization server for connector clients and the MCP resource server.
_Avoid_: proxy, bridge

**Grant**:
The OAuth authorization the Worker issued to one connector client for the owner.
_Avoid_: session

**Upstream login**:
The Feishu OAuth step the Worker runs inside its own authorize flow.
_Avoid_: SSO

**UAT**:
The Feishu user_access_token for the owner.
_Avoid_: access token

**Feishu refresh token**:
The single-use token that rotates on every refresh.
_Avoid_: refresh token

**Token store**:
The per-owner SQLite Durable Object that holds Feishu tokens and serializes refresh.

**Re-auth**:
The state where Feishu tokens are dead and the owner must reconnect the connector.

**Owner gate**:
The open_id check that rejects any Feishu account other than the owner.

**Kill switch**:
The control that stops all tools without a deploy.

**Audit event**:
One content-free structured log line in Workers Logs.

**Proxied tool**:
A tool whose default backend is Feishu's remote MCP.
_Avoid_: passthrough

**Direct tool**:
A tool implemented only on Feishu OpenAPI.

**Backend switch**:
The control choosing mcp or openapi per proxied tool.

**Cloud-space doc**:
A doc owned in the owner's drive, not inside a wiki space.
_Avoid_: file

**Wiki doc**:
A doc that is a node in a wiki space.

**Recycle bin**:
The drive trash where deleting a cloud-space doc sends it.

**Title confirmation**:
The argument that must equal the doc's real title before a cloud-space doc can be deleted.

**Group chat**:
A chat whose chat_mode is group.

**Topic chat**:
A chat whose chat_mode is topic. The group filter includes it, and the row stays labeled topic.

**p2p chat**:
A chat whose chat_mode is p2p.
_Avoid_: DM

**Chat discovery**:
Listing the owner's chats, including p2p, by the types parameter or the message-search fallback.

**P2p discovery**:
The `P2P_DISCOVERY` control for chat discovery: `auto`, `types_param`, or `search`.

**Page cap**:
The maximum number of Feishu pages one tool call fetches before it returns a continuation token.

**Probe**:
Removed. The temporary read-only tool is gone.

**Endpoint allowlist**:
The fixed list of Feishu method and path pairs the Worker may call.

**NEVER list**:
The owner's forbidden scopes and actions.

**Subrequest budget**:
The per-invocation cap on outbound calls.

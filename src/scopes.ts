/** User-identity scopes requested from Feishu. Exact L14 set; nothing from the NEVER list. */
export const FEISHU_SCOPES = [
  "search:docs:read",
  "docx:document:readonly",
  "wiki:wiki:readonly",
  "wiki:node:read",
  "space:document:retrieve",
  "docs:document.comment:read",
  "docs:document.media:download",
  "board:whiteboard:node:read",
  "task:task:read",
  "contact:contact.base:readonly",
  "contact:user.base:readonly",
  "contact:user:search",
  "docx:document:create",
  "docx:document:write_only",
  "wiki:node:create",
  "docs:document.media:upload",
  "board:whiteboard:node:create",
  "docs:document.comment:create",
  "space:document:delete",
  "im:chat:read",
  "im:message:readonly",
  "im:message.group_msg:get_as_user",
  "im:message.p2p_msg:get_as_user",
  "search:message",
  "offline_access",
] as const;

export function feishuScopeString(): string {
  return FEISHU_SCOPES.join(" ");
}

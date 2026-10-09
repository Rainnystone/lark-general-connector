import { stringField } from "../feishu/docs";
import { asRecord } from "../feishu/payload";

export const P2P_DISCOVERY_MODES = ["auto", "types_param", "search"] as const;

export type P2pDiscoveryMode = (typeof P2P_DISCOVERY_MODES)[number];

/** p2p search pages inside one list_chats call. Five plus the chat-list cap stays under 40 outbound calls. */
export const P2P_SEARCH_PAGE_CAP = 5;
export const P2P_SEARCH_PAGE_SIZE = 30;
export const P2P_SEARCH_FREQUENCY = 99991400;
export const P2P_SEARCH_LIMIT = "Message search is limited to 100 requests per minute. Retry shortly.";
export const P2P_SEARCH_NOTE = "p2p chats discovered by search may be incomplete; only chats with searchable messages are listed";
export const P2P_CURSOR = "p2psearch:";

export interface SearchMeta {
  messageId: string;
  chatId: string;
  senderId: string;
  createTime: string;
  type: string;
  p2p: boolean | null;
}

export function messageSearchUrl(pageSize: number, pageToken?: string): string {
  const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages/search");
  url.searchParams.set("page_size", String(pageSize));
  if (pageToken) url.searchParams.set("page_token", pageToken);
  return url.toString();
}

export function searchItemMeta(item: unknown): SearchMeta | null {
  const meta = asRecord(asRecord(item).meta_data);
  const messageId = stringField(meta, "message_id");
  const chatId = stringField(meta, "chat_id");
  if (messageId.length === 0 && chatId.length === 0) return null;
  return {
    messageId,
    chatId,
    senderId: stringField(meta, "from_id"),
    createTime: stringField(meta, "create_time"),
    type: stringField(meta, "type"),
    p2p: typeof meta.is_p2p_chat === "boolean" ? meta.is_p2p_chat : null,
  };
}

export function p2pSearchRequest(pageToken?: string): { url: string; body: string } {
  return {
    url: messageSearchUrl(P2P_SEARCH_PAGE_SIZE, pageToken),
    body: JSON.stringify({ query: "", filter: { chat_type: "p2p" } }),
  };
}

export function p2pSearchHits(data: Record<string, unknown>): SearchMeta[] {
  const items = Array.isArray(data.items) ? data.items : [];
  const hits: SearchMeta[] = [];
  for (const item of items) {
    const meta = searchItemMeta(item);
    if (!meta || meta.chatId.length === 0) continue;
    hits.push(meta);
  }
  return hits;
}

/** Dashboard var. Empty or unknown values use `auto`. */
export function p2pDiscoveryMode(raw: string | undefined): P2pDiscoveryMode {
  switch (raw) {
    case "auto":
    case "types_param":
    case "search":
      return raw;
    default:
      return "auto";
  }
}

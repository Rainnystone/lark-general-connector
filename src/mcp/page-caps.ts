/**
 * Pages one OpenAPI call may fetch for list_wiki_docs and get_doc_comments.
 * search_docs makes one search request per invocation.
 * Worst case is this many calls plus one wiki get_node.
 */
export const DOC_READ_PAGE_CAP = 10;

/**
 * Pages one call may fetch for list_chats and list_chat_messages.
 * list_chats may also retry the first page without the types parameter,
 * then up to P2P_SEARCH_PAGE_CAP search pages. Each kept page resolves names.
 * list_chat_messages resolves names per kept page. Worst case stays under 40 outbound calls.
 */
export const CHAT_PAGE_CAP = 10;

/**
 * search_messages and search_users fetch one Feishu page and return page_token.
 * The assistant continues; this call does not loop.
 */
export const CALLER_PAGE_CAP = 1;

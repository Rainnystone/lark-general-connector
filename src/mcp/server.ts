import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../env";
import { callGetMessage, callListChatMessages, callListChats, CHAT_KINDS, MESSAGE_ORDERS } from "./chats";
import { callSearchMessages, MESSAGE_CHAT_TYPES, MESSAGE_SENDER_TYPES } from "./messages";
import { callGetUser, callSearchUsers } from "./contacts";
import { callFetchDocMedia } from "./doc-media";
import { callFetchDoc, callGetDocComments, callListWikiDocs, callSearchDocs } from "./doc-read";
import { callDeleteDoc } from "./doc-delete";
import { BITABLE_ACTIONS, WRITE_BITABLE_ACTIONS, callReadBitable, callWriteBitable } from "./doc-bitable";
import { callReadSheet, callWriteSheet, INSERT_DATA_OPTIONS, SHEET_ACTIONS, VALUE_RENDER_OPTIONS, WRITE_SHEET_ACTIONS } from "./doc-sheet";
import { SLIDES_ACTIONS, callReadSlides } from "./doc-slides";
import { callAddDocComment, callCreateDoc, callUpdateDoc, UPDATE_DOC_MODES } from "./doc-write";
import { callWhoami } from "./tools";

export const SERVER_INSTRUCTIONS =
  "This server acts as the owner in Feishu. It reads and writes the owner's docs. Chats are read-only: it cannot send or change messages. Delete moves one cloud-space docx to the recycle bin only when the exact title is confirmed. Wiki docs are never deleted.";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const writing = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const deleteDocAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export function createFeishuServer(env: Env, openId: string): McpServer {
  const server = new McpServer({ name: "lark-general-connector", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  server.registerTool(
    "whoami",
    {
      title: "Who am I in Feishu",
      description: "Returns the owner's Feishu name and open_id.",
      annotations: readOnly,
    },
    async () => callWhoami(env, openId),
  );
  server.registerTool(
    "search_docs",
    {
      title: "Search Feishu docs",
      description: "Search the owner's cloud-space and wiki docs. The query is limited to 30 characters.",
      annotations: readOnly,
      inputSchema: z.object({
        query: z.string(),
        page_token: z.string().optional(),
        count: z.number().int().optional(),
      }),
    },
    async (args) => callSearchDocs(env, openId, args),
  );
  server.registerTool(
    "fetch_doc",
    {
      title: "Read a Feishu doc",
      description:
        "Read a Feishu doc from its URL or token. offset and limit count Unicode code points and are passed to Feishu. When limit is omitted or larger than one page, one page that fits the response cap is requested. If more remains, the result includes next_offset.",
      annotations: readOnly,
      inputSchema: z.object({
        doc: z.string(),
        offset: z.number().int().optional(),
        limit: z.number().int().optional(),
      }),
    },
    async (args) => callFetchDoc(env, openId, args),
  );
  server.registerTool(
    "list_wiki_docs",
    {
      title: "List wiki docs",
      description: "List docs in a wiki space or under a wiki node.",
      annotations: readOnly,
      inputSchema: z.object({
        space_id: z.string().optional(),
        node_token: z.string().optional(),
        page_token: z.string().optional(),
      }),
    },
    async (args) => callListWikiDocs(env, openId, args),
  );
  server.registerTool(
    "get_doc_comments",
    {
      title: "Read doc comments",
      description: "Read comments on a Feishu doc.",
      annotations: readOnly,
      inputSchema: z.object({
        doc: z.string(),
        page_token: z.string().optional(),
      }),
    },
    async (args) => callGetDocComments(env, openId, args),
  );
  server.registerTool(
    "create_doc",
    {
      title: "Create a Feishu doc",
      description: "Create a Feishu doc in the owner's cloud space or under a wiki node. MCP is the default and writes markdown. The openapi backend stores the content as plain text.",
      annotations: writing,
      inputSchema: z.object({
        title: z.string(),
        content_markdown: z.string(),
        wiki_node_token: z.string().optional(),
        folder_token: z.string().optional(),
      }),
    },
    async (args) => callCreateDoc(env, openId, args),
  );
  server.registerTool(
    "update_doc",
    {
      title: "Update a Feishu doc",
      description: "Update a Feishu doc. MCP is the default for overwrite and range modes. The openapi backend only appends, and stores the content as plain text.",
      annotations: destructive,
      inputSchema: z.object({
        doc: z.string(),
        mode: z.enum(UPDATE_DOC_MODES),
        content_markdown: z.string(),
        selection_with_ellipsis: z.string().optional(),
        selection_by_title: z.string().optional(),
        new_title: z.string().optional(),
      }),
    },
    async (args) => callUpdateDoc(env, openId, args),
  );
  server.registerTool(
    "add_doc_comment",
    {
      title: "Comment on a doc",
      description: "Add a whole-document comment to a Feishu doc.",
      annotations: writing,
      inputSchema: z.object({
        doc: z.string(),
        text: z.string(),
      }),
    },
    async (args) => callAddDocComment(env, openId, args),
  );
  server.registerTool(
    "get_user",
    {
      title: "Look up a colleague",
      description: "Look up a colleague by id. Returns name, English name and avatar.",
      annotations: readOnly,
      inputSchema: z.object({
        user_id: z.string(),
        id_type: z.string().optional(),
      }),
    },
    async (args) => callGetUser(env, openId, args),
  );
  server.registerTool(
    "search_users",
    {
      title: "Search colleagues",
      description: "Search colleagues by name.",
      annotations: readOnly,
      inputSchema: z.object({
        query: z.string(),
        page_token: z.string().optional(),
      }),
    },
    async (args) => callSearchUsers(env, openId, args),
  );
  server.registerTool(
    "read_sheet",
    {
      title: "Read a Feishu sheet",
      description:
        "Read a Feishu sheet from a URL, wiki node token, or sheet token. Call action meta first to get sheet_id. action values reads range sheetId!A1:C2. Use value_render_option FormattedValue (or UnformattedValue) to get computed values; ToString (default) returns the formula text. Formula returns the formula itself.",
      annotations: readOnly,
      inputSchema: z.object({
        doc: z.string(),
        action: z.enum(SHEET_ACTIONS),
        range: z.string().optional(),
        value_render_option: z.enum(VALUE_RENDER_OPTIONS).optional(),
      }),
    },
    async (args) => callReadSheet(env, openId, args),
  );
  server.registerTool(
    "write_sheet",
    {
      title: "Write a Feishu sheet",
      description:
        'Create or write a Feishu sheet from a URL, wiki node token, or sheet token. action create uses title and optional folder_token (default root). put overwrites range sheetId!A1:C2. append uses insert_data_option INSERT_ROWS or OVERWRITE. batch_update writes value_ranges. Cell values are forwarded as-is. A plain string "=..." is stored as text; formulas need {type:"formula",text}.',
      annotations: writing,
      inputSchema: z.object({
        action: z.enum(WRITE_SHEET_ACTIONS),
        doc: z.string().optional(),
        title: z.string().optional(),
        folder_token: z.string().optional(),
        range: z.string().optional(),
        values: z.array(z.array(z.any())).optional(),
        insert_data_option: z.enum(INSERT_DATA_OPTIONS).optional(),
        value_ranges: z.array(z.object({ range: z.string(), values: z.array(z.array(z.any())) })).optional(),
      }),
    },
    async (args) => callWriteSheet(env, openId, args),
  );
  server.registerTool(
    "read_bitable",
    {
      title: "Read a Feishu Base",
      description:
        "Read a Feishu Base (bitable) from a URL, wiki node token, or app token. action app returns app info. action tables and fields pass page_token through. action records reads Base v3 records (offset, limit ≤ 200, optional view_id) in Feishu's columnar shape (fields, field_type_list, record_id_list, data, has_more). table_id is required for fields and records.",
      annotations: readOnly,
      inputSchema: z.object({
        doc: z.string(),
        action: z.enum(BITABLE_ACTIONS),
        table_id: z.string().optional(),
        page_token: z.string().optional(),
        offset: z.number().int().optional(),
        limit: z.number().int().optional(),
        view_id: z.string().optional(),
      }),
    },
    async (args) => callReadBitable(env, openId, args),
  );
  server.registerTool(
    "write_bitable",
    {
      title: "Write a Feishu Base",
      description:
        "Create or write a Feishu Base (bitable) from a URL, wiki node token, or app token. action create_app uses name and optional folder_token (default root). A new Base's default table has about 10 empty rows. create_field uses table_id, field_name, type, and optional property. create_record uses table_id and fields. update_record uses table_id, record_id, and fields. update_field uses table_id, field_id, field_name, type, and optional property. delete_field and delete_record are irreversible, need no title confirmation, and are allowed on wiki-hosted Bases.",
      annotations: destructive,
      inputSchema: z.object({
        action: z.enum(WRITE_BITABLE_ACTIONS),
        doc: z.string().optional(),
        name: z.string().optional(),
        folder_token: z.string().optional(),
        table_id: z.string().optional(),
        field_name: z.string().optional(),
        type: z.number().int().optional(),
        property: z.record(z.string(), z.any()).optional(),
        fields: z.record(z.string(), z.any()).optional(),
        record_id: z.string().optional(),
        field_id: z.string().optional(),
      }),
    },
    async (args) => callWriteBitable(env, openId, args),
  );
  server.registerTool(
    "read_slides",
    {
      title: "Read a Feishu slides deck",
      description:
        "Read a Feishu slides deck from a URL, wiki node token, or slides token. action get returns Feishu SML XML content, presentation_id, and revision_id as-is.",
      annotations: readOnly,
      inputSchema: z.object({
        doc: z.string(),
        action: z.enum(SLIDES_ACTIONS),
      }),
    },
    async (args) => callReadSlides(env, openId, args),
  );
  server.registerTool(
    "fetch_doc_media",
    {
      title: "Fetch doc image/whiteboard",
      description: "Fetch an image or whiteboard embedded in a Feishu doc. Images over 1 MB return metadata only.",
      annotations: readOnly,
      inputSchema: z.object({
        doc: z.string().optional(),
        media_token: z.string().optional(),
        whiteboard_id: z.string().optional(),
      }),
    },
    async (args) => callFetchDocMedia(env, openId, args),
  );
  server.registerTool(
    "list_chats",
    {
      title: "List my chats",
      description: "List the owner's group and p2p chats.",
      annotations: readOnly,
      inputSchema: z.object({
        kind: z.enum(CHAT_KINDS).optional(),
        page_token: z.string().optional(),
      }),
    },
    async (args) => callListChats(env, openId, args),
  );
  server.registerTool(
    "list_chat_messages",
    {
      title: "Read chat messages",
      description: "Read messages in one of the owner's chats. start_time and end_time are ISO 8601 with a timezone, or unix seconds. This cannot send, edit, or react.",
      annotations: readOnly,
      inputSchema: z.object({
        chat_id: z.string(),
        start_time: z.string().optional().describe("ISO 8601 with a timezone (Z or ±HH:MM), or unix seconds. Date-only values and milliseconds are rejected."),
        end_time: z.string().optional().describe("ISO 8601 with a timezone (Z or ±HH:MM), or unix seconds. Date-only values and milliseconds are rejected."),
        order: z.enum(MESSAGE_ORDERS).optional(),
        page_token: z.string().optional(),
        page_size: z.number().int().optional(),
      }),
    },
    async (args) => callListChatMessages(env, openId, args),
  );
  server.registerTool(
    "search_messages",
    {
      title: "Search my messages",
      description: "Search the owner's messages. This cannot send, edit, or react. Times are ISO 8601.",
      annotations: readOnly,
      inputSchema: z.object({
        query: z.string().optional(),
        chat_ids: z.array(z.string()).optional(),
        from_ids: z.array(z.string()).optional().describe("Sender open_ids only (ou_…). Not app ids."),
        from_types: z.array(z.enum(MESSAGE_SENDER_TYPES)).optional().describe("Sender kinds to include."),
        exclude_from_types: z.array(z.enum(MESSAGE_SENDER_TYPES)).optional().describe("Sender kinds to exclude."),
        chat_type: z.enum(MESSAGE_CHAT_TYPES).optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        is_at_me: z.boolean().optional(),
        page_token: z.string().optional(),
        page_size: z.number().int().optional(),
      }),
    },
    async (args) => callSearchMessages(env, openId, args),
  );
  server.registerTool(
    "delete_doc",
    {
      title: "Move a doc to the recycle bin",
      description:
        "Move one docx in the owner's cloud space to the recycle bin (回收站), where it can be restored. Wiki docs are refused. Requires the doc's exact title.",
      annotations: deleteDocAnnotations,
      inputSchema: z.object({
        doc: z.string(),
        confirm_title: z.string(),
      }),
    },
    async (args) => callDeleteDoc(env, openId, args),
  );
  server.registerTool(
    "get_message",
    {
      title: "Read one message",
      description: "Read one of the owner's messages in full. This cannot send, edit, or react.",
      annotations: readOnly,
      inputSchema: z.object({
        message_id: z.string(),
      }),
    },
    async (args) => callGetMessage(env, openId, args),
  );
  return server;
}

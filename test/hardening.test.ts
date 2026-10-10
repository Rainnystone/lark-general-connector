import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { endpointAllowlist, isEndpointAllowed, OUTBOUND_LIMIT } from "../src/feishu/client";
import { CHAT_PAGE_CAP, CALLER_PAGE_CAP, DOC_READ_PAGE_CAP } from "../src/mcp/page-caps";
import { P2P_SEARCH_PAGE_CAP } from "../src/mcp/p2p-discovery";
import { SERVER_INSTRUCTIONS } from "../src/mcp/server";
import { callTool, initialize, listTools, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

/** Spec tool catalogue after ticket 08 removes the temporary probe. */
const CATALOGUE = [
  { name: "whoami", title: "Who am I in Feishu", readOnly: true, destructive: false },
  { name: "search_docs", title: "Search Feishu docs", readOnly: true, destructive: false },
  { name: "fetch_doc", title: "Read a Feishu doc", readOnly: true, destructive: false },
  { name: "list_wiki_docs", title: "List wiki docs", readOnly: true, destructive: false },
  { name: "get_doc_comments", title: "Read doc comments", readOnly: true, destructive: false },
  { name: "create_doc", title: "Create a Feishu doc", readOnly: false, destructive: false },
  { name: "update_doc", title: "Update a Feishu doc", readOnly: false, destructive: true },
  { name: "add_doc_comment", title: "Comment on a doc", readOnly: false, destructive: false },
  { name: "get_user", title: "Look up a colleague", readOnly: true, destructive: false },
  { name: "search_users", title: "Search colleagues", readOnly: true, destructive: false },
  { name: "fetch_doc_media", title: "Fetch doc image/whiteboard", readOnly: true, destructive: false },
  { name: "read_sheet", title: "Read a Feishu sheet", readOnly: true, destructive: false },
  { name: "write_sheet", title: "Write a Feishu sheet", readOnly: false, destructive: true },
  { name: "read_bitable", title: "Read a Feishu Base", readOnly: true, destructive: false },
  { name: "write_bitable", title: "Write a Feishu Base", readOnly: false, destructive: true },
  { name: "read_slides", title: "Read a Feishu slides deck", readOnly: true, destructive: false },
  { name: "write_slides", title: "Write a Feishu slides deck", readOnly: false, destructive: true },
  { name: "read_file", title: "Read a Feishu file", readOnly: true, destructive: false },
  { name: "write_file", title: "Write a Feishu file", readOnly: false, destructive: false },
  { name: "read_mindnote", title: "Read a Feishu mindnote", readOnly: true, destructive: false },
  { name: "list_chats", title: "List my chats", readOnly: true, destructive: false },
  { name: "list_chat_messages", title: "Read chat messages", readOnly: true, destructive: false },
  { name: "search_messages", title: "Search my messages", readOnly: true, destructive: false },
  { name: "get_message", title: "Read one message", readOnly: true, destructive: false },
  { name: "delete_doc", title: "Move a doc to the recycle bin", readOnly: false, destructive: true },
] as const;

describe("tool catalogue", () => {
  it("lists exactly the spec catalogue, with titles and hints", async () => {
    const { accessToken } = await login();
    const tools = await listTools(accessToken);
    expect(tools.map((tool) => tool.name).sort()).toEqual(CATALOGUE.map((tool) => tool.name).sort());
    for (const expected of CATALOGUE) {
      const tool = tools.find((entry) => entry.name === expected.name);
      expect(tool?.title).toBe(expected.title);
      expect(String(tool?.name).length).toBeLessThanOrEqual(64);
      expect(String(tool?.name)).toMatch(/^[a-z0-9_]+$/);
      const annotations = tool?.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; idempotentHint?: boolean };
      expect(annotations.readOnlyHint).toBe(expected.readOnly);
      expect(annotations.destructiveHint).toBe(expected.destructive);
      if (expected.readOnly) expect(annotations.openWorldHint).toBe(true);
      if (expected.name === "delete_doc") expect(annotations.idempotentHint).toBe(false);
    }
  });
});

describe("server instructions", () => {
  it("keeps the first 512 characters self-contained", async () => {
    const head = SERVER_INSTRUCTIONS.slice(0, 512);
    expect(head).toContain("acts as the owner");
    expect(head).toContain("reads and writes");
    expect(head).toMatch(/chats are read-only/i);
    expect(head).toContain("docx");
    expect(head).toContain("recycle bin");
    expect(head).toContain("exact title");
    expect(head).toMatch(/wiki docs are never deleted/i);
    const { accessToken } = await login();
    const body = await initialize(accessToken);
    const result = (body as { result?: { instructions?: string } }).result;
    expect(result?.instructions?.slice(0, 512)).toBe(head);
  });
});

/**
 * Reviewed against Spec L3, L4, L5, L7, L9, L10 and D3.
 * A new Feishu call has to show up here before it can leave the Worker.
 */
const ALLOWLIST = [
  "DELETE open.feishu.cn ^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/fields/[^/]+$",
  "DELETE open.feishu.cn ^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/records/[^/]+$",
  "DELETE open.feishu.cn ^/open-apis/drive/v1/files/[^/]+$ type=docx|sheet|bitable|slides|file",
  "DELETE open.feishu.cn ^/open-apis/slides_ai/v1/xml_presentations/[^/]+/slide$",
  "GET open.feishu.cn ^/open-apis/authen/v1/user_info$",
  "GET open.feishu.cn ^/open-apis/base/v3/bases/[^/]+/tables/[^/]+/records$",
  "GET open.feishu.cn ^/open-apis/bitable/v1/apps/[^/]+$",
  "GET open.feishu.cn ^/open-apis/bitable/v1/apps/[^/]+/tables$",
  "GET open.feishu.cn ^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/fields$",
  "GET open.feishu.cn ^/open-apis/board/v1/whiteboards/[^/]+/nodes$",
  "GET open.feishu.cn ^/open-apis/contact/v3/users/(?!batch$|batch_get_id$|find_by_department$)[^/]+$",
  "GET open.feishu.cn ^/open-apis/contact/v3/users/batch$",
  "GET open.feishu.cn ^/open-apis/docx/v1/documents/[^/]+$",
  "GET open.feishu.cn ^/open-apis/docx/v1/documents/[^/]+/raw_content$",
  "GET open.feishu.cn ^/open-apis/drive/v1/files/[^/]+/comments$",
  "GET open.feishu.cn ^/open-apis/drive/v1/files/[^/]+/download$",
  "GET open.feishu.cn ^/open-apis/drive/v1/medias/[^/]+/download$",
  "GET open.feishu.cn ^/open-apis/im/v1/chats$",
  "GET open.feishu.cn ^/open-apis/im/v1/messages$",
  "GET open.feishu.cn ^/open-apis/im/v1/messages/om_[^/]+$",
  "GET open.feishu.cn ^/open-apis/mindnote/v1/mindnotes/[^/]+/nodes$",
  "GET open.feishu.cn ^/open-apis/search/v1/user$",
  "GET open.feishu.cn ^/open-apis/sheets/v2/spreadsheets/[^/]+/values/[^/]+$",
  "GET open.feishu.cn ^/open-apis/sheets/v3/spreadsheets/[^/]+/sheets/query$",
  "GET open.feishu.cn ^/open-apis/slides_ai/v1/xml_presentations/[^/]+$",
  "GET open.feishu.cn ^/open-apis/wiki/v2/spaces/[^/]+/nodes$",
  "GET open.feishu.cn ^/open-apis/wiki/v2/spaces/get_node$",
  "POST accounts.feishu.cn ^/oauth/v3/token$",
  "POST mcp.feishu.cn ^/mcp$",
  "POST open.feishu.cn ^/open-apis/bitable/v1/apps$",
  "POST open.feishu.cn ^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/fields$",
  "POST open.feishu.cn ^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/records$",
  "POST open.feishu.cn ^/open-apis/docx/v1/documents$",
  "POST open.feishu.cn ^/open-apis/docx/v1/documents/[^/]+/blocks/[^/]+/children$",
  "POST open.feishu.cn ^/open-apis/drive/v1/files/[^/]+/comments$",
  "POST open.feishu.cn ^/open-apis/drive/v1/files/upload_all$",
  "POST open.feishu.cn ^/open-apis/drive/v1/metas/batch_query$",
  "POST open.feishu.cn ^/open-apis/im/v1/messages/search$",
  "POST open.feishu.cn ^/open-apis/search/v2/doc_wiki/search$",
  "POST open.feishu.cn ^/open-apis/sheets/v2/spreadsheets/[^/]+/values_append$",
  "POST open.feishu.cn ^/open-apis/sheets/v2/spreadsheets/[^/]+/values_batch_update$",
  "POST open.feishu.cn ^/open-apis/sheets/v3/spreadsheets$",
  "POST open.feishu.cn ^/open-apis/slides_ai/v1/xml_presentations$",
  "POST open.feishu.cn ^/open-apis/slides_ai/v1/xml_presentations/[^/]+/slide$",
  "POST open.feishu.cn ^/open-apis/slides_ai/v1/xml_presentations/[^/]+/slide/replace$",
  "PUT open.feishu.cn ^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/fields/[^/]+$",
  "PUT open.feishu.cn ^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/records/[^/]+$",
  "PUT open.feishu.cn ^/open-apis/sheets/v2/spreadsheets/[^/]+/values$",
] as const;

/** NEVER-derived calls from tickets 01, 05, and 07. None of these may match the allowlist. */
const NEVER_CALLS: Array<[string, string]> = [
  ["POST", "https://open.feishu.cn/open-apis/im/v1/messages"],
  ["POST", "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply"],
  ["PATCH", "https://open.feishu.cn/open-apis/im/v1/messages/om_1"],
  ["PUT", "https://open.feishu.cn/open-apis/im/v1/messages/om_1"],
  ["DELETE", "https://open.feishu.cn/open-apis/im/v1/messages/om_1"],
  ["POST", "https://open.feishu.cn/open-apis/im/v1/messages/om_1/forward"],
  ["POST", "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reactions"],
  ["DELETE", "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reactions/emoji"],
  ["POST", "https://open.feishu.cn/open-apis/im/v1/messages/om_1/urgent_app"],
  ["POST", "https://open.feishu.cn/open-apis/im/v1/chats"],
  ["PUT", "https://open.feishu.cn/open-apis/im/v1/chats/oc_1"],
  ["PATCH", "https://open.feishu.cn/open-apis/im/v1/chats/oc_1"],
  ["DELETE", "https://open.feishu.cn/open-apis/im/v1/chats/oc_1"],
  ["POST", "https://open.feishu.cn/open-apis/im/v1/chats/oc_1/members"],
  ["DELETE", "https://open.feishu.cn/open-apis/im/v1/chats/oc_1/members/ou_ada"],
  ["POST", "https://open.feishu.cn/open-apis/drive/v1/permissions/doxcn/members"],
  ["POST", "https://open.feishu.cn/open-apis/contact/v3/users"],
  ["PATCH", "https://open.feishu.cn/open-apis/contact/v3/users/ou_ada"],
  ["DELETE", "https://open.feishu.cn/open-apis/wiki/v2/spaces/spc/nodes/wikcn"],
  ["POST", "https://open.feishu.cn/open-apis/wiki/v2/nodes/wikcn/move_wiki_to_docs"],
  ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=folder"],
  ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=docx&type=folder"],
  ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn"],
  ["POST", "https://open.feishu.cn/open-apis/drive/v1/trash/empty"],
  ["POST", "https://open.feishu.cn/open-apis/drive/explorer/v2/file/delete"],
  ["POST", "https://open.feishu.cn/open-apis/mindnote/v1/mindnotes/bmncnEXAMPLE/nodes"],
  ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=mindnote"],
];

describe("endpoint allowlist", () => {
  it("matches the reviewed list and rejects NEVER calls", () => {
    expect([...endpointAllowlist()]).toEqual([...ALLOWLIST]);
    for (const [method, url] of NEVER_CALLS) {
      expect(isEndpointAllowed(method, url)).toBe(false);
    }
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=docx")).toBe(true);
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=sheet")).toBe(true);
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=bitable")).toBe(true);
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=slides")).toBe(true);
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=file")).toBe(true);
  });
});

describe("page caps", () => {
  it("keeps every paginating tool inside the outbound budget", () => {
    expect(DOC_READ_PAGE_CAP + 1).toBeLessThanOrEqual(OUTBOUND_LIMIT);
    expect(CHAT_PAGE_CAP + 1 + P2P_SEARCH_PAGE_CAP + 1).toBeLessThanOrEqual(OUTBOUND_LIMIT);
    expect(CHAT_PAGE_CAP + 1).toBeLessThanOrEqual(OUTBOUND_LIMIT);
    expect(CALLER_PAGE_CAP + 1).toBeLessThanOrEqual(OUTBOUND_LIMIT);
  });

  it("stops an endless comment listing at the documented page cap", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ get_doc_comments: "openapi" });
    const { accessToken } = await login();
    let pages = 0;
    fake.extra = (method, url) => {
      if (method !== "GET" || !url.pathname.endsWith("/comments")) return undefined;
      pages += 1;
      return Response.json({
        code: 0,
        data: {
          has_more: true,
          page_token: `cmt-${pages}`,
          items: [{ comment_id: `cmt${pages}`, reply_list: { replies: [{ content: { elements: [{ text: `note ${pages}` }] } }] } }],
        },
      });
    };
    const before = fake.calls.length;
    const text = toolText((await callTool(accessToken, "get_doc_comments", { doc: "doxcnCAP" })).body);
    expect(pages).toBe(DOC_READ_PAGE_CAP);
    expect(fake.calls.length - before).toBeLessThanOrEqual(OUTBOUND_LIMIT);
    expect(text).toContain("page cap reached");
    expect(text).toContain(`page_token: cmt-${DOC_READ_PAGE_CAP}`);
    expect(text).not.toContain(`note ${DOC_READ_PAGE_CAP + 1}`);
  });

  it("fetches one page for message search and colleague search", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ search_users: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({
          code: 0,
          data: {
            has_more: true,
            page_token: "msg-2",
            items: [{ meta_data: { message_id: "om_1", chat_id: "oc_1", from_id: "ou_ada" }, display_info: { snippet: "hello" } }],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/search/v1/user") {
        return Response.json({
          code: 0,
          data: { has_more: true, page_token: "usr-2", users: [{ name: "Ada Lovelace", open_id: "ou_ada" }] },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      return undefined;
    };
    const messagesBefore = fake.calls.length;
    const messages = toolText((await callTool(accessToken, "search_messages", { query: "hello" })).body);
    const messageSearches = fake.calls.slice(messagesBefore).filter((call) => call.url.includes("/im/v1/messages/search"));
    expect(messageSearches).toHaveLength(CALLER_PAGE_CAP);
    expect(fake.calls.length - messagesBefore).toBeLessThanOrEqual(OUTBOUND_LIMIT);
    expect(messages).toContain("page cap reached");
    expect(messages).toContain("page_token: msg-2");

    const usersBefore = fake.calls.length;
    const users = toolText((await callTool(accessToken, "search_users", { query: "Ada" })).body);
    const userSearches = fake.calls.slice(usersBefore).filter((call) => call.url.includes("/search/v1/user"));
    expect(userSearches).toHaveLength(CALLER_PAGE_CAP);
    expect(fake.calls.length - usersBefore).toBeLessThanOrEqual(OUTBOUND_LIMIT);
    expect(users).toContain("page cap reached");
    expect(users).toContain("page_token: usr-2");
  });
});

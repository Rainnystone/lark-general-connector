import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { argumentError, capturedTool, FEISHU_MCP_TOOLS } from "./mcp-schema";
import { callTool, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

function mcpArguments(body: string): { name?: string; arguments?: unknown } {
  const payload = JSON.parse(body) as { params?: { name?: string; arguments?: unknown } };
  return { name: payload.params?.name, arguments: payload.params?.arguments };
}

describe("proxied Feishu MCP argument contract", () => {
  it("pins the live tools/list capture", () => {
    expect(FEISHU_MCP_TOOLS.capturedAt.startsWith("2026-10-09")).toBe(true);
    expect(FEISHU_MCP_TOOLS.source).toBe("https://mcp.feishu.cn/mcp tools/list");
    expect(capturedTool("fetch-doc").inputSchema.properties).toHaveProperty("doc_id");
    expect(capturedTool("fetch-doc").inputSchema.properties).not.toHaveProperty("docID");
    expect(capturedTool("fetch-file").inputSchema.required).toEqual(["resource_token"]);
    expect(capturedTool("list-docs").inputSchema.properties).toHaveProperty("doc_id");
    expect(capturedTool("list-docs").inputSchema.properties).toHaveProperty("my_library");
    expect(capturedTool("list-docs").inputSchema.properties).not.toHaveProperty("space_id");
    expect(capturedTool("search-doc").inputSchema.properties).toHaveProperty("page");
    expect(capturedTool("search-doc").inputSchema.properties).not.toHaveProperty("count");
    expect(argumentError(capturedTool("fetch-file").inputSchema, { docID: "x", file_token: "y" })).toBe("unknown argument docID");
    expect(argumentError(capturedTool("fetch-file").inputSchema, { type: "media" })).toBe("missing argument resource_token");
  });

  it("sends only captured argument names for every proxied tool", async () => {
    env.TOOL_BACKENDS = JSON.stringify({
      search_docs: "mcp",
      fetch_doc: "mcp",
      list_wiki_docs: "mcp",
      get_doc_comments: "mcp",
      create_doc: "mcp",
      update_doc: "mcp",
      add_doc_comment: "mcp",
      get_user: "mcp",
      search_users: "mcp",
      fetch_doc_media: "mcp",
    });
    const { accessToken } = await login();
    const cases = [
      {
        name: "search_docs",
        args: { query: "quarterly", page_token: "p1", count: 5 },
        feishuTool: "search-doc",
        arguments: { query: "quarterly", page: { size: 5, page_token: "p1" } },
      },
      {
        name: "fetch_doc",
        args: { doc: "doxcnDOC" },
        feishuTool: "fetch-doc",
        arguments: { doc_id: "doxcnDOC", limit: 28_000 },
      },
      {
        name: "list_wiki_docs",
        args: { node_token: "wikcnNODE", page_token: "w1" },
        feishuTool: "list-docs",
        arguments: { doc_id: "wikcnNODE", page_size: 50, page_token: "w1" },
      },
      {
        name: "list_wiki_docs",
        args: {},
        feishuTool: "list-docs",
        arguments: { my_library: true, page_size: 50 },
      },
      {
        name: "get_doc_comments",
        args: { doc: "doxcnDOC", page_token: "c1" },
        feishuTool: "get-comments",
        arguments: { doc_id: "doxcnDOC", page_token: "c1" },
      },
      {
        name: "create_doc",
        args: { title: "Notes", content_markdown: "hello", folder_token: "fldcn1" },
        feishuTool: "create-doc",
        arguments: { title: "Notes", markdown: "hello", folder_token: "fldcn1" },
      },
      {
        name: "update_doc",
        args: { doc: "doxcnDOC", mode: "append", content_markdown: "more" },
        feishuTool: "update-doc",
        arguments: { doc_id: "doxcnDOC", mode: "append", markdown: "more" },
      },
      {
        name: "add_doc_comment",
        args: { doc: "doxcnDOC", text: "looks good" },
        feishuTool: "add-comments",
        arguments: { doc_id: "doxcnDOC", elements: [{ type: "text", text: "looks good" }] },
      },
      {
        name: "get_user",
        args: { user_id: "ou_ada" },
        feishuTool: "get-user",
        arguments: { open_id: "ou_ada" },
      },
      {
        name: "search_users",
        args: { query: "Ada", page_token: "20" },
        feishuTool: "search-user",
        arguments: { query: "Ada", page_token: "20" },
      },
      {
        name: "fetch_doc_media",
        args: { media_token: "boxcnIMG" },
        feishuTool: "fetch-file",
        arguments: { resource_token: "boxcnIMG", type: "media" },
      },
      {
        name: "fetch_doc_media",
        args: { whiteboard_id: "wbcnBOARD" },
        feishuTool: "fetch-file",
        arguments: { resource_token: "wbcnBOARD", type: "whiteboard" },
      },
    ] as const;

    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });
    };

    for (const item of cases) {
      const before = fake.calls.length;
      await callTool(accessToken, item.name, item.args);
      const sent = fake.calls.slice(before).filter((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"));
      expect(sent, item.name).toHaveLength(1);
      const parsed = mcpArguments(sent[0]?.body ?? "{}");
      expect(parsed.name).toBe(item.feishuTool);
      expect(parsed.arguments).toEqual(item.arguments);
      expect(argumentError(capturedTool(item.feishuTool).inputSchema, parsed.arguments)).toBeNull();
    }
  });

  it("searches drive and wiki docs once and pages with the opaque token", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url, body) => {
      if (method !== "POST" || url.pathname !== "/open-apis/search/v2/doc_wiki/search") return undefined;
      const payload = JSON.parse(body) as {
        query?: string;
        page_size?: number;
        page_token?: string;
        doc_filter?: Record<string, unknown>;
        wiki_filter?: Record<string, unknown>;
      };
      expect(payload.doc_filter).toEqual({});
      expect(payload.wiki_filter).toEqual({});
      expect(payload.query?.length ?? 0).toBeLessThanOrEqual(30);
      const pageSize = payload.page_size ?? 0;
      expect(pageSize).toBeGreaterThan(0);
      expect(pageSize).toBeLessThanOrEqual(20);
      const start = payload.page_token === "opaque-2" ? 2 : 0;
      const units = Array.from({ length: pageSize }, (_, index) => {
        const n = start + index;
        const wiki = n % 2 === 1;
        return {
          entity_type: wiki ? "WIKI" : "DOC",
          title_highlighted: wiki ? `<h>Hit</h> ${n}` : `Hit ${n}`,
          result_meta: {
            token: wiki ? `wikcn${n}` : `doxcn${n}`,
            doc_types: "DOCX",
            url: wiki ? `https://example.feishu.cn/wiki/wikcn${n}` : `https://example.feishu.cn/docx/doxcn${n}`,
            owner_id: "ou_owner",
            update_time: 1710000000,
          },
        };
      });
      return Response.json({
        code: 0,
        data: { has_more: payload.page_token !== "opaque-2", page_token: payload.page_token === "opaque-2" ? null : "opaque-2", res_units: units },
      });
    };
    const before = fake.calls.length;
    const first = toolText((await callTool(accessToken, "search_docs", { query: "quarterly", count: 2 })).body);
    const calls = fake.calls.slice(before).filter((call) => call.url.includes("/search/v2/doc_wiki/search"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ query: "quarterly", page_size: 2, doc_filter: {}, wiki_filter: {} });
    expect(fake.calls.slice(before).some((call) => call.url.includes("/suite/docs-api/search/object"))).toBe(false);
    expect(first).toContain("title: Hit 0");
    expect(first).toContain("type: docx");
    expect(first).toContain("token: doxcn0");
    expect(first).toContain("title: Hit 1");
    expect(first).toContain("type: wiki");
    expect(first).toContain("token: wikcn1");
    expect(first).not.toContain("<h>");
    expect(first).not.toContain("Hit 2");
    const token = first.match(/page_token: (.+)/)?.[1];
    expect(token).toBe("opaque-2");
    const nextBefore = fake.calls.length;
    const next = toolText((await callTool(accessToken, "search_docs", { query: "quarterly", count: 2, page_token: token })).body);
    const nextCall = fake.calls.slice(nextBefore).find((call) => call.url.includes("/search/v2/doc_wiki/search"));
    expect(JSON.parse(nextCall?.body ?? "{}")).toMatchObject({ query: "quarterly", page_size: 2, page_token: "opaque-2", doc_filter: {}, wiki_filter: {} });
    expect(next).toContain("Hit 2");
    expect(next).toContain("Hit 3");
    expect(next).not.toContain("page_token:");
  });
});

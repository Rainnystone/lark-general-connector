import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import { PROXIED_TOOLS, toolBackend } from "../src/mcp/tool-backends";
import { BODY_CHAR_LIMIT } from "../src/feishu/payload";
import { MARKER } from "./fake-feishu";
import fetchDocPages from "./fixtures/fetch-doc-pages.json" with { type: "json" };
import docWikiCapture from "./fixtures/search-v2-docwiki.json" with { type: "json" };
import { capturedTool } from "./mcp-schema";
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const CATALOGUE = [
  { name: "search_docs", title: "Search Feishu docs" },
  { name: "fetch_doc", title: "Read a Feishu doc" },
  { name: "list_wiki_docs", title: "List wiki docs" },
  { name: "get_doc_comments", title: "Read doc comments" },
] as const;

describe("doc read tools", () => {
  it("lists the four doc tools with catalogue titles and read-only annotations", async () => {
    const { accessToken } = await login();
    const before = fake.calls.length;
    const tools = await listTools(accessToken);
    expect(fake.calls).toHaveLength(before);
    for (const expected of CATALOGUE) {
      const tool = tools.find((entry) => entry.name === expected.name);
      expect(tool?.title).toBe(expected.title);
      const annotations = tool?.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
      expect(annotations.readOnlyHint).toBe(true);
      expect(annotations.destructiveHint).toBe(false);
      expect(annotations.openWorldHint).toBe(true);
    }
    const schemaOf = (name: string) => {
      const tool = tools.find((entry) => entry.name === name);
      return tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    };
    expect(Object.keys(schemaOf("search_docs").properties ?? {})).toEqual(["query", "page_token", "count"]);
    expect(schemaOf("search_docs").required).toEqual(["query"]);
    expect(Object.keys(schemaOf("fetch_doc").properties ?? {})).toEqual(["doc", "offset", "limit"]);
    expect(schemaOf("fetch_doc").required).toEqual(["doc"]);
    expect(Object.keys(schemaOf("list_wiki_docs").properties ?? {})).toEqual(["space_id", "node_token", "page_token"]);
    expect(schemaOf("list_wiki_docs").required).toBeUndefined();
    expect(Object.keys(schemaOf("get_doc_comments").properties ?? {})).toEqual(["doc", "page_token"]);
    expect(schemaOf("get_doc_comments").required).toEqual(["doc"]);
    const routing =
      "Only docx content is returned. For sheet use read_sheet, bitable read_bitable, slides read_slides, file read_file, mindnote read_mindnote.";
    expect(String(tools.find((entry) => entry.name === "fetch_doc")?.description)).toContain(routing);
    expect(String(tools.find((entry) => entry.name === "list_wiki_docs")?.description)).toContain(routing);
  });

  it("calls each Feishu MCP tool once and passes the result through", async () => {
    expect(capturedTool("fetch-doc").inputSchema.required).toEqual(["doc_id"]);
    expect(capturedTool("fetch-doc").inputSchema.properties).not.toHaveProperty("docID");
    env.TOOL_BACKENDS = JSON.stringify({ search_docs: "mcp" });

    const { accessToken } = await login();
    const cases = [
      {
        name: "search_docs",
        args: { query: "quarterly", page_token: "p1", count: 5 },
        feishuTool: "search-doc",
        text: "search-hit",
        arguments: { query: "quarterly", page: { size: 5, page_token: "p1" } },
      },
      {
        name: "fetch_doc",
        args: { doc: "doxcnDOC" },
        feishuTool: "fetch-doc",
        text: JSON.stringify({ title: "Notes", markdown: "doc-body" }),
        expected: "title: Notes\n\ndoc-body",
        arguments: { doc_id: "doxcnDOC", limit: 28_000 },
      },
      {
        name: "list_wiki_docs",
        args: { node_token: "wikcnNODE", page_token: "w1" },
        feishuTool: "list-docs",
        text: "wiki-list",
        arguments: { doc_id: "wikcnNODE", page_size: 50, page_token: "w1" },
      },
      {
        name: "get_doc_comments",
        args: { doc: "doxcnDOC", page_token: "c1" },
        feishuTool: "get-comments",
        text: "comment-body",
        arguments: { doc_id: "doxcnDOC", page_token: "c1" },
      },
    ] as const;

    for (const item of cases) {
      const before = fake.calls.length;
      fake.extra = (_method, url, body) => {
        if (url.pathname !== "/mcp") return undefined;
        const payload = JSON.parse(body) as { method?: string; params?: { name?: string; arguments?: unknown } };
        if (payload.method !== "tools/call") return undefined;
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: item.text }] },
        });
      };
      const response = await callTool(accessToken, item.name, item.args);
      const sent = fake.calls.slice(before).filter((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"));
      expect(sent).toHaveLength(1);
      const openCalls = fake.calls.slice(before).filter((call) => call.url.includes("open.feishu.cn"));
      if (item.name === "fetch_doc") {
        expect(openCalls.every((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(true);
      } else {
        expect(openCalls).toHaveLength(0);
      }
      expect(sent[0]?.headers["x-lark-mcp-uat"]).toBe("u-access-1");
      expect(sent[0]?.headers["x-lark-mcp-allowed-tools"]).toBe(item.feishuTool);
      expect(sent[0]?.headers["content-type"]).toContain("application/json");
      const payload = JSON.parse(sent[0]?.body ?? "{}") as {
        method?: string;
        params?: { name?: string; arguments?: unknown };
      };
      expect(payload.method).toBe("tools/call");
      expect(payload.params?.name).toBe(item.feishuTool);
      expect(payload.params?.arguments).toEqual(item.arguments);
      expect(toolText(response.body)).toBe("expected" in item ? item.expected : item.text);
      const result = response.body as { result?: { isError?: boolean } };
      expect(result.result?.isError).not.toBe(true);
    }
  });

  it("flips one tool to OpenAPI and leaves the others on MCP", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url, body) => {
      if (url.pathname === "/mcp") {
        let text = "mcp-pass";
        try {
          const payload = JSON.parse(body) as { params?: { name?: string } };
          if (payload.params?.name === "fetch-doc") text = JSON.stringify({ title: "Notes", markdown: "mcp-pass" });
        } catch {
          text = "mcp-pass";
        }
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1/raw_content") {
        return Response.json({ code: 0, data: { content: "raw-body" } });
      }
      if (method === "POST" && url.pathname === "/open-apis/search/v2/doc_wiki/search") {
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            res_units: [
              {
                entity_type: "DOC",
                title_highlighted: "Quarterly plan",
                result_meta: {
                  token: "doxcnHIT",
                  doc_types: "DOCX",
                  owner_id: "ou_owner",
                  url: "https://example.feishu.cn/docx/doxcnHIT",
                  update_time: 1710000000,
                },
              },
            ],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/spc1/nodes") {
        return Response.json({
          code: 0,
          data: { has_more: false, items: [{ node_token: "wikcn1", obj_token: "doxcnNODE", obj_type: "docx", title: "Wiki Home" }] },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/drive/v1/files/doxcn1/comments") {
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                comment_id: "cmt1",
                reply_list: { replies: [{ content: { elements: [{ type: "text", text: "please revise" }] } }] },
              },
            ],
          },
        });
      }
      return undefined;
    };

    const cases = [
      {
        tool: "fetch_doc",
        args: { doc: "doxcn1" },
        other: "search_docs",
        otherArgs: { query: "quarterly" },
        text: "raw-body",
        matches: (call: { method: string; url: string; body: string }) => call.method === "GET" && call.url.includes("/docx/v1/documents/doxcn1/raw_content"),
      },
      {
        tool: "search_docs",
        args: { query: "quarterly", count: 5 },
        other: "fetch_doc",
        otherArgs: { doc: "doxcn1" },
        text: "Quarterly plan",
        matches: (call: { method: string; url: string; body: string }) =>
          call.method === "POST" &&
          call.url.includes("/search/v2/doc_wiki/search") &&
          call.body.includes('"query":"quarterly"') &&
          call.body.includes('"page_size":5') &&
          call.body.includes('"doc_filter":{}') &&
          call.body.includes('"wiki_filter":{}'),
      },
      {
        tool: "list_wiki_docs",
        args: { space_id: "spc1" },
        other: "fetch_doc",
        otherArgs: { doc: "doxcn1" },
        text: "Wiki Home",
        matches: (call: { method: string; url: string }) => call.method === "GET" && call.url.includes("/wiki/v2/spaces/spc1/nodes"),
      },
      {
        tool: "get_doc_comments",
        args: { doc: "doxcn1" },
        other: "fetch_doc",
        otherArgs: { doc: "doxcn1" },
        text: "please revise",
        matches: (call: { method: string; url: string }) => call.method === "GET" && call.url.includes("/drive/v1/files/doxcn1/comments"),
      },
    ] as const;

    for (const item of cases) {
      env.TOOL_BACKENDS = JSON.stringify({ search_docs: "mcp", [item.tool]: "openapi" });
      const before = fake.calls.length;
      const response = await callTool(accessToken, item.tool, item.args);
      const sent = fake.calls.slice(before);
      expect(sent.some((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
      const hit = sent.find((call) => item.matches(call));
      expect(hit).toBeTruthy();
      expect(hit?.headers.authorization).toBe("Bearer u-access-1");
      expect(toolText(response.body)).toContain(item.text);
      if (item.tool === "search_docs") {
        const text = toolText(response.body);
        expect(text).toContain("doxcnHIT");
        expect(text).toContain("docx");
        expect(text).toContain("ou_owner");
        expect(text).toContain("https://example.feishu.cn/docx/doxcnHIT");
        expect(text).toContain("1710000000");
      }

      const otherBefore = fake.calls.length;
      const other = await callTool(accessToken, item.other, item.otherArgs);
      const otherSent = fake.calls.slice(otherBefore).filter((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"));
      expect(otherSent).toHaveLength(1);
      expect(toolText(other.body)).toBe(item.other === "fetch_doc" ? "title: Notes\n\nmcp-pass" : "mcp-pass");
    }
  });

  it("flags a backend value other than mcp or openapi and stays on MCP", async () => {
    expect(toolBackend(JSON.stringify({ update_doc: "open_api" }), "update_doc")).toEqual({ backend: "mcp", invalid: true });
    expect(toolBackend(JSON.stringify({ update_doc: "openapi" }), "update_doc")).toEqual({ backend: "openapi", invalid: false });
    expect(toolBackend(JSON.stringify({ fetch_doc: "mcp" }), "fetch_doc")).toEqual({ backend: "mcp", invalid: false });
    expect(toolBackend(JSON.stringify({ fetch_doc: "openapi", update_doc: "open_api" }), "fetch_doc")).toEqual({ backend: "openapi", invalid: true });
    expect(toolBackend(undefined, "fetch_doc")).toEqual({ backend: "mcp", invalid: false });
    expect(toolBackend(undefined, "search_docs")).toEqual({ backend: "openapi", invalid: false });
    expect(toolBackend("", "search_docs")).toEqual({ backend: "openapi", invalid: false });
    expect(toolBackend("{not-json", "search_docs")).toEqual({ backend: "openapi", invalid: true });
    expect(toolBackend(JSON.stringify({ search_docs: "open_api" }), "search_docs")).toEqual({ backend: "mcp", invalid: true });
    expect(toolBackend(JSON.stringify({ fetch_doc: "open_api" }), "search_docs")).toEqual({ backend: "openapi", invalid: true });
    expect([...PROXIED_TOOLS]).toEqual([
      "search_docs",
      "fetch_doc",
      "list_wiki_docs",
      "get_doc_comments",
      "create_doc",
      "update_doc",
      "add_doc_comment",
      "get_user",
      "search_users",
      "fetch_doc_media",
    ]);

    const logs = logLines();
    try {
      const { accessToken } = await login();
      env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "open_api" });
      fake.extra = (_method, url, body) => {
        if (url.pathname !== "/mcp") return undefined;
        const payload = JSON.parse(body) as { method?: string };
        if (payload.method !== "tools/call") return undefined;
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify({ title: "Notes", markdown: "mcp-pass" }) }] },
        });
      };
      const before = fake.calls.length;
      const response = await callTool(accessToken, "fetch_doc", { doc: "doxcn1" });
      const sent = fake.calls.slice(before);
      expect(sent.some((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(true);
      expect(sent.some((call) => call.url.includes("/docx/"))).toBe(false);
      expect(toolText(response.body)).toBe("title: Notes\n\nmcp-pass");
      const invalid = logs.lines().filter((line) => line.includes('"event":"tool_backends_invalid"'));
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).not.toContain("open_api");
    } finally {
      logs.restore();
    }
  });

  it("keeps an invalid search_docs backend on MCP", async () => {
    const logs = logLines();
    try {
      const { accessToken } = await login();
      env.TOOL_BACKENDS = JSON.stringify({ search_docs: "open_api" });
      fake.extra = (_method, url, body) => {
        if (url.pathname !== "/mcp") return undefined;
        const payload = JSON.parse(body) as { method?: string };
        if (payload.method !== "tools/call") return undefined;
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "mcp-pass" }] } });
      };
      const before = fake.calls.length;
      const response = await callTool(accessToken, "search_docs", { query: "quarterly", count: 5 });
      const sent = fake.calls.slice(before);
      const mcp = sent.filter((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"));
      expect(mcp).toHaveLength(1);
      expect(sent.some((call) => call.url.includes("/search/v2/doc_wiki/search"))).toBe(false);
      expect(sent.some((call) => call.url.includes("/suite/docs-api/search/object"))).toBe(false);
      const payload = JSON.parse(mcp[0]?.body ?? "{}") as { params?: { name?: string; arguments?: { page?: { size?: number } } } };
      expect(payload.params?.name).toBe("search-doc");
      expect(payload.params?.arguments).toEqual({ query: "quarterly", page: { size: 5 } });
      expect(toolText(response.body)).toBe("mcp-pass");
      const invalid = logs.lines().filter((line) => line.includes('"event":"tool_backends_invalid"'));
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).not.toContain("open_api");
    } finally {
      logs.restore();
    }
  });

  it("uses MCP defaults when TOOL_BACKENDS is not JSON", async () => {
    const logs = logLines();
    const { accessToken } = await login();
    env.TOOL_BACKENDS = "{not-json";
    fake.extra = (_method, url) => {
      if (url.pathname !== "/mcp") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ title: "Notes", markdown: "mcp-pass" }) }] },
      });
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "fetch_doc", { doc: "doxcn1" });
    await callTool(accessToken, "fetch_doc", { doc: "doxcn1" });
    const sent = fake.calls.slice(before);
    expect(sent.filter((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"))).toHaveLength(2);
    expect(sent.filter((call) => call.url.includes("open.feishu.cn")).every((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(true);
    expect(toolText(response.body)).toBe("title: Notes\n\nmcp-pass");
    const invalid = logs.lines().filter((line) => line.includes('"event":"tool_backends_invalid"'));
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).not.toContain("{not-json");
    logs.restore();
  });

  it("refreshes once and retries after Feishu MCP says the user token is expired", async () => {
    const { accessToken } = await login();
    let mcpCalls = 0;
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      mcpCalls += 1;
      if (mcpCalls === 1) {
        return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32003, message: "expired" } }, { status: 400 });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ title: "Notes", markdown: "after-refresh" }) }] },
      });
    };
    const response = await callTool(accessToken, "fetch_doc", { doc: "doxcn1" });
    expect(toolText(response.body)).toBe("title: Notes\n\nafter-refresh");
    expect(mcpCalls).toBe(2);
    expect(fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(1);
  });

  it("returns a rate-limit message and does not retry", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ search_docs: "mcp" });
    const { accessToken } = await login();
    let mcpCalls = 0;
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      mcpCalls += 1;
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32030, message: "slow down" } }, { status: 429 });
    };
    const response = await callTool(accessToken, "search_docs", { query: "quarterly" });
    expect(toolText(response.body)).toBe("Feishu rate limit, retry shortly");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(mcpCalls).toBe(1);
    expect(fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(0);
  });

  it("maps a missing Feishu credential to an internal error", async () => {
    const { accessToken } = await login();
    let mcpCalls = 0;
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      mcpCalls += 1;
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32011, message: "UAT TAT Required" } }, { status: 401 });
    };
    const response = await callTool(accessToken, "list_wiki_docs", { node_token: "wikcn1" });
    expect(toolText(response.body)).toBe("internal error");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(mcpCalls).toBe(1);
    expect(fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(0);
  });

  it("passes a Feishu tool error through as our tool error", async () => {
    const { accessToken } = await login();
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { isError: true, content: [{ type: "text", text: "missing permission" }] },
      });
    };
    const response = await callTool(accessToken, "get_doc_comments", { doc: "doxcn1" });
    expect(toolText(response.body)).toBe("missing permission");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.filter((call) => call.url.startsWith("https://mcp.feishu.cn/mcp") && call.body.includes("tools/call"))).toHaveLength(1);
  });

  it("reports an HTTP failure from Feishu MCP as a tool error", async () => {
    const { accessToken } = await login();
    let mcpCalls = 0;
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      mcpCalls += 1;
      return new Response("upstream down", { status: 500 });
    };
    const response = await callTool(accessToken, "fetch_doc", { doc: "doxcn1" });
    expect(toolText(response.body)).toBe("Feishu request failed");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(mcpCalls).toBe(1);
    expect(fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(0);
  });

  it("reads a wiki URL through get_node and then raw content", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    const { accessToken } = await login();
    const order: string[] = [];
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        order.push(`get_node:${url.searchParams.get("token")}`);
        return Response.json({
          code: 0,
          data: { node: { obj_token: "doxcnOBJ", obj_type: "docx", space_id: "spcW", node_token: "wikcnNODE" } },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcnOBJ/raw_content") {
        order.push("raw");
        return Response.json({ code: 0, data: { content: "wiki body" } });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "fetch_doc", { doc: "https://example.feishu.cn/wiki/wikcnNODE?from=copy" });
    expect(toolText(response.body)).toBe("wiki body");
    expect(order).toEqual(["get_node:wikcnNODE", "raw"]);
    expect(fake.calls.slice(before).some((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
  });

  it("lists a wiki node by resolving its space and parent", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ list_wiki_docs: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: "doxcnOBJ", obj_type: "docx", space_id: "spcW", node_token: "wikcnNODE" } },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/spcW/nodes") {
        return Response.json({
          code: 0,
          data: { has_more: false, items: [{ node_token: "wikcnCHILD", obj_token: "doxcnCHILD", obj_type: "docx", title: "Child doc" }] },
        });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "list_wiki_docs", { node_token: "wikcnNODE" });
    expect(toolText(response.body)).toContain("Child doc");
    const nodeCall = fake.calls.find((call) => call.url.includes("/wiki/v2/spaces/spcW/nodes"));
    expect(nodeCall).toBeTruthy();
    expect(new URL(nodeCall?.url ?? "https://open.feishu.cn/").searchParams.get("parent_node_token")).toBe("wikcnNODE");
    const lookedUp = fake.calls.find((call) => call.url.includes("/wiki/v2/spaces/get_node"));
    expect(new URL(lookedUp?.url ?? "https://open.feishu.cn/").searchParams.get("token")).toBe("wikcnNODE");
  });

  it("reads comments on a wiki URL from the resolved file token", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ get_doc_comments: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: "doxcnOBJ", obj_type: "docx", space_id: "spcW", node_token: "wikcnNODE" } },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/drive/v1/files/doxcnOBJ/comments") {
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                comment_id: "cmt1",
                reply_list: {
                  replies: [
                    {
                      content: {
                        elements: [
                          { type: "text", text: "please revise" },
                          { type: "text_run", text_run: { text: "ship it" } },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        });
      }
      return undefined;
    };
    const text = toolText((await callTool(accessToken, "get_doc_comments", { doc: "https://example.feishu.cn/wiki/wikcnNODE" })).body);
    expect(text).toContain("please revise");
    expect(text).toContain("ship it");
    const commentCall = fake.calls.find((call) => call.url.includes("/drive/v1/files/doxcnOBJ/comments"));
    expect(commentCall).toBeTruthy();
    expect(new URL(commentCall?.url ?? "https://open.feishu.cn/").searchParams.get("file_type")).toBe("docx");
  });

  it("reads a bare wiki node token from the resolved file, not the node token", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ get_doc_comments: "openapi", fetch_doc: "openapi" });
    const { accessToken } = await login();
    const nodeToken = "Y9sSwvNODE";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        expect(url.searchParams.get("token")).toBe(nodeToken);
        expect(url.searchParams.get("obj_type")).toBeNull();
        return Response.json({
          code: 0,
          data: { node: { obj_token: "doxcnOBJ", obj_type: "docx", space_id: "spcW", node_token: nodeToken } },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/drive/v1/files/doxcnOBJ/comments") {
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                comment_id: "cmt1",
                reply_list: { replies: [{ content: { elements: [{ type: "text_run", text_run: { text: "on the doc" } }] } }] },
              },
            ],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcnOBJ/raw_content") {
        return Response.json({ code: 0, data: { content: "wiki body" } });
      }
      return undefined;
    };
    const comments = toolText((await callTool(accessToken, "get_doc_comments", { doc: nodeToken })).body);
    expect(comments).toContain("on the doc");
    const commentCalls = fake.calls.filter((call) => call.url.includes("/comments"));
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0]?.url).toContain("/files/doxcnOBJ/comments");
    expect(commentCalls.some((call) => call.url.includes(`/files/${nodeToken}/`))).toBe(false);
    const fetched = toolText((await callTool(accessToken, "fetch_doc", { doc: nodeToken })).body);
    expect(fetched).toBe("wiki body");
    expect(fake.calls.some((call) => call.url.includes(`/documents/${nodeToken}/raw_content`))).toBe(false);
    expect(fake.calls.some((call) => call.url.includes("/documents/doxcnOBJ/raw_content"))).toBe(true);
  });

  it("treats a bare drive token as docx when get_node says it is not a wiki node", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi", get_doc_comments: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        expect(url.searchParams.get("obj_type")).toBeNull();
        expect(url.searchParams.get("token")).toBe("doxcn1");
        return Response.json({ code: 131005, msg: "not found" });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1/raw_content") {
        return Response.json({ code: 0, data: { content: "drive body" } });
      }
      if (method === "GET" && url.pathname === "/open-apis/drive/v1/files/doxcn1/comments") {
        expect(url.searchParams.get("file_type")).toBe("docx");
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            items: [{ comment_id: "cmt1", reply_list: { replies: [{ content: { elements: [{ type: "text_run", text_run: { text: "drive note" } }] } }] } }],
          },
        });
      }
      return undefined;
    };
    expect(toolText((await callTool(accessToken, "fetch_doc", { doc: "doxcn1" })).body)).toBe("drive body");
    expect(toolText((await callTool(accessToken, "get_doc_comments", { doc: "doxcn1" })).body)).toContain("drive note");
    expect(fake.calls.some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(true);
  });

  it("reads a docx URL without a wiki lookup", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi", get_doc_comments: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1/raw_content") {
        return Response.json({ code: 0, data: { content: "url body" } });
      }
      if (method === "GET" && url.pathname === "/open-apis/drive/v1/files/doxcn1/comments") {
        expect(url.searchParams.get("file_type")).toBe("docx");
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            items: [{ comment_id: "cmt1", reply_list: { replies: [{ content: { elements: [{ type: "text_run", text_run: { text: "url note" } }] } }] } }],
          },
        });
      }
      return undefined;
    };
    const before = fake.calls.length;
    expect(toolText((await callTool(accessToken, "fetch_doc", { doc: "https://example.feishu.cn/docx/doxcn1" })).body)).toBe("url body");
    expect(toolText((await callTool(accessToken, "get_doc_comments", { doc: "https://example.feishu.cn/docs/doxcn1" })).body)).toContain("url note");
    expect(fake.calls.slice(before).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(false);
  });

  it("leaves a missing wiki URL as an error", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131005, msg: "not found" });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const read = await callTool(accessToken, "fetch_doc", { doc: "https://example.feishu.cn/wiki/wikcnMISSING" });
    expect((read.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.slice(before).some((call) => call.url.includes("/raw_content"))).toBe(false);
  });

  it("refuses a wiki node whose obj_type is missing", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: "doxcnOBJ", obj_type: "", space_id: "spcW", node_token: "Y9sSwvBLANK" } },
        });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const read = await callTool(accessToken, "fetch_doc", { doc: "Y9sSwvBLANK" });
    expect((read.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(toolText(read.body)).toBe("this is a unknown");
    expect(fake.calls.slice(before).some((call) => call.url.includes("/raw_content"))).toBe(false);
  });

  it("refuses sheet, bitable, slides, file, and mindnote wiki nodes and names the read tool", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    const { accessToken } = await login();
    const cases = [
      { objType: "sheet", objToken: "shtcnEXAMPLE", tool: "read_sheet" },
      { objType: "bitable", objToken: "bascnEXAMPLE", tool: "read_bitable" },
      { objType: "slides", objToken: "sldcnEXAMPLE", tool: "read_slides" },
      { objType: "file", objToken: "filecnEXAMPLE", tool: "read_file" },
      { objType: "mindnote", objToken: "bmncnEXAMPLE", tool: "read_mindnote" },
    ] as const;
    for (const item of cases) {
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
          return Response.json({
            code: 0,
            data: { node: { obj_token: item.objToken, obj_type: item.objType, space_id: "spcW", node_token: `wikcn${item.objType}` } },
          });
        }
        return undefined;
      };
      const before = fake.calls.length;
      const response = await callTool(accessToken, "fetch_doc", { doc: `https://example.feishu.cn/wiki/wikcn${item.objType}` });
      expect(toolText(response.body)).toBe(`this is a ${item.objType}; use ${item.tool}`);
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      expect(fake.calls.slice(before).some((call) => call.url.includes("/raw_content"))).toBe(false);
    }
  });

  it("refuses direct sheet, base, slides, file, and mindnote URLs and names the read tool", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    const { accessToken } = await login();
    const cases = [
      { path: "sheets", objType: "sheet", tool: "read_sheet", token: "shtcnDIRECT" },
      { path: "base", objType: "bitable", tool: "read_bitable", token: "bascnDIRECT" },
      { path: "slides", objType: "slides", tool: "read_slides", token: "sldcnDIRECT" },
      { path: "file", objType: "file", tool: "read_file", token: "filecnDIRECT" },
      { path: "mindnotes", objType: "mindnote", tool: "read_mindnote", token: "bmncnDIRECT" },
    ] as const;
    for (const item of cases) {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "fetch_doc", { doc: `https://example.feishu.cn/${item.path}/${item.token}` });
      expect(toolText(response.body)).toBe(`this is a ${item.objType}; use ${item.tool}`);
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      expect(
        fake.calls.slice(before).some((call) => call.url.includes("/raw_content") || call.url.includes("/wiki/v2/spaces/get_node")),
      ).toBe(false);
    }
  });

  it("routes typed drive URLs on the default MCP backend with no outbound call", async () => {
    const { accessToken } = await login();
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { isError: true, content: [{ type: "text", text: "[VALIDATION:400] Unable to extract document ID" }] },
      });
    };
    const cases = [
      { path: "sheets", objType: "sheet", tool: "read_sheet", token: "shtcnDIRECT" },
      { path: "base", objType: "bitable", tool: "read_bitable", token: "bascnDIRECT" },
      { path: "slides", objType: "slides", tool: "read_slides", token: "sldcnDIRECT" },
      { path: "file", objType: "file", tool: "read_file", token: "filecnDIRECT" },
      { path: "mindnotes", objType: "mindnote", tool: "read_mindnote", token: "bmncnDIRECT" },
    ] as const;
    for (const item of cases) {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "fetch_doc", { doc: `https://example.feishu.cn/${item.path}/${item.token}` });
      expect(toolText(response.body)).toBe(`this is a ${item.objType}; use ${item.tool}`);
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      expect(
        fake.calls.slice(before).some((call) => call.url.startsWith("https://mcp.feishu.cn/mcp") && call.body.includes("tools/call")),
      ).toBe(false);
      expect(fake.calls.slice(before).some((call) => call.url.includes("open.feishu.cn"))).toBe(false);
    }
  });

  it("routes a wiki URL or sheet node token on the default MCP backend after get_node", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url, body) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: "shtcnEXAMPLE", obj_type: "sheet", space_id: "spcW", node_token: "wikcnSHEET" } },
        });
      }
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { isError: true, content: [{ type: "text", text: "[NETWORK:5002] Failed to get child blocks" }] },
      });
    };
    for (const doc of ["https://example.feishu.cn/wiki/wikcnSHEET", "wikcnSHEET"] as const) {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "fetch_doc", { doc });
      expect(toolText(response.body)).toBe("this is a sheet; use read_sheet");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      expect(fake.calls.slice(before).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(true);
      expect(
        fake.calls.slice(before).some((call) => call.url.startsWith("https://mcp.feishu.cn/mcp") && call.body.includes("tools/call")),
      ).toBe(false);
      expect(fake.calls.slice(before).some((call) => call.url.includes("/raw_content"))).toBe(false);
    }
  });

  it("rewrites wiki get_node to open.larksuite.com when refusing a sheet on lark", async () => {
    env.FEISHU_REGION = "lark";
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: "shtcnEXAMPLE", obj_type: "sheet", space_id: "spcW", node_token: "wikcnSHEET" } },
        });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "fetch_doc", { doc: "https://example.feishu.cn/wiki/wikcnSHEET" });
    expect(toolText(response.body)).toBe("this is a sheet; use read_sheet");
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url.includes("https://open.larksuite.com/open-apis/wiki/v2/spaces/get_node"))).toBe(true);
    expect(outbound.every((url) => !url.includes("open.feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("GET", "https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=wikcnSHEET")).toBe(true);
    expect(isEndpointAllowed("GET", "https://open.larksuite.com/open-apis/wiki/v2/spaces/get_node?token=wikcnSHEET")).toBe(false);
  });

  it("refuses to read a non-docx wiki node and comments with its real file type", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi", get_doc_comments: "openapi" });
    const { accessToken } = await login();
    const nodeToken = "Y9sSwvSHEET";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: "shtcnOBJ", obj_type: "sheet", space_id: "spcW", node_token: nodeToken } },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/drive/v1/files/shtcnOBJ/comments") {
        expect(url.searchParams.get("file_type")).toBe("sheet");
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            items: [{ comment_id: "cmtS", reply_list: { replies: [{ content: { elements: [{ type: "text_run", text_run: { text: "sheet note" } }] } }] } }],
          },
        });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const read = await callTool(accessToken, "fetch_doc", { doc: nodeToken });
    expect((read.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(toolText(read.body)).toBe("this is a sheet; use read_sheet");
    expect(fake.calls.slice(before).some((call) => call.url.includes("/raw_content"))).toBe(false);
    const comments = toolText((await callTool(accessToken, "get_doc_comments", { doc: nodeToken })).body);
    expect(comments).toContain("sheet note");
    const commentCall = fake.calls.find((call) => call.url.includes("/files/shtcnOBJ/comments"));
    expect(new URL(commentCall?.url ?? "https://open.feishu.cn/").searchParams.get("file_type")).toBe("sheet");
  });

  it("prints quote, solved state, author, mentions, and doc links on a comment", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ get_doc_comments: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131005, msg: "not found" });
      }
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        expect(url.searchParams.getAll("user_ids").sort()).toEqual(["ou_ada", "ou_bea", "ou_cy"]);
        return Response.json({
          code: 0,
          data: {
            items: [
              { open_id: "ou_ada", name: "Ada" },
              { open_id: "ou_bea", name: "Bea" },
              { open_id: "ou_cy", name: "Cy" },
            ],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/drive/v1/files/doxcn1/comments") {
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                comment_id: "cmt1",
                user_id: "ou_ada",
                is_whole: false,
                is_solved: true,
                quote: "anchored text",
                reply_list: {
                  replies: [
                    {
                      user_id: "ou_ada",
                      content: {
                        elements: [
                          { type: "text_run", text_run: { text: "see " } },
                          { type: "person", person: { user_id: "ou_bea" } },
                          { type: "text_run", text_run: { text: " " } },
                          { type: "docs_link", docs_link: { url: "https://example.feishu.cn/docx/doxcnLINK" } },
                        ],
                      },
                    },
                    {
                      user_id: "ou_cy",
                      content: { elements: [{ type: "text_run", text_run: { text: "follow up" } }] },
                    },
                  ],
                },
              },
              {
                comment_id: "cmt2",
                user_id: "ou_ada",
                is_whole: true,
                is_solved: false,
                reply_list: {
                  replies: [{ content: { elements: [{ type: "text_run", text_run: { text: "whole note" } }] } }],
                },
              },
            ],
          },
        });
      }
      return undefined;
    };
    const text = toolText((await callTool(accessToken, "get_doc_comments", { doc: "doxcn1" })).body);
    expect(text).toBe(
      [
        "comment_id: cmt1",
        "type: segment",
        "quote: anchored text",
        "solved: true",
        "author: Ada",
        "reply: Ada: see @Bea https://example.feishu.cn/docx/doxcnLINK",
        "reply: Cy: follow up",
        "",
        "comment_id: cmt2",
        "type: whole",
        "solved: false",
        "author: Ada",
        "text: whole note",
      ].join("\n"),
    );
  });

  it("stops contact lookups when the user token is invalid and still returns the comment", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ get_doc_comments: "openapi" });
    const { accessToken } = await login();
    const ids = Array.from({ length: 51 }, (_, index) => `ou_${index}`);
    let batchesBeforeRefresh = 0;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131005, msg: "not found" });
      }
      if (method === "GET" && url.pathname === "/open-apis/drive/v1/files/doxcn1/comments") {
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                comment_id: "cmt1",
                user_id: ids[0],
                is_whole: true,
                reply_list: {
                  replies: [
                    {
                      user_id: ids[0],
                      content: {
                        elements: [
                          { type: "text_run", text_run: { text: "note" } },
                          ...ids.slice(1).map((id) => ({ type: "person", person: { user_id: id } })),
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        const refreshed = fake.calls.some((call) => call.body.includes("grant_type=refresh_token"));
        if (!refreshed) {
          batchesBeforeRefresh += 1;
          return Response.json({ code: 99991663, msg: "invalid" });
        }
        const asked = url.searchParams.getAll("user_ids");
        return Response.json({
          code: 0,
          data: { items: asked.map((id) => ({ open_id: id, name: id === "ou_0" ? "Ada" : id })) },
        });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "get_doc_comments", { doc: "doxcn1" });
    expect(batchesBeforeRefresh).toBe(1);
    expect(ids).toHaveLength(51);
    expect(fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(1);
    expect(toolText(response.body)).toContain("Ada");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("caps an oversized doc at 100000 characters and marks the cut", async () => {
    const { accessToken } = await login();
    const huge = "y".repeat(100_050);
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ title: "Notes", markdown: huge }) }] },
      });
    };
    const text = toolText((await callTool(accessToken, "fetch_doc", { doc: "doxcnBIG" })).body);
    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(text.endsWith("[truncated; ask for the next page]")).toBe(true);
    expect(text.startsWith("title: Notes")).toBe(true);
  });

  it("searches drive and wiki together, keeps one page, and passes the opaque token through", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url, body) => {
      if (method !== "POST" || url.pathname !== "/open-apis/search/v2/doc_wiki/search") return undefined;
      const payload = JSON.parse(body) as { query?: string; page_size?: number; page_token?: string; doc_filter?: object; wiki_filter?: object };
      expect(payload.doc_filter).toEqual({});
      expect(payload.wiki_filter).toEqual({});
      expect((payload.query ?? "").length).toBeLessThanOrEqual(30);
      expect(payload.page_size).toBeLessThanOrEqual(20);
      if (payload.page_token === "opaque-2") {
        return Response.json({
          code: 0,
          data: {
            has_more: false,
            res_units: [
              {
                entity_type: "WIKI",
                title_highlighted: "Wiki <hb>spec</hb>",
                summary_highlighted: "body <h>match</h>",
                result_meta: {
                  token: "wikcnNODE",
                  doc_types: "DOCX",
                  url: "https://example.feishu.cn/wiki/wikcnNODE",
                  owner_id: "ou_owner",
                  update_time: 1710000001,
                  icon_info: JSON.stringify({ token: "doxcnUNDER", obj_type: 22 }),
                },
              },
            ],
          },
        });
      }
      return Response.json({
        code: 0,
        data: {
          has_more: true,
          page_token: "opaque-2",
          res_units: [
            {
              entity_type: "DOC",
              title_highlighted: "Quarterly plan",
              result_meta: {
                token: "doxcnHIT",
                doc_types: "DOCX",
                url: "https://example.feishu.cn/docx/doxcnHIT",
                owner_id: "ou_owner",
                update_time: 1710000000,
              },
            },
          ],
        },
      });
    };
    const before = fake.calls.length;
    const longQuery = "abcdefghijklmnopqrstuvwxyz0123456789EXTRA";
    const first = toolText((await callTool(accessToken, "search_docs", { query: longQuery, count: 50 })).body);
    const searchCalls = fake.calls.slice(before).filter((call) => call.url.includes("/search/v2/doc_wiki/search"));
    expect(searchCalls).toHaveLength(1);
    expect(JSON.parse(searchCalls[0]?.body ?? "{}")).toEqual({
      query: longQuery.slice(0, 30),
      page_size: 20,
      doc_filter: {},
      wiki_filter: {},
    });
    expect(fake.calls.slice(before).some((call) => call.url.includes("/suite/docs-api/search/object"))).toBe(false);
    expect(first).toContain("title: Quarterly plan");
    expect(first).toContain("type: docx");
    expect(first).toContain("token: doxcnHIT");
    expect(first).toContain("url: https://example.feishu.cn/docx/doxcnHIT");
    expect(first).toContain("owner: ou_owner");
    expect(first).toContain("edited: 1710000000");
    expect(first).toContain("page_token: opaque-2");
    expect(first).not.toContain("page cap reached");
    const continued = toolText((await callTool(accessToken, "search_docs", { query: "quarterly", count: 2, page_token: "opaque-2" })).body);
    expect(continued).toContain("title: Wiki spec");
    expect(continued).toContain("type: wiki");
    expect(continued).toContain("token: wikcnNODE");
    expect(continued).toContain("url: https://example.feishu.cn/wiki/wikcnNODE");
    expect(continued).toContain("obj_token: doxcnUNDER");
    expect(continued).toContain("summary: body match");
    expect(continued).not.toContain("<h>");
    expect(continued).not.toContain("<hb>");
    expect(continued).not.toContain("page_token:");
  });

  it("renders the captured doc_wiki page with urls, a wiki sheet, and the opaque token", async () => {
    expect(isEndpointAllowed("POST", "https://open.feishu.cn/open-apis/search/v2/doc_wiki/search")).toBe(true);
    expect(isEndpointAllowed("POST", "https://open.feishu.cn/open-apis/suite/docs-api/search/object")).toBe(false);
    const { accessToken } = await login();
    const data = docWikiCapture.data;
    fake.extra = (method, url, body) => {
      if (method !== "POST" || url.pathname !== "/open-apis/search/v2/doc_wiki/search") return undefined;
      const payload = JSON.parse(body) as {
        query?: string;
        page_size?: number;
        page_token?: string;
        doc_filter?: object;
        wiki_filter?: object;
        docs_types?: unknown;
      };
      expect(payload.docs_types).toBeUndefined();
      expect(payload.doc_filter).toEqual({});
      expect(payload.wiki_filter).toEqual({});
      expect(payload.page_size).toBeLessThanOrEqual(20);
      if (payload.page_token === undefined) return Response.json({ code: 0, data });
      expect(payload.page_token).toBe(data.page_token);
      return Response.json({ code: 0, data: { has_more: false, total: 0, res_units: [] } });
    };
    const before = fake.calls.length;
    const text = toolText((await callTool(accessToken, "search_docs", { query: "Lumen Brief" })).body);
    const sent = JSON.parse(fake.calls.slice(before).find((call) => call.url.includes("/search/v2/doc_wiki/search"))?.body ?? "{}") as { query?: string };
    expect(sent.query).toBe("Lumen Brief");
    expect(text).toContain("title: Lumen Brief");
    expect(text).toContain("type: wiki");
    expect(text).toContain("url: https://example.feishu.cn/wiki/wikcnDoc1");
    expect(text).toContain("obj_token: doxcnObj1");
    expect(text).toContain("title: UILumen Brief19990101");
    expect(text).toContain("url: https://example.feishu.cn/wiki/wikcnSheet");
    expect(text).toContain("token: wikcnSheet");
    expect(text).toContain("obj_token: shtcnObj");
    expect(text).toContain("title: Route Sketches");
    expect(text).toContain("url: https://example.feishu.cn/wiki/wikcnDoc3#doxcnAnchor");
    expect(text).toContain("summary: UILumen Brief19990101");
    expect(text).not.toContain("<h>");
    expect(text).not.toContain("type: sheet");
    expect(text).toContain(`page_token: ${data.page_token}`);
    const token = text.match(/page_token: (.+)/)?.[1];
    expect(token).toBe(data.page_token);
    expect(/^\d+$/.test(token ?? "")).toBe(false);
    const next = toolText((await callTool(accessToken, "search_docs", { query: "Lumen Brief", page_token: token })).body);
    expect(next).toBe("no matching docs");
  });

  it("prints drive sheets, bitable, and files instead of dropping them", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method !== "POST" || url.pathname !== "/open-apis/search/v2/doc_wiki/search") return undefined;
      return Response.json({
        code: 0,
        data: {
          has_more: false,
          total: 3,
          res_units: [
            { entity_type: "DOC", title_highlighted: "Budget", result_meta: { doc_types: "SHEET", token: "shtcn1", url: "https://example.feishu.cn/sheets/shtcn1" } },
            { entity_type: "DOC", title_highlighted: "Base", result_meta: { doc_types: "BITABLE", token: "bascn1", url: "https://example.feishu.cn/base/bascn1" } },
            { entity_type: "DOC", title_highlighted: "Attachment", result_meta: { doc_types: "FILE", token: "filecn1", url: "https://example.feishu.cn/file/filecn1" } },
          ],
        },
      });
    };
    const text = toolText((await callTool(accessToken, "search_docs", { query: "Talespark" })).body);
    expect(text).toContain("title: Budget\ntype: sheet\ntoken: shtcn1\nurl: https://example.feishu.cn/sheets/shtcn1");
    expect(text).toContain("title: Base\ntype: bitable\ntoken: bascn1\nurl: https://example.feishu.cn/base/bascn1");
    expect(text).toContain("title: Attachment\ntype: file\ntoken: filecn1\nurl: https://example.feishu.cn/file/filecn1");
  });

  it("truncates a search query on Unicode code points", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method !== "POST" || url.pathname !== "/open-apis/search/v2/doc_wiki/search") return undefined;
      return Response.json({ code: 0, data: { has_more: false, res_units: [] } });
    };
    const before = fake.calls.length;
    const query = `${"a".repeat(29)}😀tail`;
    await callTool(accessToken, "search_docs", { query });
    const body = fake.calls.slice(before).find((call) => call.url.includes("/search/v2/doc_wiki/search"))?.body ?? "{}";
    const sent = JSON.parse(body) as { query?: string };
    expect(sent.query).toBe(`${"a".repeat(29)}😀`);
    expect(body).not.toContain("\\ud83d");
  });

  it("uses the plain title when the highlighted title is empty", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method !== "POST" || url.pathname !== "/open-apis/search/v2/doc_wiki/search") return undefined;
      return Response.json({
        code: 0,
        data: {
          has_more: false,
          res_units: [
            {
              entity_type: "DOC",
              title: "Plain title",
              title_highlighted: "",
              result_meta: { doc_types: "DOCX", token: "doxcnPLAIN", url: "https://example.feishu.cn/docx/doxcnPLAIN" },
            },
            {
              entity_type: "WIKI",
              title: "Wiki only",
              result_meta: { doc_types: "DOCX", token: "wikcnONLY", url: "https://example.feishu.cn/wiki/wikcnONLY" },
            },
          ],
        },
      });
    };
    const text = toolText((await callTool(accessToken, "search_docs", { query: "plain" })).body);
    expect(text).toContain("title: Plain title\ntype: docx\ntoken: doxcnPLAIN");
    expect(text).toContain("title: Wiki only\ntype: wiki\ntoken: wikcnONLY");
  });

  it("replays the first wiki page omitted by the output cap", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ list_wiki_docs: "openapi" });
    const { accessToken } = await login();
    const title = "t".repeat(20_000);
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/wiki/v2/spaces/spc1/nodes") return undefined;
      const requested = url.searchParams.get("page_token");
      const page = requested === null ? 1 : Number(requested.slice("cont-".length)) + 1;
      return Response.json({
        code: 0,
        data: {
          has_more: true,
          page_token: `cont-${page}`,
          items: [{ node_token: `wikcn${page}`, obj_token: `doxcn${page}`, obj_type: "docx", title: `${title} ${page}` }],
        },
      });
    };
    const before = fake.calls.length;
    const first = toolText((await callTool(accessToken, "list_wiki_docs", { space_id: "spc1" })).body);
    const wikiCalls = fake.calls.slice(before).filter((call) => call.url.includes("/wiki/v2/spaces/spc1/nodes"));
    expect(wikiCalls.length).toBeGreaterThan(0);
    expect(wikiCalls.length).toBeLessThan(10);
    expect(first.length).toBeLessThanOrEqual(100_000);
    expect(first).toContain(`${title} 1`);
    expect(first).toContain("page cap reached");
    expect(first).not.toContain("[truncated; ask for the next page]");
    const token = first.match(/page_token: (\S+)/)?.[1];
    expect(token?.startsWith("cont-")).toBe(true);
    const omitted = Number(token?.slice("cont-".length)) + 1;
    expect(first).not.toContain(`${title} ${omitted}`);
    const continuedBefore = fake.calls.length;
    const continued = toolText((await callTool(accessToken, "list_wiki_docs", { space_id: "spc1", page_token: token })).body);
    const replay = fake.calls.slice(continuedBefore).find((call) => call.url.includes("/wiki/v2/spaces/spc1/nodes"));
    expect(new URL(replay?.url ?? "https://example.invalid/").searchParams.get("page_token")).toBe(token);
    expect(continued).toContain(`${title} ${omitted}`);
  });

  it("stops a never-ending wiki page at 10 pages and returns the next token", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ list_wiki_docs: "openapi" });
    const { accessToken } = await login();
    let pages = 0;
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/wiki/v2/spaces/spc1/nodes") return undefined;
      pages += 1;
      return Response.json({
        code: 0,
        data: {
          has_more: true,
          page_token: `cont-${pages}`,
          items: [{ node_token: `wikcn${pages}`, obj_token: `doxcn${pages}`, obj_type: "docx", title: `Doc ${pages}` }],
        },
      });
    };
    const before = fake.calls.length;
    const text = toolText((await callTool(accessToken, "list_wiki_docs", { space_id: "spc1" })).body);
    expect(pages).toBe(10);
    expect(fake.calls.length - before).toBeLessThanOrEqual(40);
    expect(text).toContain("page cap reached");
    expect(text).toContain("page_token: cont-10");
    expect(text).toContain("Doc 1");
    expect(text).toContain("Doc 10");
    expect(text).not.toContain("Doc 11");
  });

  it("audits target ids and keeps the query, title, and content out of the log", async () => {
    const logs = logLines();
    const { accessToken } = await login();
    env.TOOL_BACKENDS = JSON.stringify({ search_docs: "mcp" });
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string; params?: { name?: string } };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: `${payload.params?.name ?? ""} ${MARKER}` }] },
      });
    };
    await callTool(accessToken, "search_docs", { query: MARKER });
    await callTool(accessToken, "fetch_doc", { doc: "doxcnTARGET" });
    await callTool(accessToken, "list_wiki_docs", { node_token: "wikcnTARGET" });
    await callTool(accessToken, "get_doc_comments", { doc: "doxcnCOMMENT" });
    const joined = logs.lines().join("\n");
    expect(joined).not.toContain(MARKER);
    expect(joined).toContain('"tool":"search_docs"');
    expect(joined).toContain('"target":null');
    expect(joined).toContain('"target":"doxcnTARGET"');
    expect(joined).toContain('"target":"wikcnTARGET"');
    expect(joined).toContain('"target":"doxcnCOMMENT"');
    logs.restore();
  });

  it("refuses a truncated OpenAPI success body instead of returning raw tokens", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    const { accessToken } = await login();
    const secret = "img_v3_SECRETTOKEN";
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/docx/v1/documents/doxcnBIG/raw_content") return undefined;
      return Response.json({ code: 0, data: { content: `${secret}${"y".repeat(250_000)}` } });
    };
    const response = await callTool(accessToken, "fetch_doc", { doc: "doxcnBIG" });
    const text = toolText(response.body);
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(text).toBe("Feishu request failed");
    expect(text).not.toContain(secret);
    expect(text).not.toContain('"code"');
  });

  it("refuses a truncated Feishu MCP body instead of returning raw tokens", async () => {
    const { accessToken } = await login();
    const secret = "file_token_SECRETBOX";
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: `${secret}${"z".repeat(250_000)}` }] },
      });
    };
    const response = await callTool(accessToken, "fetch_doc", { doc: "doxcnBIG" });
    const text = toolText(response.body);
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(text).toBe("Feishu request failed");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("jsonrpc");
  });
});

/** Safe page: `<` expands to 7 encoded chars inside a JSON string inside the JSON-RPC body. */
const FETCH_DOC_PAGE = 28_000;

function fetchDocRpc(payload: Record<string, unknown> | string): Response {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

function presentedDoc(title: string, markdown: string, more?: { next?: number }): string {
  const parts: string[] = [];
  if (title.length > 0) parts.push(`title: ${title}`);
  if (markdown.length > 0) parts.push(markdown);
  if (more) {
    const rows = ["has_more: true"];
    if (more.next !== undefined) rows.push(`next_offset: ${more.next}`);
    parts.push(rows.join("\n"));
  }
  return parts.join("\n\n");
}

describe("fetch_doc pages", () => {
  it("parses the fetch-doc payload and returns the title with the markdown", async () => {
    const { accessToken } = await login();
    const page = fetchDocPages.emoji;
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const call = JSON.parse(body) as { method?: string; params?: { arguments?: { offset?: number; limit?: number } } };
      if (call.method !== "tools/call") return undefined;
      expect(call.params?.arguments).toEqual({ doc_id: "doxcnEMOJI", offset: page.args.offset, limit: page.args.limit });
      return fetchDocRpc(page.payload);
    };
    const text = toolText((await callTool(accessToken, "fetch_doc", { doc: "doxcnEMOJI", offset: page.args.offset, limit: page.args.limit })).body);
    expect(text).toBe(presentedDoc(page.payload.title, page.payload.markdown, { next: page.payload.next_offset }));
    expect(text).toContain("🔥");
    expect(text).not.toContain("doc_id");
    expect(text).not.toContain("log_id");
    expect(text).not.toContain('"markdown"');
  });

  it("accepts a structured fetch-doc object when the wrapper has no text field", async () => {
    const { accessToken } = await login();
    const page = fetchDocPages.emoji.payload;
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const call = JSON.parse(body) as { method?: string };
      if (call.method !== "tools/call") return undefined;
      return Response.json({ jsonrpc: "2.0", id: 1, result: page });
    };
    const text = toolText((await callTool(accessToken, "fetch_doc", { doc: "doxcnEMOJI" })).body);
    expect(text).toBe(presentedDoc(page.title, page.markdown, { next: page.next_offset }));
  });

  it("passes offset and limit through, clamps a negative offset, and always sends a fitting limit", async () => {
    expect(FETCH_DOC_PAGE * 7).toBeLessThan(BODY_CHAR_LIMIT);
    const { accessToken } = await login();
    const seen: unknown[] = [];
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const call = JSON.parse(body) as { method?: string; params?: { arguments?: unknown } };
      if (call.method !== "tools/call") return undefined;
      seen.push(call.params?.arguments);
      return fetchDocRpc({ title: "Notes", markdown: "hello" });
    };
    const negative = fetchDocPages.negative_offset;
    const plain = await callTool(accessToken, "fetch_doc", { doc: "doxcnDOC" });
    expect(toolText(plain.body)).toBe("title: Notes\n\nhello");
    await callTool(accessToken, "fetch_doc", { doc: "doxcnDOC", offset: negative.args.offset, limit: negative.args.limit });
    await callTool(accessToken, "fetch_doc", { doc: "doxcnDOC", offset: 0, limit: 0 });
    await callTool(accessToken, "fetch_doc", { doc: "doxcnDOC", limit: -5 });
    await callTool(accessToken, "fetch_doc", { doc: "doxcnDOC", offset: 5000, limit: 5000 });
    expect(seen).toEqual([
      { doc_id: "doxcnDOC", limit: FETCH_DOC_PAGE },
      { doc_id: "doxcnDOC", offset: negative.sent_offset, limit: negative.args.limit },
      { doc_id: "doxcnDOC", offset: 0, limit: FETCH_DOC_PAGE },
      { doc_id: "doxcnDOC", limit: FETCH_DOC_PAGE },
      { doc_id: "doxcnDOC", offset: 5000, limit: 5000 },
    ]);
  });

  it("clamps a caller limit above the safe page and keeps Feishu's next_offset", async () => {
    const { accessToken } = await login();
    const seen: unknown[] = [];
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const call = JSON.parse(body) as { method?: string; params?: { arguments?: { offset?: number; limit?: number } } };
      if (call.method !== "tools/call") return undefined;
      const sent = call.params?.arguments ?? {};
      seen.push(sent);
      const offset = sent.offset ?? 0;
      return fetchDocRpc({
        title: "Notes",
        markdown: "page",
        has_more: true,
        next_offset: offset + (sent.limit ?? 0),
      });
    };
    const first = await callTool(accessToken, "fetch_doc", { doc: "doxcnDOC", offset: 0, limit: 100_000 });
    const second = await callTool(accessToken, "fetch_doc", { doc: "doxcnDOC", offset: FETCH_DOC_PAGE, limit: 200_000 });
    expect(seen).toEqual([
      { doc_id: "doxcnDOC", offset: 0, limit: FETCH_DOC_PAGE },
      { doc_id: "doxcnDOC", offset: FETCH_DOC_PAGE, limit: FETCH_DOC_PAGE },
    ]);
    expect(toolText(first.body)).toBe(presentedDoc("Notes", "page", { next: FETCH_DOC_PAGE }));
    expect(toolText(second.body)).toBe(presentedDoc("Notes", "page", { next: FETCH_DOC_PAGE * 2 }));
    expect(toolText(first.body)).not.toContain("[truncated; ask for the next page]");
  });

  it("uses has_more and next_offset for the continuation note and does not probe an extra character", async () => {
    const { accessToken } = await login();
    const page = fetchDocPages.second_page;
    let sent: { offset?: number; limit?: number } = {};
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const call = JSON.parse(body) as { method?: string; params?: { arguments?: { offset?: number; limit?: number } } };
      if (call.method !== "tools/call") return undefined;
      sent = call.params?.arguments ?? {};
      return fetchDocRpc(page.payload);
    };
    const text = toolText((await callTool(accessToken, "fetch_doc", { doc: "doxcnDOC", offset: page.args.offset, limit: page.args.limit })).body);
    expect(sent).toEqual({ doc_id: "doxcnDOC", offset: 5000, limit: 5000 });
    expect(text).toBe(presentedDoc(page.payload.title, "<l", { next: 10000 }));
    expect(text).not.toContain("ask for the next page");
  });

  it("returns an empty page with no continuation when the offset is past the end", async () => {
    const { accessToken } = await login();
    const page = fetchDocPages.past_end;
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const call = JSON.parse(body) as { method?: string };
      if (call.method !== "tools/call") return undefined;
      return fetchDocRpc(page.payload);
    };
    const text = toolText((await callTool(accessToken, "fetch_doc", { doc: "doxcnDOC", offset: page.args.offset, limit: page.args.limit })).body);
    expect(text).toBe(presentedDoc(page.payload.title, page.payload.markdown));
    expect(text).not.toContain("has_more");
    expect(text).not.toContain("next_offset");
  });

  it("does not return a content string that is not the fetch-doc payload", async () => {
    const { accessToken } = await login();
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const call = JSON.parse(body) as { method?: string };
      if (call.method !== "tools/call") return undefined;
      return fetchDocRpc('{"doc_id":"doxcn1","markdown":');
    };
    const response = await callTool(accessToken, "fetch_doc", { doc: "doxcnDOC" });
    const text = toolText(response.body);
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(text).toBe("Feishu request failed");
    expect(text).not.toContain("doc_id");
  });

  it("caps a long OpenAPI read and points at the MCP backend", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    const { accessToken } = await login();
    const content = `START${"y".repeat(120_000)}`;
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/docx/v1/documents/doxcnLONG/raw_content") return undefined;
      return Response.json({ code: 0, data: { content } });
    };
    const response = await callTool(accessToken, "fetch_doc", { doc: "doxcnLONG", offset: 10, limit: 10 });
    const text = toolText(response.body);
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
    expect(text.startsWith("START")).toBe(true);
    expect(text.endsWith("Use the MCP backend to read the rest.")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(text).not.toContain("[truncated; ask for the next page]");
    expect(fake.calls.filter((call) => call.url.includes("/raw_content"))).toHaveLength(1);
  });
});


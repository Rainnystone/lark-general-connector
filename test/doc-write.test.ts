import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MARKER } from "./fake-feishu";
import { capturedTool } from "./mcp-schema";
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

describe("doc write tools", () => {
  it("lists create, update, and comment with write annotations", async () => {
    const { accessToken } = await login();
    const before = fake.calls.length;
    const tools = await listTools(accessToken);
    expect(fake.calls).toHaveLength(before);
    const annotationsOf = (name: string) => {
      const tool = tools.find((entry) => entry.name === name);
      return {
        title: tool?.title,
        description: typeof tool?.description === "string" ? tool.description : "",
        annotations: tool?.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean },
        schema: tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] },
      };
    };
    const create = annotationsOf("create_doc");
    expect(create.title).toBe("Create a Feishu doc");
    expect(create.description).toContain("MCP is the default");
    expect(create.description).toContain("plain text");
    expect(create.annotations.readOnlyHint).toBe(false);
    expect(create.annotations.destructiveHint).toBe(false);
    expect(Object.keys(create.schema.properties ?? {})).toEqual(["title", "content_markdown", "wiki_node_token", "folder_token"]);
    expect(create.schema.required).toEqual(["title", "content_markdown"]);

    const update = annotationsOf("update_doc");
    expect(update.title).toBe("Update a Feishu doc");
    expect(update.description).toContain("MCP is the default");
    expect(update.description).toContain("only appends");
    expect(update.description).toContain("plain text");
    expect(update.annotations.readOnlyHint).toBe(false);
    expect(update.annotations.destructiveHint).toBe(true);
    expect(Object.keys(update.schema.properties ?? {})).toEqual([
      "doc",
      "mode",
      "content_markdown",
      "selection_with_ellipsis",
      "selection_by_title",
      "new_title",
    ]);
    expect(update.schema.required).toEqual(["doc", "mode", "content_markdown"]);

    const comment = annotationsOf("add_doc_comment");
    expect(comment.title).toBe("Comment on a doc");
    expect(comment.annotations.readOnlyHint).toBe(false);
    expect(comment.annotations.destructiveHint).toBe(false);
    expect(Object.keys(comment.schema.properties ?? {})).toEqual(["doc", "text"]);
    expect(comment.schema.required).toEqual(["doc", "text"]);
    const mode = update.schema.properties?.mode as { enum?: string[] };
    const capturedModes = capturedTool("update-doc").inputSchema.properties?.mode?.enum ?? [];
    expect([...(mode.enum ?? [])].sort()).toEqual([...capturedModes].sort());
  });

  it("calls each Feishu MCP write tool once with the captured arguments", async () => {
    expect(capturedTool("add-comments").inputSchema.required).toEqual(["doc_id", "elements"]);
    const { accessToken } = await login();
    const cases = [
      {
        name: "create_doc",
        args: { title: "Notes", content_markdown: "hello", wiki_node_token: "wikcn1" },
        feishuTool: "create-doc",
        text: "created",
        arguments: { title: "Notes", markdown: "hello", wiki_node: "wikcn1" },
      },
      {
        name: "create_doc",
        args: { title: "Notes", content_markdown: "hello", folder_token: "fldcn1" },
        feishuTool: "create-doc",
        text: "created-folder",
        arguments: { title: "Notes", markdown: "hello", folder_token: "fldcn1" },
      },
      {
        name: "update_doc",
        args: {
          doc: "doxcnDOC",
          mode: "replace_range",
          content_markdown: "replacement",
          selection_with_ellipsis: "start...end",
          selection_by_title: "## Goals",
          new_title: "Renamed",
        },
        feishuTool: "update-doc",
        text: "updated",
        arguments: {
          doc_id: "doxcnDOC",
          mode: "replace_range",
          markdown: "replacement",
          selection_with_ellipsis: "start...end",
          selection_by_title: "## Goals",
          new_title: "Renamed",
        },
      },
      {
        name: "add_doc_comment",
        args: { doc: "doxcnDOC", text: "looks good" },
        feishuTool: "add-comments",
        text: "commented",
        arguments: { doc_id: "doxcnDOC", elements: [{ type: "text", text: "looks good" }] },
      },
    ] as const;

    for (const item of cases) {
      const before = fake.calls.length;
      fake.extra = (_method, url, body) => {
        if (url.pathname !== "/mcp") return undefined;
        const payload = JSON.parse(body) as { method?: string };
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
      expect(fake.calls.slice(before).some((call) => call.url.includes("open.feishu.cn"))).toBe(false);
      expect(sent[0]?.headers["x-lark-mcp-uat"]).toBe("u-access-1");
      expect(sent[0]?.headers["x-lark-mcp-allowed-tools"]).toBe(item.feishuTool);
      const payload = JSON.parse(sent[0]?.body ?? "{}") as {
        method?: string;
        params?: { name?: string; arguments?: unknown };
      };
      expect(payload.method).toBe("tools/call");
      expect(payload.params?.name).toBe(item.feishuTool);
      expect(payload.params?.arguments).toEqual(item.arguments);
      expect(toolText(response.body)).toBe(item.text);
    }
  });

  it("creates a cloud-space doc and writes one plain-text block per paragraph", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ create_doc: "openapi" });
    const { accessToken } = await login();
    const order: string[] = [];
    fake.extra = (method, url, body) => {
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents") {
        order.push("create");
        const payload = JSON.parse(body) as { title?: string; folder_token?: string };
        expect(payload).toEqual({ title: "Notes", folder_token: "fldcn1" });
        return Response.json({ code: 0, data: { document: { document_id: "doxcnNEW", title: "Notes" } } });
      }
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents/doxcnNEW/blocks/doxcnNEW/children") {
        order.push("blocks");
        const payload = JSON.parse(body) as {
          index?: number;
          children?: Array<{ block_type?: number; text?: { elements?: Array<{ text_run?: { content?: string } }> } }>;
        };
        expect(payload.index).toBe(-1);
        const texts = (payload.children ?? []).map((block) => block.text?.elements?.[0]?.text_run?.content);
        expect(payload.children?.every((block) => block.block_type === 2)).toBe(true);
        expect(texts).toEqual(["## Heading", "plain paragraph"]);
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "create_doc", {
      title: "Notes",
      content_markdown: "## Heading\n\nplain paragraph",
      folder_token: "fldcn1",
    });
    expect(order).toEqual(["create", "blocks"]);
    expect(fake.calls.slice(before).some((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
    expect(toolText(response.body)).toContain("doxcnNEW");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("appends paragraphs on the OpenAPI backend", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ update_doc: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url, body) => {
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents/doxcn1/blocks/doxcn1/children") {
        const payload = JSON.parse(body) as {
          index?: number;
          children?: Array<{ block_type?: number; text?: { elements?: Array<{ text_run?: { content?: string } }> } }>;
        };
        expect(payload.index).toBe(-1);
        const texts = (payload.children ?? []).map((block) => block.text?.elements?.[0]?.text_run?.content);
        expect(texts).toEqual(["first line", "second line"]);
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "update_doc", {
      doc: "https://example.feishu.cn/docx/doxcn1",
      mode: "append",
      content_markdown: "first line\nsecond line",
    });
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
    expect(sent.filter((call) => call.url.includes("/blocks/"))).toHaveLength(1);
    expect(toolText(response.body)).toContain("doxcn1");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("does not report success when an append response is not JSON", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ update_doc: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents/doxcn1/blocks/doxcn1/children") {
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "update_doc", { doc: "doxcn1", mode: "append", content_markdown: "a line" });
    expect(toolText(response.body)).toBe("Feishu request failed");
    expect(toolText(response.body)).not.toContain("token:");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("refuses OpenAPI overwrite without a Feishu write", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ update_doc: "openapi" });
    const { accessToken } = await login();
    const before = fake.calls.length;
    const response = await callTool(accessToken, "update_doc", {
      doc: "doxcn1",
      mode: "overwrite",
      content_markdown: "replacement",
    });
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.url.includes("open.feishu.cn") || call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
    expect(toolText(response.body)).toBe("not supported on openapi backend; switch `update_doc` back to mcp");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("posts one whole-document comment on the OpenAPI backend", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ add_doc_comment: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url, body) => {
      if (method === "POST" && url.pathname === "/open-apis/drive/v1/files/doxcn1/comments") {
        expect(url.searchParams.get("file_type")).toBe("docx");
        const payload = JSON.parse(body) as {
          reply_list?: { replies?: Array<{ content?: { elements?: Array<{ type?: string; text_run?: { text?: string } }> } }> };
        };
        expect(payload).toEqual({
          reply_list: {
            replies: [{ content: { elements: [{ type: "text_run", text_run: { text: "looks good" } }] } }],
          },
        });
        return Response.json({ code: 0, data: { comment_id: "cmt9" } });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "add_doc_comment", { doc: "doxcn1", text: "looks good" });
    const sent = fake.calls.slice(before);
    expect(sent.filter((call) => call.url.includes("/comments"))).toHaveLength(1);
    expect(sent.some((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
    expect(toolText(response.body)).toContain("cmt9");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("refuses a create whose plan exceeds the write budget before writing", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ create_doc: "openapi" });
    const { accessToken } = await login();
    // 1 create + 38 paragraph batches = 39 Feishu calls, above the 38-call write budget.
    const content = Array.from({ length: 1851 }, (_, index) => `p${index}`).join("\n");
    const before = fake.calls.length;
    const response = await callTool(accessToken, "create_doc", { title: "Long", content_markdown: content });
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.url.includes("/docx/") || call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
    expect(toolText(response.body)).toBe("too long, split it");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("creates a doc that uses the full write budget", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ create_doc: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents") {
        return Response.json({ code: 0, data: { document: { document_id: "doxcnFULL" } } });
      }
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents/doxcnFULL/blocks/doxcnFULL/children") {
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    // 1 create + 37 batches of 50 = 38 Feishu calls, the whole write budget.
    const content = Array.from({ length: 1850 }, (_, index) => `p${index}`).join("\n");
    const before = fake.calls.length;
    const response = await callTool(accessToken, "create_doc", { title: "Full", content_markdown: content });
    const sent = fake.calls.slice(before);
    expect(sent.filter((call) => call.url.includes("/children"))).toHaveLength(37);
    expect(sent.filter((call) => call.url.endsWith("/open-apis/docx/v1/documents"))).toHaveLength(1);
    expect(sent).toHaveLength(38);
    expect(toolText(response.body)).toContain("doxcnFULL");
  });

  it("refuses an append whose plan exceeds the write budget before writing", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ update_doc: "openapi" });
    const { accessToken } = await login();
    // 39 paragraph batches, above the 38-call write budget.
    const content = Array.from({ length: 1901 }, (_, index) => `p${index}`).join("\n");
    const before = fake.calls.length;
    const response = await callTool(accessToken, "update_doc", { doc: "doxcn1", mode: "append", content_markdown: content });
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.url.includes("open.feishu.cn") || call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
    expect(toolText(response.body)).toBe("too long, split it");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("appends a doc that uses the full write budget", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ update_doc: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents/doxcn1/blocks/doxcn1/children") {
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    const content = Array.from({ length: 1900 }, (_, index) => `p${index}`).join("\n");
    const before = fake.calls.length;
    const response = await callTool(accessToken, "update_doc", {
      doc: "https://example.feishu.cn/docx/doxcn1",
      mode: "append",
      content_markdown: content,
    });
    const sent = fake.calls.slice(before);
    expect(sent.filter((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toHaveLength(0);
    expect(sent.filter((call) => call.url.includes("/children"))).toHaveLength(38);
    expect(sent).toHaveLength(38);
    expect(toolText(response.body)).toContain("doxcn1");
  });

  it("counts get_node against the write budget for a bare token", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ update_doc: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        expect(url.searchParams.get("obj_type")).toBeNull();
        return Response.json({ code: 131005, msg: "not found" });
      }
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents/doxcn1/blocks/doxcn1/children") {
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    // get_node plus 37 batches of 50 = 38 Feishu calls, the whole write budget.
    const content = Array.from({ length: 1850 }, (_, index) => `p${index}`).join("\n");
    const before = fake.calls.length;
    const response = await callTool(accessToken, "update_doc", { doc: "doxcn1", mode: "append", content_markdown: content });
    const sent = fake.calls.slice(before);
    expect(sent.filter((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toHaveLength(1);
    expect(sent.filter((call) => call.url.includes("/children"))).toHaveLength(37);
    expect(sent).toHaveLength(38);
    expect(toolText(response.body)).toContain("doxcn1");
  });

  it("splits a long create into batches that stay within 40 calls", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ create_doc: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url, body) => {
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents") {
        return Response.json({ code: 0, data: { document: { document_id: "doxcnBATCH" } } });
      }
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents/doxcnBATCH/blocks/doxcnBATCH/children") {
        const payload = JSON.parse(body) as { children?: unknown[] };
        return Response.json({ code: 0, data: { written: payload.children?.length ?? 0 } });
      }
      return undefined;
    };
    const content = Array.from({ length: 51 }, (_, index) => `p${index}`).join("\n");
    const before = fake.calls.length;
    const response = await callTool(accessToken, "create_doc", { title: "Batch", content_markdown: content });
    const sent = fake.calls.slice(before);
    const blocks = sent.filter((call) => call.url.includes("/children"));
    expect(blocks).toHaveLength(2);
    const sizes = blocks.map((call) => (JSON.parse(call.body) as { children?: unknown[] }).children?.length);
    expect(sizes).toEqual([50, 1]);
    expect(sent.length).toBeLessThanOrEqual(40);
    expect(toolText(response.body)).toContain("doxcnBATCH");
  });

  it("refuses an OpenAPI wiki create before any write", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ create_doc: "openapi" });
    const { accessToken } = await login();
    const before = fake.calls.length;
    const response = await callTool(accessToken, "create_doc", {
      title: "Wiki",
      content_markdown: "body",
      wiki_node_token: "wikcn1",
    });
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.url.includes("open.feishu.cn") || call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
    expect(toolText(response.body)).toBe("not supported on openapi backend; switch `create_doc` back to mcp");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("appends to a wiki doc through the resolved doc token", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ update_doc: "openapi" });
    const logs = logLines();
    const { accessToken } = await login();
    const order: string[] = [];
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        order.push(`get_node:${url.searchParams.get("token")}`);
        return Response.json({ code: 0, data: { node: { obj_token: "doxcnOBJ", obj_type: "docx", space_id: "spcW" } } });
      }
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents/doxcnOBJ/blocks/doxcnOBJ/children") {
        order.push("blocks");
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    try {
      const response = await callTool(accessToken, "update_doc", {
        doc: "https://example.feishu.cn/wiki/wikcnNODE",
        mode: "append",
        content_markdown: "added",
      });
      expect(order).toEqual(["get_node:wikcnNODE", "blocks"]);
      expect(toolText(response.body)).toContain("doxcnOBJ");
      const joined = logs.lines().join("\n");
      expect(joined).toContain('"target":"doxcnOBJ"');
      expect(joined).not.toContain("wikcnNODE");
    } finally {
      logs.restore();
    }
  });

  it("comments on a wiki doc through the resolved doc token", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ add_doc_comment: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url, body) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 0, data: { node: { obj_token: "doxcnOBJ", obj_type: "docx", space_id: "spcW" } } });
      }
      if (method === "POST" && url.pathname === "/open-apis/drive/v1/files/doxcnOBJ/comments") {
        expect(url.searchParams.get("file_type")).toBe("docx");
        expect(body).toContain("note");
        return Response.json({ code: 0, data: { comment_id: "cmtW" } });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "add_doc_comment", {
      doc: "https://example.feishu.cn/wiki/wikcnNODE",
      text: "note",
    });
    expect(toolText(response.body)).toContain("cmtW");
  });

  it("appends and comments on a bare wiki node token through the resolved file", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ update_doc: "openapi", add_doc_comment: "openapi" });
    const logs = logLines();
    const { accessToken } = await login();
    const nodeToken = "Y9sSwvNODE";
    fake.extra = (method, url, body) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        expect(url.searchParams.get("token")).toBe(nodeToken);
        expect(url.searchParams.get("obj_type")).toBeNull();
        return Response.json({
          code: 0,
          data: { node: { obj_token: "doxcnOBJ", obj_type: "docx", space_id: "spcW", node_token: nodeToken } },
        });
      }
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents/doxcnOBJ/blocks/doxcnOBJ/children") {
        expect(body).toContain("added");
        return Response.json({ code: 0, data: {} });
      }
      if (method === "POST" && url.pathname === "/open-apis/drive/v1/files/doxcnOBJ/comments") {
        expect(url.searchParams.get("file_type")).toBe("docx");
        expect(body).toContain("note");
        return Response.json({ code: 0, data: { comment_id: "cmtN" } });
      }
      return undefined;
    };
    try {
      const appended = await callTool(accessToken, "update_doc", { doc: nodeToken, mode: "append", content_markdown: "added" });
      expect(toolText(appended.body)).toContain("doxcnOBJ");
      expect((appended.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
      const commented = await callTool(accessToken, "add_doc_comment", { doc: nodeToken, text: "note" });
      expect(toolText(commented.body)).toContain("cmtN");
      const joined = logs.lines().join("\n");
      expect(joined).toContain('"target":"doxcnOBJ"');
      expect(joined).not.toContain(nodeToken);
      expect(fake.calls.some((call) => call.url.includes(`/documents/${nodeToken}/`))).toBe(false);
      expect(fake.calls.some((call) => call.url.includes(`/files/${nodeToken}/`))).toBe(false);
    } finally {
      logs.restore();
    }
  });

  it("refuses to update or comment on a non-docx wiki node", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ update_doc: "openapi", add_doc_comment: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        const token = url.searchParams.get("token");
        const objType = token === "Y9sSwvBITABLE" ? "bitable" : "sheet";
        const objToken = objType === "bitable" ? "bascnOBJ" : "shtcnOBJ";
        return Response.json({
          code: 0,
          data: { node: { obj_token: objToken, obj_type: objType, space_id: "spcW", node_token: token } },
        });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const updated = await callTool(accessToken, "update_doc", { doc: "Y9sSwvSHEET", mode: "append", content_markdown: "added" });
    expect(toolText(updated.body)).toBe("only docx can be updated here (this is a sheet)");
    expect((updated.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    const commented = await callTool(accessToken, "add_doc_comment", { doc: "Y9sSwvBITABLE", text: "note" });
    expect(toolText(commented.body)).toBe("only docx can be commented on here (this is a bitable)");
    expect((commented.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.url.includes("/children") || call.url.includes("/comments"))).toBe(false);
  });

  it("audits doc tokens and keeps the title and content out of the log", async () => {
    const logs = logLines();
    const { accessToken } = await login();
    fake.extra = (method, url, body) => {
      if (url.pathname === "/mcp") {
        const payload = JSON.parse(body) as { method?: string; params?: { name?: string } };
        if (payload.method !== "tools/call") return undefined;
        if (payload.params?.name === "create-doc") {
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: JSON.stringify({ doc_id: "doxcnCREATED", title: MARKER }) }] },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });
      }
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents") {
        return Response.json({ code: 0, data: { document: { document_id: "doxcnOPEN", title: MARKER } } });
      }
      if (method === "POST" && url.pathname.includes("/children")) return Response.json({ code: 0, data: {} });
      if (method === "POST" && url.pathname.includes("/comments")) return Response.json({ code: 0, data: { comment_id: "cmt1" } });
      return undefined;
    };
    try {
      await callTool(accessToken, "create_doc", { title: MARKER, content_markdown: MARKER });
      env.TOOL_BACKENDS = JSON.stringify({ create_doc: "openapi", update_doc: "openapi", add_doc_comment: "openapi" });
      await callTool(accessToken, "create_doc", { title: MARKER, content_markdown: MARKER });
      await callTool(accessToken, "update_doc", { doc: "doxcnTARGET", mode: "append", content_markdown: MARKER });
      await callTool(accessToken, "add_doc_comment", { doc: "doxcnCOMMENT", text: MARKER });
      const joined = logs.lines().join("\n");
      expect(joined).not.toContain(MARKER);
      expect(joined).toContain('"tool":"create_doc"');
      expect(joined).toContain('"target":"doxcnCREATED"');
      expect(joined).toContain('"target":"doxcnOPEN"');
      expect(joined).toContain('"target":"doxcnTARGET"');
      expect(joined).toContain('"target":"doxcnCOMMENT"');
    } finally {
      logs.restore();
    }
  });

  it("keeps update on MCP when only create is switched to OpenAPI", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ create_doc: "openapi" });
    const { accessToken } = await login();
    fake.extra = (method, url, body) => {
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents") {
        return Response.json({ code: 0, data: { document: { document_id: "doxcnNEW" } } });
      }
      if (url.pathname === "/mcp") {
        const payload = JSON.parse(body) as { method?: string; params?: { name?: string } };
        if (payload.method === "tools/call" && payload.params?.name === "update-doc") {
          return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "mcp-update" }] } });
        }
      }
      return undefined;
    };
    const created = await callTool(accessToken, "create_doc", { title: "Notes", content_markdown: "" });
    expect(toolText(created.body)).toContain("doxcnNEW");
    const before = fake.calls.length;
    const updated = await callTool(accessToken, "update_doc", { doc: "doxcnNEW", mode: "append", content_markdown: "more" });
    const sent = fake.calls.slice(before).filter((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"));
    expect(sent).toHaveLength(1);
    expect(toolText(updated.body)).toBe("mcp-update");
  });

  it("refreshes a failed block write without creating a second doc", async () => {
    env.TOOL_BACKENDS = JSON.stringify({ create_doc: "openapi" });
    const { accessToken } = await login();
    let documents = 0;
    let blocks = 0;
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents") {
        documents += 1;
        return Response.json({ code: 0, data: { document: { document_id: "doxcnONCE" } } });
      }
      if (method === "POST" && url.pathname === "/open-apis/docx/v1/documents/doxcnONCE/blocks/doxcnONCE/children") {
        blocks += 1;
        if (blocks === 1) return Response.json({ code: 99991677, msg: "expired" });
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "create_doc", { title: "Notes", content_markdown: "hello" });
    expect(toolText(response.body)).toContain("doxcnONCE");
    expect(documents).toBe(1);
    expect(blocks).toBe(2);
    expect(fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(1);
  });
});


import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MARKER } from "./fake-feishu";
import { callTool, listTools, logLines, login, toolText, useFakeFeishu, workerFetch } from "./support";

const fake = useFakeFeishu();

describe("delete doc to recycle bin", () => {
  it("lists delete_doc as a destructive move to the recycle bin", async () => {
    const { accessToken } = await login();
    const before = fake.calls.length;
    const tools = await listTools(accessToken);
    expect(fake.calls).toHaveLength(before);
    const tool = tools.find((entry) => entry.name === "delete_doc");
    const annotations = tool?.annotations as {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
    };
    const schema = tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(tool?.title).toBe("Move a doc to the recycle bin");
    expect(annotations.readOnlyHint).toBe(false);
    expect(annotations.destructiveHint).toBe(true);
    expect(annotations.idempotentHint).toBe(false);
    expect(tool?.description).toContain("docx");
    expect(tool?.description).toContain("Wiki docs are refused");
    expect(tool?.description).toContain("回收站");
    expect(tool?.description).toContain("exact title");
    expect(Object.keys(schema.properties ?? {})).toEqual(["doc", "confirm_title"]);
    expect(schema.required).toEqual(["doc", "confirm_title"]);
  });

  it("moves a cloud-space docx to the recycle bin when the title matches", async () => {
    const { accessToken } = await login();
    const order: string[] = [];
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        expect(url.searchParams.get("token")).toBe("doxcn1");
        if (!url.searchParams.has("obj_type")) {
          order.push("get_node");
          return Response.json({ code: 131005, msg: "not found" });
        }
        order.push("get_node_docx");
        expect(url.searchParams.get("obj_type")).toBe("docx");
        return Response.json({ code: 131005, msg: "document is not in wiki" });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1") {
        order.push("document");
        return Response.json({ code: 0, data: { document: { document_id: "doxcn1", title: "Quarterly plan" } } });
      }
      if (method === "DELETE" && url.pathname === "/open-apis/drive/v1/files/doxcn1") {
        order.push("delete");
        expect(url.searchParams.get("type")).toBe("docx");
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "delete_doc", {
      doc: "https://example.feishu.cn/docx/doxcn1?from=wiki",
      confirm_title: "Quarterly plan",
    });
    const sent = fake.calls.slice(before);
    expect(order).toEqual(["get_node", "get_node_docx", "document", "delete"]);
    expect(sent.some((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
    expect(toolText(response.body)).toBe("Moved to 云空间 回收站. It can be restored there.");
  });

  it("refuses a mismatched title without deleting or echoing the real title", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131005, msg: "document is not in wiki" });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1") {
        return Response.json({ code: 0, data: { document: { document_id: "doxcn1", title: MARKER } } });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "Wrong title" });
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.method === "DELETE")).toBe(false);
    const text = toolText(response.body);
    expect(text).not.toContain(MARKER);
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("refuses a missing or blank live title even when confirm_title is blank", async () => {
    const { accessToken } = await login();
    const documents = [
      undefined,
      { document_id: "doxcn1" },
      { document_id: "doxcn1", title: "" },
      { document_id: "doxcn1", title: "   " },
      { document_id: "doxcn1", title: null },
    ];
    for (const document of documents) {
      for (const confirm_title of ["", "   "]) {
        fake.extra = (method, url) => {
          if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
            return Response.json({ code: 131005, msg: "document is not in wiki" });
          }
          if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1") {
            const data = document === undefined ? {} : { document };
            return Response.json({ code: 0, data });
          }
          return undefined;
        };
        const before = fake.calls.length;
        const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title });
        expect(fake.calls.slice(before).some((call) => call.method === "DELETE")).toBe(false);
        expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
        expect(toolText(response.body)).toBe("Title does not match. Delete refused.");
      }
    }
  });

  it("accepts a title that differs only by surrounding spaces or NFC form", async () => {
    const { accessToken } = await login();
    let deleted = 0;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131005, msg: "document is not in wiki" });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1") {
        return Response.json({ code: 0, data: { document: { document_id: "doxcn1", title: "caf\u00e9" } } });
      }
      if (method === "DELETE" && url.pathname === "/open-apis/drive/v1/files/doxcn1") {
        deleted += 1;
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "  cafe\u0301  " });
    expect(deleted).toBe(1);
    expect(toolText(response.body)).toBe("Moved to 云空间 回收站. It can be restored there.");
  });

  it("refuses a wiki URL and a wiki node token before any Feishu call", async () => {
    const { accessToken } = await login();
    for (const doc of ["https://example.feishu.cn/wiki/wikcnNODE?from=copy", "wikcnNODE", "https://example.feishu.cn/docx/wikcnNODE"]) {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "delete_doc", { doc, confirm_title: "Anything" });
      expect(fake.calls.slice(before)).toEqual([]);
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      expect(toolText(response.body)).toBe("This doc lives in a wiki space; not deletable here.");
    }
  });

  it("refuses a bare wiki node token that does not start with wik", async () => {
    const { accessToken } = await login();
    const nodeToken = "Y9sSwvNODE";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        expect(url.searchParams.get("token")).toBe(nodeToken);
        if (url.searchParams.has("obj_type")) {
          return Response.json({ code: 131005, msg: "not found: document not found by token" });
        }
        return Response.json({
          code: 0,
          data: { node: { obj_token: "doxcnOBJ", obj_type: "docx", node_token: nodeToken } },
        });
      }
      if (method === "GET" && url.pathname === `/open-apis/docx/v1/documents/${nodeToken}`) {
        return Response.json({ code: 0, data: { document: { document_id: nodeToken, title: "Quarterly plan" } } });
      }
      if (method === "DELETE" && url.pathname === `/open-apis/drive/v1/files/${nodeToken}`) {
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "delete_doc", { doc: nodeToken, confirm_title: "Quarterly plan" });
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.method === "GET" && call.url.includes("/wiki/v2/spaces/get_node") && !call.url.includes("obj_type="))).toBe(true);
    expect(sent.some((call) => call.method === "DELETE")).toBe(false);
    expect(sent.some((call) => call.url.includes("/docx/v1/documents/"))).toBe(false);
    expect(toolText(response.body)).toBe("This doc lives in a wiki space; not deletable here.");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("refuses a docx token that get_node finds in a wiki space", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        if (!url.searchParams.has("obj_type")) return Response.json({ code: 131005, msg: "not found" });
        expect(url.searchParams.get("obj_type")).toBe("docx");
        return Response.json({ code: 0, data: { node: { obj_token: "doxcn1", obj_type: "docx", node_token: "wikcn1" } } });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "Quarterly plan" });
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.method === "DELETE")).toBe(false);
    expect(sent.some((call) => call.url.includes("/docx/v1/documents/"))).toBe(false);
    expect(toolText(response.body)).toBe("This doc lives in a wiki space; not deletable here.");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("refuses when the wiki check returns an unexpected error", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131001, msg: "rpc fail" });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "Quarterly plan" });
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.method === "DELETE")).toBe(false);
    expect(sent.some((call) => call.url.includes("/docx/v1/documents/"))).toBe(false);
    expect(toolText(response.body)).toContain("131001");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("refuses a malformed percent-encoding without calling Feishu and still audits", async () => {
    const logs = logLines();
    const { accessToken } = await login();
    const docs = [
      `https://example.feishu.cn/wiki/%?note=${MARKER}`,
      `https://example.feishu.cn/docx/%?note=${MARKER}`,
      `https://example.feishu.cn/sheets/%?note=${MARKER}`,
    ];
    try {
      for (const doc of docs) {
        const before = fake.calls.length;
        const response = await callTool(accessToken, "delete_doc", { doc, confirm_title: "Quarterly plan" });
        expect(fake.calls.slice(before)).toEqual([]);
        expect(toolText(response.body)).toBe("only Feishu docs (docx) can be deleted by this connector");
        expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
        expect(response.raw).not.toContain(MARKER);
      }
      const toolCalls = logs.lines().filter((line) => line.includes('"tool":"delete_doc"'));
      expect(toolCalls).toHaveLength(docs.length);
      for (const line of toolCalls) {
        expect(line).toContain('"ok":false');
        expect(line).toContain('"code":"only_docx"');
        expect(line).toContain('"target":null');
      }
      expect(logs.lines().join("\n")).not.toContain(MARKER);
    } finally {
      logs.restore();
    }
  });

  it("refuses sheet, bitable, and folder URLs before any Feishu call", async () => {
    const { accessToken } = await login();
    const docs = [
      "https://example.feishu.cn/sheets/shtcn1",
      "https://example.feishu.cn/base/bascn1",
      "https://example.feishu.cn/drive/folder/fldcn1",
      "https://example.feishu.cn/docs/doccnOLD",
      "https://example.feishu.cn/file/boxcn1",
    ];
    for (const doc of docs) {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "delete_doc", { doc, confirm_title: "Quarterly plan" });
      expect(fake.calls.slice(before)).toEqual([]);
      expect(toolText(response.body)).toBe("only Feishu docs (docx) can be deleted by this connector");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    }
  });

  it("maps drive delete errors 1061004 and 1061045 to refusal text", async () => {
    const { accessToken } = await login();
    const cases = [
      { code: 1061004, text: "not owned by you or lives in a wiki space" },
      { code: 1061045, text: "try again in a moment" },
    ];
    for (const item of cases) {
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
          return Response.json({ code: 131005, msg: "document is not in wiki" });
        }
        if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1") {
          return Response.json({ code: 0, data: { document: { document_id: "doxcn1", title: "Quarterly plan" } } });
        }
        if (method === "DELETE" && url.pathname === "/open-apis/drive/v1/files/doxcn1") {
          return Response.json({ code: item.code, msg: "forbidden" });
        }
        return undefined;
      };
      const before = fake.calls.length;
      const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "Quarterly plan" });
      const deletes = fake.calls.slice(before).filter((call) => call.method === "DELETE");
      expect(deletes).toHaveLength(1);
      expect(toolText(response.body)).toContain(item.text);
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    }
  });

  it("does not delete when the wiki check is rate limited", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131005, msg: "document is not in wiki" }, { status: 429 });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "Quarterly plan" });
    const sent = fake.calls.slice(before);
    expect(sent.some((call) => call.method === "DELETE")).toBe(false);
    expect(sent.some((call) => call.url.includes("/docx/v1/documents/"))).toBe(false);
    expect(toolText(response.body)).toBe("Wiki check failed (131005).");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("does not report a non-JSON delete response as moved to the recycle bin", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131005, msg: "document is not in wiki" });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1") {
        return Response.json({ code: 0, data: { document: { document_id: "doxcn1", title: "Quarterly plan" } } });
      }
      if (method === "DELETE" && url.pathname === "/open-apis/drive/v1/files/doxcn1") {
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "Quarterly plan" });
    expect(toolText(response.body)).toBe("Delete failed (200).");
    expect(toolText(response.body)).not.toContain("回收站");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("refuses when the document cannot be read, without deleting", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131005, msg: "document is not in wiki" });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1") {
        return Response.json({ code: 1770002, msg: "not found" });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "Quarterly plan" });
    expect(fake.calls.slice(before).some((call) => call.method === "DELETE")).toBe(false);
    expect(toolText(response.body)).toBe("Document not found or no access.");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("does not call Feishu when the kill switch is on", async () => {
    env.MCP_DISABLED = "1";
    const before = fake.calls.length;
    const response = await workerFetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "delete_doc", arguments: { doc: "doxcn1", confirm_title: "Quarterly plan" } },
      }),
    });
    expect(response.status).toBe(503);
    expect(fake.calls).toHaveLength(before);
  });

  it("refuses a caller who is not the owner before any delete", async () => {
    const { accessToken } = await login();
    const before = fake.calls.length;
    env.OWNER_OPEN_ID = "ou_other";
    const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "Quarterly plan" });
    expect(response.status).toBe(401);
    expect(fake.calls).toHaveLength(before);
  });

  it("refreshes once when Feishu rejects the user token, then deletes", async () => {
    const { accessToken } = await login();
    let checks = 0;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        checks += 1;
        if (checks === 1) return Response.json({ code: 99991677, msg: "expired" });
        return Response.json({ code: 131005, msg: "document is not in wiki" });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1") {
        return Response.json({ code: 0, data: { document: { document_id: "doxcn1", title: "Quarterly plan" } } });
      }
      if (method === "DELETE" && url.pathname === "/open-apis/drive/v1/files/doxcn1") {
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "Quarterly plan" });
    expect(toolText(response.body)).toBe("Moved to 云空间 回收站. It can be restored there.");
    expect(checks).toBe(3);
    expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.body.includes("grant_type=refresh_token"))).toHaveLength(1);
  });

  it("audits the doc token and omits the title", async () => {
    const logs = logLines();
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131005, msg: "document is not in wiki" });
      }
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1") {
        return Response.json({ code: 0, data: { document: { document_id: "doxcn1", title: MARKER } } });
      }
      if (method === "DELETE" && url.pathname === "/open-apis/drive/v1/files/doxcn1") {
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    try {
      const response = await callTool(accessToken, "delete_doc", { doc: "https://example.feishu.cn/docx/doxcn1", confirm_title: MARKER });
      expect(toolText(response.body)).toContain("回收站");
      const toolCalls = logs.lines().filter((line) => line.includes('"tool":"delete_doc"'));
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toContain('"target":"doxcn1"');
      expect(toolCalls[0]).toContain('"ok":true');
      expect(toolCalls[0]).toContain('"code":"0"');
      expect(logs.lines().join("\n")).not.toContain(MARKER);
    } finally {
      logs.restore();
    }
  });
});

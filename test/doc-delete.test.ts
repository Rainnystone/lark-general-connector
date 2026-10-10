import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import { MARKER } from "./fake-feishu";
import { callTool, listTools, logLines, login, toolText, useFakeFeishu, workerFetch } from "./support";

const fake = useFakeFeishu();

const META_URL = "https://open.feishu.cn/open-apis/drive/v1/metas/batch_query";
const ONLY_TYPES = "only Feishu docs (docx, sheet, bitable, slides, file) can be deleted by this connector";

const NEW_TYPES = [
  {
    kind: "sheet",
    path: "sheets",
    token: "shtcnEXAMPLE",
    title: "Release schedule (example)",
    url: "https://example.feishu.cn/sheets/shtcnEXAMPLE",
  },
  {
    kind: "bitable",
    path: "base",
    token: "bascnEXAMPLE",
    title: "Weekly summary (example)",
    url: "https://example.feishu.cn/base/bascnEXAMPLE",
  },
  {
    kind: "slides",
    path: "slides",
    token: "sldcnEXAMPLE",
    title: "Demo deck",
    url: "https://example.feishu.cn/slides/sldcnEXAMPLE",
  },
  {
    kind: "file",
    path: "file",
    token: "filecnEXAMPLE",
    title: "Notes (example).md",
    url: "https://example.feishu.cn/file/filecnEXAMPLE",
  },
] as const;

function metaOf(item: (typeof NEW_TYPES)[number], title: string = item.title): Record<string, unknown> {
  return { doc_token: item.token, doc_type: item.kind, title, url: item.url };
}

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
    expect(tool?.description).toContain("sheet");
    expect(tool?.description).toContain("bitable");
    expect(tool?.description).toContain("slides");
    expect(tool?.description).toContain("file");
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
        expect(toolText(response.body)).toBe(ONLY_TYPES);
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

  it("refuses folder, legacy doc, and mindnote URLs before any Feishu call", async () => {
    const { accessToken } = await login();
    const docs = [
      "https://example.feishu.cn/drive/folder/fldcn1",
      "https://example.feishu.cn/docs/doccnOLD",
      "https://example.feishu.cn/mindnotes/bmncnEXAMPLE",
    ];
    for (const doc of docs) {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "delete_doc", { doc, confirm_title: "Quarterly plan" });
      expect(fake.calls.slice(before)).toEqual([]);
      expect(toolText(response.body)).toBe(ONLY_TYPES);
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

  it("allows drive delete for docx, sheet, bitable, slides, and file, and rejects near-misses", () => {
    for (const type of ["docx", "sheet", "bitable", "slides", "file"]) {
      expect(isEndpointAllowed("DELETE", `https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=${type}`)).toBe(true);
    }
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=folder")).toBe(false);
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=doc")).toBe(false);
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=mindnote")).toBe(false);
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn")).toBe(false);
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=sheet&type=file")).toBe(false);
    expect(isEndpointAllowed("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn/extra?type=sheet")).toBe(false);
    expect(isEndpointAllowed("GET", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=sheet")).toBe(false);
    expect(isEndpointAllowed("DELETE", "https://open.larksuite.com/open-apis/drive/v1/files/doxcn?type=sheet")).toBe(false);
  });

  it("moves cloud-space sheet, bitable, slides, and file to the recycle bin when the title matches", async () => {
    const { accessToken } = await login();
    for (const item of NEW_TYPES) {
      const order: string[] = [];
      fake.extra = (method, url, body) => {
        if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
          expect(url.searchParams.get("token")).toBe(item.token);
          if (!url.searchParams.has("obj_type")) {
            order.push("get_node");
            return Response.json({ code: 131005, msg: "not found" });
          }
          order.push("get_node_obj");
          expect(url.searchParams.get("obj_type")).toBe(item.kind);
          return Response.json({ code: 131005, msg: "document is not in wiki" });
        }
        if (method === "POST" && url.pathname === "/open-apis/drive/v1/metas/batch_query") {
          order.push("metas");
          expect(JSON.parse(body)).toEqual({
            request_docs: [{ doc_token: item.token, doc_type: item.kind }],
            with_url: true,
          });
          return Response.json({ code: 0, data: { metas: [metaOf(item)] } });
        }
        if (method === "DELETE" && url.pathname === `/open-apis/drive/v1/files/${item.token}`) {
          order.push("delete");
          expect(url.searchParams.get("type")).toBe(item.kind);
          return Response.json({ code: 0, data: {} });
        }
        return undefined;
      };
      const before = fake.calls.length;
      const response = await callTool(accessToken, "delete_doc", { doc: item.url, confirm_title: item.title });
      const sent = fake.calls.slice(before);
      const deletes = sent.filter((call) => call.method === "DELETE");
      expect(order).toEqual(["get_node", "get_node_obj", "metas", "delete"]);
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.url).toBe(`https://open.feishu.cn/open-apis/drive/v1/files/${item.token}?type=${item.kind}`);
      expect(sent.some((call) => call.url.includes("/docx/v1/documents/"))).toBe(false);
      expect(sent.map((call) => call.url)).toContain(META_URL);
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
      expect(toolText(response.body)).toBe("Moved to 云空间 回收站. It can be restored there.");
    }
  });

  it("refuses a bare wiki sheet token on the docx path without deleting", async () => {
    const sheet = NEW_TYPES[0];
    const { accessToken } = await login();
    const order: string[] = [];
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        expect(url.searchParams.get("token")).toBe(sheet.token);
        if (!url.searchParams.has("obj_type")) {
          order.push("get_node");
          return Response.json({ code: 131005, msg: "document is not in wiki" });
        }
        order.push("get_node_docx");
        expect(url.searchParams.get("obj_type")).toBe("docx");
        return Response.json({ code: 131005, msg: "document is not in wiki" });
      }
      if (method === "GET" && url.pathname === `/open-apis/docx/v1/documents/${sheet.token}`) {
        order.push("document");
        return Response.json({ code: 1770002, msg: "not found" });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "delete_doc", { doc: sheet.token, confirm_title: sheet.title });
    const sent = fake.calls.slice(before);
    expect(order).toEqual(["get_node", "get_node_docx", "document"]);
    expect(sent.some((call) => call.method === "DELETE")).toBe(false);
    expect(sent.some((call) => call.url.includes("/drive/v1/metas/"))).toBe(false);
    expect(toolText(response.body)).toBe("Document not found or no access.");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("refuses a wrong title for sheet, bitable, slides, and file without deleting", async () => {
    const { accessToken } = await login();
    for (const item of NEW_TYPES) {
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
          return Response.json({ code: 131005, msg: "document is not in wiki" });
        }
        if (method === "POST" && url.pathname === "/open-apis/drive/v1/metas/batch_query") {
          return Response.json({ code: 0, data: { metas: [metaOf(item)] } });
        }
        return undefined;
      };
      const before = fake.calls.length;
      const response = await callTool(accessToken, "delete_doc", { doc: item.url, confirm_title: "Wrong title" });
      const sent = fake.calls.slice(before);
      expect(sent.some((call) => call.method === "DELETE")).toBe(false);
      expect(sent.some((call) => call.url === META_URL)).toBe(true);
      expect(toolText(response.body)).toBe("Title does not match. Delete refused.");
      expect(toolText(response.body)).not.toContain(item.title);
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    }
  });

  it("refuses a missing or blank live title for sheet, bitable, slides, and file", async () => {
    const { accessToken } = await login();
    const titles: Array<string | undefined | null> = [undefined, "", "   ", null];
    for (const item of NEW_TYPES) {
      for (const title of titles) {
        for (const confirm_title of ["", "   ", item.title]) {
          fake.extra = (method, url) => {
            if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
              return Response.json({ code: 131005, msg: "document is not in wiki" });
            }
            if (method === "POST" && url.pathname === "/open-apis/drive/v1/metas/batch_query") {
              const meta = title === undefined ? { doc_token: item.token, doc_type: item.kind, url: item.url } : metaOf(item, title as string);
              return Response.json({ code: 0, data: { metas: [meta] } });
            }
            return undefined;
          };
          const before = fake.calls.length;
          const response = await callTool(accessToken, "delete_doc", { doc: item.url, confirm_title });
          expect(fake.calls.slice(before).some((call) => call.method === "DELETE")).toBe(false);
          expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
          expect(toolText(response.body)).toBe("Title does not match. Delete refused.");
        }
      }
    }
  });

  it("refuses wiki URLs of each new type before any Feishu call", async () => {
    const { accessToken } = await login();
    for (const item of NEW_TYPES) {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "delete_doc", {
        doc: `https://example.feishu.cn/wiki/wikcn${item.kind}`,
        confirm_title: item.title,
      });
      expect(fake.calls.slice(before)).toEqual([]);
      expect(toolText(response.body)).toBe("This doc lives in a wiki space; not deletable here.");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    }
  });

  it("refuses wiki-hosted sheet, bitable, slides, and file before DELETE", async () => {
    const { accessToken } = await login();
    for (const item of NEW_TYPES) {
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
          if (!url.searchParams.has("obj_type")) return Response.json({ code: 131005, msg: "not found" });
          expect(url.searchParams.get("obj_type")).toBe(item.kind);
          return Response.json({
            code: 0,
            data: { node: { obj_token: item.token, obj_type: item.kind, node_token: `wikcn${item.kind}` } },
          });
        }
        return undefined;
      };
      const before = fake.calls.length;
      const response = await callTool(accessToken, "delete_doc", { doc: item.url, confirm_title: item.title });
      const sent = fake.calls.slice(before);
      expect(sent.some((call) => call.method === "DELETE")).toBe(false);
      expect(sent.some((call) => call.url.includes("/drive/v1/metas/"))).toBe(false);
      expect(toolText(response.body)).toBe("This doc lives in a wiki space; not deletable here.");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    }
  });

  it("passes 99991679 with a re-authorize hint and audits delete_doc", async () => {
    const logs = logLines();
    const sheet = NEW_TYPES[0];
    try {
      const { accessToken } = await login();
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
          return Response.json({ code: 131005, msg: "document is not in wiki" });
        }
        if (method === "POST" && url.pathname === "/open-apis/drive/v1/metas/batch_query") {
          return Response.json({ code: 99991679, msg: "unauthorized: missing scope drive:drive.metadata:readonly" });
        }
        return undefined;
      };
      const response = await callTool(accessToken, "delete_doc", { doc: sheet.url, confirm_title: sheet.title });
      const text = toolText(response.body);
      expect(text).toContain("99991679");
      expect(text).toContain("re-authorize the connector to grant new scopes");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
      const audited = logs.lines().filter((line) => line.includes('"event":"tool_call"') && line.includes('"tool":"delete_doc"'));
      expect(audited).toHaveLength(1);
      expect(audited[0]).toContain('"code":"99991679"');
    } finally {
      logs.restore();
    }
  });

  it("sends sheet delete to open.larksuite.com when FEISHU_REGION is lark", async () => {
    env.FEISHU_REGION = "lark";
    const sheet = NEW_TYPES[0];
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131005, msg: "document is not in wiki" });
      }
      if (method === "POST" && url.pathname === "/open-apis/drive/v1/metas/batch_query") {
        return Response.json({ code: 0, data: { metas: [metaOf(sheet)] } });
      }
      if (method === "DELETE" && url.pathname === `/open-apis/drive/v1/files/${sheet.token}`) {
        expect(url.searchParams.get("type")).toBe("sheet");
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "delete_doc", { doc: sheet.url, confirm_title: sheet.title });
    expect(toolText(response.body)).toBe("Moved to 云空间 回收站. It can be restored there.");
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url === "https://open.larksuite.com/open-apis/drive/v1/metas/batch_query")).toBe(true);
    expect(outbound.some((url) => url === `https://open.larksuite.com/open-apis/drive/v1/files/${sheet.token}?type=sheet`)).toBe(true);
    expect(outbound.every((url) => !url.includes("feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("DELETE", `https://open.feishu.cn/open-apis/drive/v1/files/${sheet.token}?type=sheet`)).toBe(true);
    expect(isEndpointAllowed("DELETE", `https://open.larksuite.com/open-apis/drive/v1/files/${sheet.token}?type=sheet`)).toBe(false);
  });
});

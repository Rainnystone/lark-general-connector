import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import { bytesToStandardBase64 } from "../src/feishu/media";
import { FILE_INLINE_MAX } from "../src/mcp/doc-file";
import { OUTPUT_LIMIT } from "../src/mcp/tools";
import driveMetas from "./fixtures/doc-types/drive-metas-batch-query.json" with { type: "json" };
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const FILE_TOKEN = "filecnEXAMPLE";
const FILE_TITLE = "Notes (example).md";
const DOWNLOAD_TEXT = "# Notes (example)\n\nExample file body.\n";
const META_URL = "https://open.feishu.cn/open-apis/drive/v1/metas/batch_query";
const DOWNLOAD_PATH = `/open-apis/drive/v1/files/${FILE_TOKEN}/download`;
const DOWNLOAD_URL = `https://open.feishu.cn${DOWNLOAD_PATH}`;
const META_DATA = { metas: driveMetas };
const META_BODY = {
  request_docs: [{ doc_token: FILE_TOKEN, doc_type: "file" }],
  with_url: true,
};

function downloadBytes(): Uint8Array {
  return new TextEncoder().encode(DOWNLOAD_TEXT);
}

describe("read_file", () => {
  it("is read-only and says files are raw bytes with a 256 KiB cap", async () => {
    const { accessToken } = await login();
    const tool = (await listTools(accessToken)).find((entry) => entry.name === "read_file");
    const annotations = tool?.annotations as { readOnlyHint?: boolean };
    expect(annotations.readOnlyHint).toBe(true);
    expect(String(tool?.description)).toContain("raw bytes");
    expect(String(tool?.description)).toContain("256 KiB");
    expect(String(tool?.description)).toContain("too_large");
    expect(FILE_INLINE_MAX).toBe(256 * 1024);
  });

  it("allows the two file-read endpoints and rejects near-misses", () => {
    expect(isEndpointAllowed("POST", META_URL)).toBe(true);
    expect(isEndpointAllowed("GET", DOWNLOAD_URL)).toBe(true);
    expect(isEndpointAllowed("GET", META_URL)).toBe(false);
    expect(isEndpointAllowed("POST", `${META_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("POST", DOWNLOAD_URL)).toBe(false);
    expect(isEndpointAllowed("GET", `${DOWNLOAD_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn/open-apis/drive/v1/files/${FILE_TOKEN}`)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.larksuite.com${DOWNLOAD_PATH}`)).toBe(false);
    expect(isEndpointAllowed("POST", "https://open.larksuite.com/open-apis/drive/v1/metas/batch_query")).toBe(false);
  });

  it("resolves a wiki URL, a file URL, and a file token, and returns fixture meta", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: FILE_TOKEN, obj_type: "file", space_id: "spcW", node_token: "wikcnFILE" } },
        });
      }
      if (method === "POST" && url.pathname === "/open-apis/drive/v1/metas/batch_query") {
        return Response.json({ code: 0, data: META_DATA });
      }
      return undefined;
    };
    const wiki = toolText(
      (await callTool(accessToken, "read_file", { doc: "https://example.feishu.cn/wiki/wikcnFILE", action: "meta" })).body,
    );
    expect(wiki).toContain(FILE_TITLE);
    expect(JSON.parse(wiki)).toEqual(META_DATA);

    fake.extra = (method, url, body) => {
      if (method === "POST" && url.pathname === "/open-apis/drive/v1/metas/batch_query") {
        expect(JSON.parse(body)).toEqual(META_BODY);
        return Response.json({ code: 0, data: META_DATA });
      }
      return undefined;
    };
    const beforeUrl = fake.calls.length;
    const fromUrl = await callTool(accessToken, "read_file", {
      doc: `https://example.feishu.cn/file/${FILE_TOKEN}`,
      action: "meta",
    });
    expect(JSON.parse(toolText(fromUrl.body))).toEqual(META_DATA);
    expect(fake.calls.slice(beforeUrl).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(false);
    expect(fake.calls.slice(beforeUrl).map((call) => call.url)).toContain(META_URL);

    const beforeToken = fake.calls.length;
    const fromToken = await callTool(accessToken, "read_file", { doc: FILE_TOKEN, action: "meta" });
    expect(toolText(fromToken.body)).toContain('"doc_type":"file"');
    expect(fake.calls.slice(beforeToken).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(true);
  });

  it("returns fixture bytes as content_base64 and UTF-8 text under the cap", async () => {
    const { accessToken } = await login();
    const bytes = downloadBytes();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === DOWNLOAD_PATH) {
        return new Response(bytes, {
          headers: {
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(FILE_TITLE)}`,
            "content-length": String(bytes.byteLength),
          },
        });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "read_file", { doc: FILE_TOKEN, action: "download" });
    expect(fake.calls.slice(before).map((call) => call.url)).toContain(DOWNLOAD_URL);
    const parsed = JSON.parse(toolText(response.body)) as Record<string, unknown>;
    expect(parsed.size).toBe(bytes.byteLength);
    expect(parsed.content_base64).toBe(bytesToStandardBase64(bytes));
    expect(parsed.text).toBe(DOWNLOAD_TEXT);
    expect(parsed.too_large).toBeUndefined();
  });

  it("treats a Content-Length equal to 256 KiB as in-cap and inlines the body", async () => {
    const { accessToken } = await login();
    const bytes = downloadBytes();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === DOWNLOAD_PATH) {
        return new Response(bytes, {
          headers: {
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(FILE_TITLE)}`,
            "content-length": String(FILE_INLINE_MAX),
          },
        });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "read_file", {
      doc: `https://example.feishu.cn/file/${FILE_TOKEN}`,
      action: "download",
    });
    const parsed = JSON.parse(toolText(response.body)) as Record<string, unknown>;
    expect(parsed.too_large).toBeUndefined();
    expect(parsed.size).toBe(bytes.byteLength);
    expect(parsed.content_base64).toBe(bytesToStandardBase64(bytes));
    expect(parsed.text).toBe(DOWNLOAD_TEXT);
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("returns too_large and stops reading when a chunked download crosses 256 KiB without Content-Length", async () => {
    const { accessToken } = await login();
    let extra = 0;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === DOWNLOAD_PATH) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(FILE_INLINE_MAX));
            controller.enqueue(new Uint8Array(1));
          },
          pull(controller) {
            extra += 1;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
        });
        return new Response(stream);
      }
      return undefined;
    };
    const response = await callTool(accessToken, "read_file", {
      doc: `https://example.feishu.cn/file/${FILE_TOKEN}`,
      action: "download",
    });
    const parsed = JSON.parse(toolText(response.body)) as Record<string, unknown>;
    expect(parsed.too_large).toBe(true);
    expect(parsed.size).toBeUndefined();
    expect(parsed.content_base64).toBeUndefined();
    expect(parsed.text).toBeUndefined();
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
    expect(extra).toBe(0);
  });

  it("returns too_large from Content-Length one byte over 256 KiB without buffering the body", async () => {
    const { accessToken } = await login();
    const declared = FILE_INLINE_MAX + 1;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === DOWNLOAD_PATH) {
        return new Response("tiny", {
          headers: { "content-length": String(declared) },
        });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "read_file", {
      doc: `https://example.feishu.cn/file/${FILE_TOKEN}`,
      action: "download",
    });
    const parsed = JSON.parse(toolText(response.body)) as Record<string, unknown>;
    expect(parsed.too_large).toBe(true);
    expect(parsed.size).toBe(declared);
    expect(parsed.content_base64).toBeUndefined();
    expect(parsed.text).toBeUndefined();
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("returns HTTP 200 application/json as file bytes, not an OpenAPI error", async () => {
    const { accessToken } = await login();
    const body = '{"hello":"world"}';
    const bytes = new TextEncoder().encode(body);
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === DOWNLOAD_PATH) {
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-disposition": "attachment; filename*=UTF-8''note.json",
            "content-length": String(bytes.byteLength),
          },
        });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "read_file", { doc: FILE_TOKEN, action: "download" });
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
    const parsed = JSON.parse(toolText(response.body)) as Record<string, unknown>;
    expect(parsed.content_base64).toBe(bytesToStandardBase64(bytes));
    expect(parsed.text).toBe(body);
    expect(parsed.too_large).toBeUndefined();
  });

  it("returns too_large instead of truncating a file whose inline JSON would exceed the tool output cap", async () => {
    const { accessToken } = await login();
    const bytes = new Uint8Array(80 * 1024);
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === DOWNLOAD_PATH) {
        return new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.byteLength),
          },
        });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "read_file", { doc: FILE_TOKEN, action: "download" });
    const text = toolText(response.body);
    expect(text.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    expect(text).not.toContain("[truncated; ask for the next page]");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.too_large).toBe(true);
    expect(parsed.size).toBe(bytes.byteLength);
    expect(parsed.content_base64).toBeUndefined();
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("names the right tool on a non-file wiki node", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: "doxcnOBJ", obj_type: "docx", space_id: "spcW", node_token: "wikcnDOC" } },
        });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "read_file", { doc: "https://example.feishu.cn/wiki/wikcnDOC", action: "meta" });
    expect(toolText(response.body)).toBe("this is a docx; use fetch_doc");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.slice(before).some((call) => call.url.includes("/drive/v1/metas/") || call.url.includes("/download"))).toBe(false);
  });

  it("passes 99991679 with a re-authorize hint and audits read_file", async () => {
    const logs = logLines();
    try {
      const { accessToken } = await login();
      fake.extra = (method, url) => {
        if (method === "POST" && url.pathname === "/open-apis/drive/v1/metas/batch_query") {
          return Response.json({ code: 99991679, msg: "unauthorized: missing scope drive:file:download" });
        }
        return undefined;
      };
      const response = await callTool(accessToken, "read_file", { doc: FILE_TOKEN, action: "meta" });
      const text = toolText(response.body);
      expect(text).toContain("99991679");
      expect(text).toContain("re-authorize the connector to grant new scopes");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      const audited = logs.lines().filter((line) => line.includes('"event":"tool_call"') && line.includes('"tool":"read_file"'));
      expect(audited).toHaveLength(1);
      expect(audited[0]).toContain('"code":"99991679"');
    } finally {
      logs.restore();
    }
  });

  it("sends file reads to open.larksuite.com when FEISHU_REGION is lark", async () => {
    env.FEISHU_REGION = "lark";
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === "/open-apis/drive/v1/metas/batch_query") {
        return Response.json({ code: 0, data: META_DATA });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "read_file", {
      doc: `https://example.feishu.cn/file/${FILE_TOKEN}`,
      action: "meta",
    });
    expect(JSON.parse(toolText(response.body))).toEqual(META_DATA);
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url === "https://open.larksuite.com/open-apis/drive/v1/metas/batch_query")).toBe(true);
    expect(outbound.every((url) => !url.includes("feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("POST", META_URL)).toBe(true);
    expect(isEndpointAllowed("POST", "https://open.larksuite.com/open-apis/drive/v1/metas/batch_query")).toBe(false);
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { FeishuClient } from "../src/feishu/client";
import { MCP_MEDIA_CHAR_LIMIT } from "../src/feishu/media";
import { resolveOpenIdNames } from "../src/feishu/users";
import { MARKER } from "./fake-feishu";
import { capturedTool } from "./mcp-schema";
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const CATALOGUE = [
  { name: "get_user", title: "Look up a colleague" },
  { name: "search_users", title: "Search colleagues" },
  { name: "fetch_doc_media", title: "Fetch doc image/whiteboard" },
] as const;

const PNG_PREFIX = "iVBORw0KGgoA";
const MEDIA_CAP = 1024 * 1024;

describe("contact and media tools", () => {
  it("lists the three tools as read-only", async () => {
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
    expect(Object.keys(schemaOf("get_user").properties ?? {})).toEqual(["user_id", "id_type"]);
    expect(schemaOf("get_user").required).toEqual(["user_id"]);
    expect(Object.keys(schemaOf("search_users").properties ?? {})).toEqual(["query", "page_token"]);
    expect(schemaOf("search_users").required).toEqual(["query"]);
    expect(Object.keys(schemaOf("fetch_doc_media").properties ?? {})).toEqual(["doc", "media_token", "whiteboard_id"]);
    expect(schemaOf("fetch_doc_media").required).toBeUndefined();
  });

  it("describes get_user as name, English name and avatar", async () => {
    const { accessToken } = await login();
    const tools = await listTools(accessToken);
    const tool = tools.find((entry) => entry.name === "get_user");
    expect(tool?.description).toBe("Look up a colleague by id. Returns name, English name and avatar.");
  });

  it("calls each Feishu MCP tool once with that tool allowed", async () => {
    expect(capturedTool("fetch-file").inputSchema.required).toEqual(["resource_token"]);
    expect(capturedTool("get-user").inputSchema.properties).toHaveProperty("open_id");
    expect(capturedTool("get-user").inputSchema.properties).not.toHaveProperty("user_id");
    const { accessToken } = await login();
    const cases = [
      {
        name: "get_user",
        args: { user_id: "ou_ada" },
        feishuTool: "get-user",
        text: "ada-profile",
        arguments: { open_id: "ou_ada" },
      },
      {
        name: "search_users",
        args: { query: "Ada", page_token: "20" },
        feishuTool: "search-user",
        text: "ada-hit",
        arguments: { query: "Ada", page_token: "20" },
      },
      {
        name: "fetch_doc_media",
        args: { doc: "doxcnDOC", media_token: "boxcnIMG" },
        feishuTool: "fetch-file",
        text: "image-note",
        arguments: { resource_token: "boxcnIMG", type: "media" },
      },
      {
        name: "fetch_doc_media",
        args: { whiteboard_id: "wbcnBOARD" },
        feishuTool: "fetch-file",
        text: "board-nodes",
        arguments: { resource_token: "wbcnBOARD", type: "whiteboard" },
      },
    ] as const;

    for (const item of cases) {
      const before = fake.calls.length;
      fake.extra = (_method, url, body) => {
        if (url.pathname !== "/mcp") return undefined;
        const payload = JSON.parse(body) as { method?: string };
        if (payload.method !== "tools/call") return undefined;
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: item.text }] } });
      };
      const response = await callTool(accessToken, item.name, item.args);
      const sent = fake.calls.slice(before).filter((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"));
      expect(sent).toHaveLength(1);
      expect(fake.calls.slice(before).some((call) => call.url.includes("open.feishu.cn/open-apis/contact") || call.url.includes("/medias/") || call.url.includes("/whiteboards/"))).toBe(false);
      expect(sent[0]?.headers["x-lark-mcp-uat"]).toBe("u-access-1");
      expect(sent[0]?.headers["x-lark-mcp-allowed-tools"]).toBe(item.feishuTool);
      expect(sent[0]?.headers["content-type"]).toContain("application/json");
      const payload = JSON.parse(sent[0]?.body ?? "{}") as { method?: string; params?: { name?: string; arguments?: unknown } };
      expect(payload.method).toBe("tools/call");
      expect(payload.params?.name).toBe(item.feishuTool);
      expect(payload.params?.arguments).toEqual(item.arguments);
      expect(toolText(response.body)).toBe(item.text);
      const result = response.body as { result?: { isError?: boolean } };
      expect(result.result?.isError).not.toBe(true);
    }
  });

  it("returns a small MCP image and drops an oversized MCP image body", async () => {
    const { accessToken } = await login();
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
      });
    };
    const small = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcnSMALL" });
    const smallBlock = contentBlock(small.body, 0);
    expect(smallBlock.type).toBe("image");
    expect(smallBlock.data).toBe("iVBORw0KGgo=");
    expect(smallBlock.mimeType).toBe("image/png");

    const oversized = "A".repeat(2_000_000);
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "image", data: oversized, mimeType: "image/png" }] },
      });
    };
    const large = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcnHUGE" });
    expect(large.raw.length).toBeLessThan(2_000);
    expect(large.raw).not.toContain(oversized.slice(0, 80));
    expect(toolText(large.body)).toContain("type: image/png");
    expect(toolText(large.body)).toContain("size: 1500000");
    expect(toolText(large.body)).toContain("image exceeds 1 MB");
    expect(contentBlock(large.body, 0).type).toBe("text");
  });

  it("returns a large MCP whiteboard as capped text", async () => {
    const { accessToken } = await login();
    const body = `whiteboard-start:${"a".repeat(1_600_000)}`;
    fake.extra = (_method, url, requestBody) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(requestBody) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: body }] },
      });
    };
    const response = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", whiteboard_id: "wbcnTEXT" });
    const text = toolText(response.body);
    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(text).toContain("whiteboard-start:");
    expect(text).toContain("[truncated; ask for the next page]");
    expect(text).not.toContain("image exceeds 1 MB");
    expect(contentBlock(response.body, 0).type).toBe("text");
  });

  it("uses only that tool's OpenAPI endpoint when the backend is openapi", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (url.pathname === "/mcp") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "mcp-pass" }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/ou_ada") {
        return Response.json({
          code: 0,
          data: {
            user: {
              open_id: "ou_ada",
              user_id: "emp_secret",
              name: "Ada",
              en_name: "Ada Lovelace",
              email: "ada@example.com",
              mobile: "+8613800000000",
              avatar: { avatar_72: "https://cdn.example/ada-72.png", avatar_origin: "https://cdn.example/ada-origin.png" },
              department_path: [{ department_name: { name: "Engineering" } }],
            },
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/search/v1/user") {
        return Response.json({
          code: 0,
          data: {
            has_more: true,
            page_token: "20",
            users: [
              {
                name: "Ada",
                open_id: "ou_ada",
                user_id: "emp_secret",
                email: "ada@example.com",
                avatar: { avatar_origin: "https://cdn.example/ada-origin.png" },
              },
            ],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/drive/v1/medias/boxcnIMG/download") {
        return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
          headers: { "content-type": "image/png", "content-length": "8" },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/board/v1/whiteboards/wbcnBOARD/nodes") {
        return Response.json({ code: 0, data: { nodes: [{ type: "text_shape", text: "Start" }] } });
      }
      return undefined;
    };

    const cases = [
      {
        tool: "get_user",
        args: { user_id: "ou_ada", id_type: "open_id" },
        other: "search_users",
        otherArgs: { query: "Ada" },
        matches: (call: { method: string; url: string }) => call.method === "GET" && new URL(call.url).pathname === "/open-apis/contact/v3/users/ou_ada" && new URL(call.url).searchParams.get("user_id_type") === "open_id",
        assert: (text: string) => {
          expect(text).toContain("name: Ada");
          expect(text).toContain("en_name: Ada Lovelace");
          expect(text).toContain("departments: Engineering");
          expect(text).toContain("avatar: https://cdn.example/ada-origin.png");
          expect(text).not.toContain("open_id:");
          expect(text).not.toContain("ou_ada");
          expect(text).not.toContain("ada@example.com");
          expect(text).not.toContain("+8613800000000");
          expect(text).not.toContain("emp_secret");
        },
      },
      {
        tool: "search_users",
        args: { query: "Ada", page_token: "20" },
        other: "get_user",
        otherArgs: { user_id: "ou_ada" },
        matches: (call: { method: string; url: string }) => {
          if (call.method !== "GET") return false;
          const parsed = new URL(call.url);
          return parsed.pathname === "/open-apis/search/v1/user" && parsed.searchParams.get("query") === "Ada" && parsed.searchParams.get("page_token") === "20" && !parsed.searchParams.has("page_size");
        },
        assert: (text: string) => {
          expect(text).toContain("name: Ada");
          expect(text).toContain("open_id: ou_ada");
          expect(text).toContain("avatar: https://cdn.example/ada-origin.png");
          expect(text).toContain("page cap reached");
          expect(text).toContain("page_token: 20");
          expect(text).not.toContain("ada@example.com");
          expect(text).not.toContain("emp_secret");
        },
      },
      {
        tool: "fetch_doc_media",
        args: { doc: "doxcnDOC", media_token: "boxcnIMG" },
        other: "get_user",
        otherArgs: { user_id: "ou_ada" },
        matches: (call: { method: string; url: string }) => call.method === "GET" && new URL(call.url).pathname === "/open-apis/drive/v1/medias/boxcnIMG/download",
        assert: (_text: string, body: unknown) => {
          const block = contentBlock(body, 0);
          expect(block.type).toBe("image");
          expect(block.mimeType).toBe("image/png");
          expect(block.data).toBe("iVBORw0KGgo=");
        },
      },
      {
        tool: "fetch_doc_media",
        args: { doc: "doxcnDOC", whiteboard_id: "wbcnBOARD" },
        other: "get_user",
        otherArgs: { user_id: "ou_ada" },
        matches: (call: { method: string; url: string }) => call.method === "GET" && new URL(call.url).pathname === "/open-apis/board/v1/whiteboards/wbcnBOARD/nodes",
        assert: (text: string) => {
          expect(text).toContain("text_shape");
          expect(text).toContain("Start");
        },
      },
    ] as const;

    for (const item of cases) {
      env.TOOL_BACKENDS = JSON.stringify({ [item.tool]: "openapi" });
      const before = fake.calls.length;
      const response = await callTool(accessToken, item.tool, item.args);
      const sent = fake.calls.slice(before);
      expect(sent.some((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"))).toBe(false);
      const hits = sent.filter((call) => item.matches(call));
      expect(hits).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(hits[0]?.headers.authorization).toBe("Bearer u-access-1");
      item.assert(toolText(response.body), response.body);

      const otherBefore = fake.calls.length;
      const other = await callTool(accessToken, item.other, item.otherArgs);
      const otherSent = fake.calls.slice(otherBefore).filter((call) => call.url.startsWith("https://mcp.feishu.cn/mcp"));
      expect(otherSent).toHaveLength(1);
      expect(toolText(other.body)).toBe("mcp-pass");
    }
  });

  it("rejects a non-2xx media download instead of returning it as an image", async () => {
    const { accessToken } = await login();
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc_media: "openapi" });
    fake.extra = (method, url) => {
      if (method !== "GET") return undefined;
      if (url.pathname === "/open-apis/drive/v1/medias/boxcn500/download") {
        return new Response("upstream down", { status: 500, headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/open-apis/drive/v1/medias/boxcn404/download") {
        return new Response(pngBytes(32), { status: 404, headers: { "content-type": "image/png" } });
      }
      return undefined;
    };
    const failed = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcn500" });
    expect(toolText(failed.body)).toBe("Feishu request failed");
    expect(toolText(failed.body)).not.toContain("type:");
    expect((failed.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    const missing = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcn404" });
    expect(toolText(missing.body)).toBe("Feishu request failed");
    expect(contentBlock(missing.body, 0).type).toBe("text");
    expect((missing.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("rejects a non-2xx JSON media download even when the business code is 0", async () => {
    const { accessToken } = await login();
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc_media: "openapi" });
    fake.extra = (method, url) => {
      if (method !== "GET") return undefined;
      if (url.pathname === "/open-apis/drive/v1/medias/boxcnjson/download") {
        return Response.json({ code: 0, msg: "ok" }, { status: 500 });
      }
      if (url.pathname === "/open-apis/drive/v1/medias/boxcnplus/download") {
        return new Response(JSON.stringify({ code: 0, msg: "ok" }), {
          status: 400,
          headers: { "content-type": "application/problem+json" },
        });
      }
      if (url.pathname === "/open-apis/drive/v1/medias/boxcnok/download") {
        return Response.json({ code: 0, data: {} });
      }
      return undefined;
    };
    const json = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcnjson" });
    expect(toolText(json.body)).toBe("Feishu request failed");
    expect(contentBlock(json.body, 0).type).toBe("text");
    expect((json.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    const plus = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcnplus" });
    expect(toolText(plus.body)).toBe("Feishu request failed");
    expect((plus.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    const ok = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcnok" });
    expect(toolText(ok.body)).toBe("");
    expect((ok.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("returns image content at 900 KB and metadata without the body at 2 MB", async () => {
    const { accessToken } = await login();
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc_media: "openapi" });
    const small = pngBytes(900 * 1024);
    const large = pngBytes(2 * 1024 * 1024);
    fake.extra = (method, url) => {
      if (method !== "GET") return undefined;
      if (url.pathname === "/open-apis/drive/v1/medias/boxcn900/download") return imageResponse(small);
      if (url.pathname === "/open-apis/drive/v1/medias/boxcn2mb/download") return imageResponse(large);
      return undefined;
    };

    const fitted = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcn900" });
    const fittedBlock = contentBlock(fitted.body, 0);
    expect(fittedBlock.type).toBe("image");
    expect(fittedBlock.mimeType).toBe("image/png");
    expect(fittedBlock.data).toMatch(new RegExp(`^${PNG_PREFIX}`));
    expect(String(fittedBlock.data).length).toBe(1_228_800);

    const oversized = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcn2mb" });
    expect(oversized.raw.length).toBeLessThan(2_000);
    expect(oversized.raw).not.toContain(PNG_PREFIX);
    expect(contentBlock(oversized.body, 0).type).toBe("text");
    const note = toolText(oversized.body);
    expect(note).toContain("type: image/png");
    expect(note).toContain("size: 2097152");
    expect(note).toContain("image exceeds 1 MB");
    expect(small.byteLength).toBeLessThanOrEqual(MEDIA_CAP);
    expect(large.byteLength).toBeGreaterThan(MEDIA_CAP);
  });

  it("caps whiteboard JSON at 100,000 characters", async () => {
    const { accessToken } = await login();
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc_media: "openapi" });
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/board/v1/whiteboards/wbcnHUGE/nodes") return undefined;
      return Response.json({ code: 0, data: { nodes: [{ type: "text_shape", text: "a".repeat(150_000) }] } });
    };
    const response = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", whiteboard_id: "wbcnHUGE" });
    const text = toolText(response.body);
    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(text).toContain("text_shape");
    expect(text).toContain("[truncated; ask for the next page]");
    expect(text).not.toContain("a".repeat(100_000));
  });

  it("does not turn a truncated Feishu MCP error into image metadata", async () => {
    const { accessToken } = await login();
    const secret = "img_v3_SECRETTOKEN";
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32011, message: `${secret}${"e".repeat(MCP_MEDIA_CHAR_LIMIT)}` },
      });
    };
    const response = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcnERR" });
    const text = toolText(response.body);
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(text).toBe("Feishu request failed");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("image exceeds");
  });

  it("reports a truncated Feishu error instead of the partial body", async () => {
    const { accessToken } = await login();
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc_media: "openapi" });
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/board/v1/whiteboards/wbcnERR/nodes") return undefined;
      return Response.json({ code: 99991663, msg: "x".repeat(250_000) });
    };
    const response = await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", whiteboard_id: "wbcnERR" });
    expect(toolText(response.body)).toBe("Feishu request failed");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("resolves three open ids in one batch and keeps the ids when Feishu fails", async () => {
    const ids = ["ou_a", "ou_b", "ou_c"];
    const fetchImpl = vi.fn(async () =>
      Response.json({
        code: 0,
        data: {
          items: [
            { open_id: "ou_c", name: "Cy" },
            { open_id: "ou_a", name: "Ann" },
            { open_id: "ou_b", name: "Ben" },
          ],
        },
      }),
    );
    const client = new FeishuClient({ fetchImpl });
    await expect(resolveOpenIdNames(client, "u-test", ids)).resolves.toEqual(["Ann", "Ben", "Cy"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = calledUrl(fetchImpl.mock.calls, 0);
    expect(url.pathname).toBe("/open-apis/contact/v3/users/batch");
    expect(url.searchParams.get("user_id_type")).toBe("open_id");
    expect(url.searchParams.getAll("user_ids")).toEqual(ids);

    const failing = vi.fn(async () => Response.json({ code: 999, msg: "no permission" }));
    const failedClient = new FeishuClient({ fetchImpl: failing });
    await expect(resolveOpenIdNames(failedClient, "u-test", ids)).resolves.toEqual(ids);
    expect(failing).toHaveBeenCalledTimes(1);

    const thrown = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(resolveOpenIdNames(new FeishuClient({ fetchImpl: thrown }), "u-test", ids)).resolves.toEqual(ids);

    const many = Array.from({ length: 51 }, (_value, index) => `ou_${index}`);
    const paged = vi.fn(async () => Response.json({ code: 0, data: { items: [] } }));
    await resolveOpenIdNames(new FeishuClient({ fetchImpl: paged }), "u-test", many);
    expect(paged).toHaveBeenCalledTimes(2);
    expect(calledUrl(paged.mock.calls, 0).searchParams.getAll("user_ids")).toHaveLength(50);
    expect(calledUrl(paged.mock.calls, 1).searchParams.getAll("user_ids")).toEqual(["ou_50"]);

    for (const code of [99991663, 99991668, 99991677]) {
      const dead = vi.fn(async () => Response.json({ code, msg: "invalid" }));
      await expect(resolveOpenIdNames(new FeishuClient({ fetchImpl: dead }), "u-test", many)).resolves.toEqual(many);
      expect(dead).toHaveBeenCalledTimes(1);
    }
  });

  it("audits the user id or media token and never logs the search query", async () => {
    const logs = logLines();
    const { accessToken } = await login();
    fake.extra = (_method, url, body) => {
      if (url.pathname !== "/mcp") return undefined;
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method !== "tools/call") return undefined;
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: MARKER }] } });
    };
    await callTool(accessToken, "search_users", { query: MARKER });
    await callTool(accessToken, "get_user", { user_id: "ou_colleague" });
    await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", media_token: "boxcnMEDIA" });
    await callTool(accessToken, "fetch_doc_media", { doc: "doxcnDOC", whiteboard_id: "wbcnBOARD" });
    const joined = logs.lines().join("\n");
    expect(joined).not.toContain(MARKER);
    expect(joined).toContain('"tool":"search_users"');
    expect(joined).toContain('"target":null');
    expect(joined).toContain('"target":"ou_colleague"');
    expect(joined).toContain('"target":"boxcnMEDIA"');
    expect(joined).toContain('"target":"wbcnBOARD"');
    logs.restore();
  });
});

function calledUrl(calls: readonly unknown[], index: number): URL {
  const call = calls[index];
  if (!Array.isArray(call)) throw new Error(`missing fetch call ${index}`);
  return new URL(String(call[0]));
}

function contentBlock(body: unknown, index: number): Record<string, unknown> {
  const result = typeof body === "object" && body !== null ? (body as { result?: { content?: unknown } }).result : undefined;
  const content = Array.isArray(result?.content) ? result.content : [];
  const block = content[index];
  return typeof block === "object" && block !== null ? (block as Record<string, unknown>) : {};
}

function pngBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function imageResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
  });
}


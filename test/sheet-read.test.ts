import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import sheetsQuery from "./fixtures/doc-types/sheet-v3-sheets-query.json" with { type: "json" };
import sheetValues from "./fixtures/doc-types/sheet-v2-values-get.json" with { type: "json" };
import { OUTPUT_LIMIT } from "../src/mcp/tools";
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const SHEET_TOKEN = "shtcnEXAMPLE";
const RANGE = "shtEx1!A1:F6";
const ENCODED_RANGE = "shtEx1%21A1%3AF6";
const VALUES_URL = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${ENCODED_RANGE}?valueRenderOption=ToString`;
const META_PATH = `/open-apis/sheets/v3/spreadsheets/${SHEET_TOKEN}/sheets/query`;

describe("read_sheet", () => {
  it("is read-only and tells the client to call meta first", async () => {
    const { accessToken } = await login();
    const tool = (await listTools(accessToken)).find((entry) => entry.name === "read_sheet");
    const annotations = tool?.annotations as { readOnlyHint?: boolean };
    expect(annotations.readOnlyHint).toBe(true);
    expect(String(tool?.description)).toContain("Call action meta first to get sheet_id");
    expect(String(tool?.description)).toContain("ToString");
    expect(String(tool?.description)).toContain("FormattedValue");
    expect(String(tool?.description)).toContain("Formula");
    expect(String(tool?.description)).toContain("UnformattedValue");
    expect(String(tool?.description)).toContain("computed values");
    expect(String(tool?.description)).toContain("ToString (default) returns the formula text");
  });

  it("allows the two sheet-read endpoints and rejects near-misses", () => {
    expect(isEndpointAllowed("GET", `https://open.feishu.cn${META_PATH}`)).toBe(true);
    expect(isEndpointAllowed("GET", VALUES_URL)).toBe(true);
    expect(isEndpointAllowed("POST", `https://open.feishu.cn${META_PATH}`)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn${META_PATH}/extra`)).toBe(false);
    expect(isEndpointAllowed("POST", VALUES_URL)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/a/b`)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.larksuite.com${META_PATH}`)).toBe(false);
  });

  it("resolves a wiki URL, a sheet URL, and a sheet token, and returns fixture meta", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: SHEET_TOKEN, obj_type: "sheet", space_id: "spcW", node_token: "wikcnSHEET" } },
        });
      }
      if (method === "GET" && url.pathname === META_PATH) {
        return Response.json({ code: 0, data: sheetsQuery.data });
      }
      return undefined;
    };
    const wiki = toolText(
      (await callTool(accessToken, "read_sheet", { doc: "https://example.feishu.cn/wiki/wikcnSHEET", action: "meta" })).body,
    );
    expect(wiki).toContain('"sheet_id":"shtEx1"');
    expect(wiki).toContain('"sheet_id":"shtEx2"');
    expect(JSON.parse(wiki)).toEqual(sheetsQuery.data);

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === META_PATH) return Response.json({ code: 0, data: sheetsQuery.data });
      return undefined;
    };
    const beforeUrl = fake.calls.length;
    const fromUrl = await callTool(accessToken, "read_sheet", {
      doc: `https://example.feishu.cn/sheets/${SHEET_TOKEN}`,
      action: "meta",
    });
    expect(toolText(fromUrl.body)).toContain('"sheet_id":"shtEx1"');
    expect(fake.calls.slice(beforeUrl).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(false);

    const beforeToken = fake.calls.length;
    const fromToken = await callTool(accessToken, "read_sheet", { doc: SHEET_TOKEN, action: "meta" });
    expect(toolText(fromToken.body)).toContain('"title":"Weekly summary (example)"');
    expect(fake.calls.slice(beforeToken).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(true);
  });

  it("pins percent-encoded values range and returns the fixture valueRange", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === `/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${ENCODED_RANGE}`) {
        expect(url.searchParams.get("valueRenderOption")).toBe("ToString");
        return Response.json({ code: 0, data: sheetValues.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "read_sheet", { doc: SHEET_TOKEN, action: "values", range: RANGE });
    expect(fake.calls.slice(before).map((call) => call.url)).toContain(VALUES_URL);
    expect(JSON.parse(toolText(response.body))).toEqual(sheetValues.data);
  });

  it("returns too_large instead of truncated JSON when values exceed the tool output cap", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === `/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${ENCODED_RANGE}`) {
        return Response.json({
          code: 0,
          data: { valueRange: { range: RANGE, values: [["x".repeat(OUTPUT_LIMIT + 1)]] } },
        });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "read_sheet", { doc: SHEET_TOKEN, action: "values", range: RANGE });
    const text = toolText(response.body);
    expect(text.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    expect(text).not.toContain("[truncated; ask for the next page]");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.too_large).toBe(true);
    expect(String(parsed.hint)).toMatch(/smaller range/i);
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("names the right tool on a non-sheet wiki node", async () => {
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
    const response = await callTool(accessToken, "read_sheet", { doc: "https://example.feishu.cn/wiki/wikcnDOC", action: "meta" });
    expect(toolText(response.body)).toBe("this is a docx; use fetch_doc");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.slice(before).some((call) => call.url.includes("/sheets/"))).toBe(false);
  });

  it("passes 99991679 with a re-authorize hint and audits read_sheet", async () => {
    const logs = logLines();
    try {
      const { accessToken } = await login();
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === META_PATH) {
          return Response.json({ code: 99991679, msg: "unauthorized: missing scope sheets:spreadsheet:read" });
        }
        return undefined;
      };
      const response = await callTool(accessToken, "read_sheet", { doc: SHEET_TOKEN, action: "meta" });
      const text = toolText(response.body);
      expect(text).toContain("99991679");
      expect(text).toContain("re-authorize the connector to grant new scopes");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      const audited = logs.lines().filter((line) => line.includes('"event":"tool_call"') && line.includes('"tool":"read_sheet"'));
      expect(audited).toHaveLength(1);
      expect(audited[0]).toContain('"code":"99991679"');
    } finally {
      logs.restore();
    }
  });

  it("sends sheet reads to open.larksuite.com when FEISHU_REGION is lark", async () => {
    env.FEISHU_REGION = "lark";
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === META_PATH) {
        return Response.json({ code: 0, data: sheetsQuery.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "read_sheet", {
      doc: `https://example.feishu.cn/sheets/${SHEET_TOKEN}`,
      action: "meta",
    });
    expect(JSON.parse(toolText(response.body))).toEqual(sheetsQuery.data);
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url === `https://open.larksuite.com${META_PATH}`)).toBe(true);
    expect(outbound.every((url) => !url.includes("feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn${META_PATH}`)).toBe(true);
    expect(isEndpointAllowed("GET", `https://open.larksuite.com${META_PATH}`)).toBe(false);
  });
});

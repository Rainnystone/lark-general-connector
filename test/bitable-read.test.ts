import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import { FEISHU_SCOPES } from "../src/scopes";
import bitableApp from "./fixtures/doc-types/bitable-app-get.json" with { type: "json" };
import bitableFields from "./fixtures/doc-types/bitable-fields-list.json" with { type: "json" };
import bitableTables from "./fixtures/doc-types/bitable-tables-list.json" with { type: "json" };
import baseRecords from "./fixtures/doc-types/base-v3-records-list.json" with { type: "json" };
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const APP_TOKEN = "bascnEXAMPLE";
const TABLE_ID = "tblEx1";
const APP_PATH = `/open-apis/bitable/v1/apps/${APP_TOKEN}`;
const TABLES_PATH = `${APP_PATH}/tables`;
const FIELDS_PATH = `${APP_PATH}/tables/${TABLE_ID}/fields`;
const RECORDS_PATH = `/open-apis/base/v3/bases/${APP_TOKEN}/tables/${TABLE_ID}/records`;
const V1_RECORDS = `https://open.feishu.cn${APP_PATH}/tables/${TABLE_ID}/records`;
const RECORDS_URL = `https://open.feishu.cn${RECORDS_PATH}?offset=0&limit=200&view_id=vewTEST`;

describe("read_bitable", () => {
  it("is read-only and describes app, tables, fields, and v3 records", async () => {
    const { accessToken } = await login();
    const tool = (await listTools(accessToken)).find((entry) => entry.name === "read_bitable");
    const annotations = tool?.annotations as { readOnlyHint?: boolean };
    expect(annotations.readOnlyHint).toBe(true);
    expect(String(tool?.description)).toContain("action app");
    expect(String(tool?.description)).toContain("page_token");
    expect(String(tool?.description)).toContain("Base v3");
    expect(String(tool?.description)).toContain("offset");
    expect(String(tool?.description)).toContain("200");
    expect(String(tool?.description)).toContain("view_id");
    expect(String(tool?.description)).toContain("field_type_list");
  });

  it("allows the four bitable-read endpoints and rejects near-misses and v1 records", () => {
    expect(isEndpointAllowed("GET", `https://open.feishu.cn${APP_PATH}`)).toBe(true);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn${TABLES_PATH}`)).toBe(true);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn${FIELDS_PATH}`)).toBe(true);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn${RECORDS_PATH}`)).toBe(true);
    expect(isEndpointAllowed("POST", `https://open.feishu.cn${APP_PATH}`)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn${APP_PATH}/extra`)).toBe(false);
    expect(isEndpointAllowed("GET", V1_RECORDS)).toBe(false);
    expect(isEndpointAllowed("POST", `https://open.feishu.cn${RECORDS_PATH}`)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn${RECORDS_PATH}/extra`)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.larksuite.com${APP_PATH}`)).toBe(false);
    expect(FEISHU_SCOPES.some((scope) => scope.startsWith("bitable:app"))).toBe(false);
    expect(FEISHU_SCOPES).not.toContain("base:record:retrieve");
  });

  it("resolves a wiki URL, a base URL, and an app token, and returns fixture app data", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: APP_TOKEN, obj_type: "bitable", space_id: "spcW", node_token: "wikcnBASE" } },
        });
      }
      if (method === "GET" && url.pathname === APP_PATH) {
        return Response.json({ code: 0, data: bitableApp });
      }
      return undefined;
    };
    const wiki = toolText(
      (await callTool(accessToken, "read_bitable", { doc: "https://example.feishu.cn/wiki/wikcnBASE", action: "app" })).body,
    );
    expect(wiki).toContain(`"app_token":"${APP_TOKEN}"`);
    expect(JSON.parse(wiki)).toEqual(bitableApp);

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === APP_PATH) return Response.json({ code: 0, data: bitableApp });
      return undefined;
    };
    const beforeUrl = fake.calls.length;
    const fromUrl = await callTool(accessToken, "read_bitable", {
      doc: `https://example.feishu.cn/base/${APP_TOKEN}`,
      action: "app",
    });
    expect(JSON.parse(toolText(fromUrl.body))).toEqual(bitableApp);
    expect(fake.calls.slice(beforeUrl).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(false);

    const beforeToken = fake.calls.length;
    const fromToken = await callTool(accessToken, "read_bitable", { doc: APP_TOKEN, action: "app" });
    expect(toolText(fromToken.body)).toContain('"time_zone":"UTC"');
    expect(fake.calls.slice(beforeToken).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(true);
  });

  it("passes tables/fields page_token and records offset/limit/view_id with no Worker paging loop", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === TABLES_PATH) {
        expect(url.searchParams.get("page_token")).toBe("tblNext");
        return Response.json({ code: 0, data: bitableTables.data });
      }
      if (method === "GET" && url.pathname === FIELDS_PATH) {
        expect(url.searchParams.get("page_token")).toBe("fldNext");
        return Response.json({ code: 0, data: bitableFields.data });
      }
      if (method === "GET" && url.pathname === RECORDS_PATH) {
        expect(url.searchParams.get("offset")).toBe("0");
        expect(url.searchParams.get("limit")).toBe("200");
        expect(url.searchParams.get("view_id")).toBe("vewTEST");
        return Response.json({ code: 0, data: baseRecords.data });
      }
      return undefined;
    };

    const tablesBefore = fake.calls.length;
    const tables = await callTool(accessToken, "read_bitable", {
      doc: APP_TOKEN,
      action: "tables",
      page_token: "tblNext",
    });
    expect(JSON.parse(toolText(tables.body))).toEqual(bitableTables.data);
    expect(toolText(tables.body)).toContain('"has_more":false');
    expect(toolText(tables.body)).toContain(`"page_token":"${TABLE_ID}"`);
    expect(fake.calls.slice(tablesBefore).filter((call) => call.url.includes("/tables")).length).toBe(1);

    const fields = await callTool(accessToken, "read_bitable", {
      doc: APP_TOKEN,
      action: "fields",
      table_id: TABLE_ID,
      page_token: "fldNext",
    });
    expect(JSON.parse(toolText(fields.body))).toEqual(bitableFields.data);

    const recordsBefore = fake.calls.length;
    const records = await callTool(accessToken, "read_bitable", {
      doc: APP_TOKEN,
      action: "records",
      table_id: TABLE_ID,
      offset: 0,
      limit: 500,
      view_id: "vewTEST",
    });
    expect(fake.calls.slice(recordsBefore).map((call) => call.url)).toContain(RECORDS_URL);
    expect(fake.calls.slice(recordsBefore).some((call) => call.url.includes("/bitable/v1/") && call.url.includes("/records"))).toBe(false);
    expect(JSON.parse(toolText(records.body))).toEqual(baseRecords.data);
    expect(toolText(records.body)).toContain('"has_more":true');
    expect(toolText(records.body)).toContain('"field_type_list"');
    expect(fake.calls.slice(recordsBefore).filter((call) => call.url.includes("/records")).length).toBe(1);
  });

  it("names the right tool on a non-bitable wiki node", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: "shtcnOBJ", obj_type: "sheet", space_id: "spcW", node_token: "wikcnSHEET" } },
        });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "read_bitable", { doc: "https://example.feishu.cn/wiki/wikcnSHEET", action: "app" });
    expect(toolText(response.body)).toBe("this is a sheet; use read_sheet");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.slice(before).some((call) => call.url.includes("/bitable/") || call.url.includes("/base/"))).toBe(false);
  });

  it("passes 99991679 with a re-authorize hint and audits read_bitable", async () => {
    const logs = logLines();
    try {
      const { accessToken } = await login();
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === APP_PATH) {
          return Response.json({ code: 99991679, msg: "unauthorized: missing scope base:app:read" });
        }
        return undefined;
      };
      const response = await callTool(accessToken, "read_bitable", { doc: APP_TOKEN, action: "app" });
      const text = toolText(response.body);
      expect(text).toContain("99991679");
      expect(text).toContain("re-authorize the connector to grant new scopes");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      const audited = logs.lines().filter((line) => line.includes('"event":"tool_call"') && line.includes('"tool":"read_bitable"'));
      expect(audited).toHaveLength(1);
      expect(audited[0]).toContain('"code":"99991679"');
    } finally {
      logs.restore();
    }
  });

  it("sends bitable reads to open.larksuite.com when FEISHU_REGION is lark", async () => {
    env.FEISHU_REGION = "lark";
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === APP_PATH) {
        return Response.json({ code: 0, data: bitableApp });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "read_bitable", {
      doc: `https://example.feishu.cn/base/${APP_TOKEN}`,
      action: "app",
    });
    expect(JSON.parse(toolText(response.body))).toEqual(bitableApp);
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url === `https://open.larksuite.com${APP_PATH}`)).toBe(true);
    expect(outbound.every((url) => !url.includes("feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn${APP_PATH}`)).toBe(true);
    expect(isEndpointAllowed("GET", `https://open.larksuite.com${APP_PATH}`)).toBe(false);
  });
});

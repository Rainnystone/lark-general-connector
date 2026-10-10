import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import sheetCreate from "./fixtures/doc-types/write/w-sheet-create.json" with { type: "json" };
import sheetReadback from "./fixtures/doc-types/write/w-sheet-readback.json" with { type: "json" };
import sheetAppend from "./fixtures/doc-types/write/w-sheet-values-append.json" with { type: "json" };
import sheetBatch from "./fixtures/doc-types/write/w-sheet-values-batch-update.json" with { type: "json" };
import sheetPut from "./fixtures/doc-types/write/w-sheet-values-put.json" with { type: "json" };
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const SHEET_TOKEN = "shtcnEXAMPLE";
const FOLDER_TOKEN = "fldcnEXAMPLE";
const CREATE_TITLE = "Example sheet";
const PUT_RANGE = "shtEx1!A1:C2";
const APPEND_RANGE = "shtEx1!A3:C3";
const BATCH_RANGE = "shtEx1!D1:D1";
const CREATE_PATH = "/open-apis/sheets/v3/spreadsheets";
const CREATE_URL = `https://open.feishu.cn${CREATE_PATH}`;
const PUT_URL = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values`;
const APPEND_URL = `${PUT_URL.replace(/\/values$/, "/values_append")}?insertDataOption=INSERT_ROWS`;
const BATCH_URL = PUT_URL.replace(/\/values$/, "/values_batch_update");
const FORMULA_CELL = { type: "formula", text: "=B2+2" };

describe("write_sheet", () => {
  it("describes formula cells and is not read-only", async () => {
    const { accessToken } = await login();
    const tool = (await listTools(accessToken)).find((entry) => entry.name === "write_sheet");
    const annotations = tool?.annotations as { readOnlyHint?: boolean };
    expect(annotations.readOnlyHint).toBe(false);
    const description = String(tool?.description);
    expect(description).toContain('plain string "=..." is stored as text');
    expect(description).toContain('{type:"formula",text}');
    expect(JSON.stringify(sheetReadback.data.valueRange.values)).toContain('"=B2+2"');
  });

  it("allows the four sheet-write endpoints and rejects near-misses", () => {
    expect(isEndpointAllowed("POST", CREATE_URL)).toBe(true);
    expect(isEndpointAllowed("PUT", PUT_URL)).toBe(true);
    expect(isEndpointAllowed("POST", APPEND_URL)).toBe(true);
    expect(isEndpointAllowed("POST", BATCH_URL)).toBe(true);
    expect(isEndpointAllowed("GET", CREATE_URL)).toBe(false);
    expect(isEndpointAllowed("POST", `${CREATE_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("GET", PUT_URL)).toBe(false);
    expect(isEndpointAllowed("POST", PUT_URL)).toBe(false);
    expect(isEndpointAllowed("PUT", `${PUT_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("GET", APPEND_URL)).toBe(false);
    expect(isEndpointAllowed("POST", `${APPEND_URL.split("?")[0]}/extra`)).toBe(false);
    expect(isEndpointAllowed("GET", BATCH_URL)).toBe(false);
    expect(isEndpointAllowed("POST", `${BATCH_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("POST", `https://open.larksuite.com${CREATE_PATH}`)).toBe(false);
    expect(isEndpointAllowed("PUT", `https://open.larksuite.com/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values`)).toBe(false);
  });

  it("creates with the example body and returns the fixture spreadsheet", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === CREATE_PATH) {
        return Response.json({ code: 0, data: sheetCreate.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "write_sheet", {
      action: "create",
      title: CREATE_TITLE,
      folder_token: FOLDER_TOKEN,
    });
    const outbound = fake.calls.slice(before).find((call) => call.url === CREATE_URL);
    expect(JSON.parse(outbound?.body ?? "")).toEqual({ title: CREATE_TITLE, folder_token: FOLDER_TOKEN });
    expect(JSON.parse(toolText(response.body))).toEqual(sheetCreate.data);
  });

  it("forwards put, append, and batch_update bodies, including formula cells", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "PUT" && url.pathname.endsWith("/values")) return Response.json({ code: 0, data: sheetPut.data });
      if (method === "POST" && url.pathname.endsWith("/values_append")) return Response.json({ code: 0, data: sheetAppend.data });
      if (method === "POST" && url.pathname.endsWith("/values_batch_update")) return Response.json({ code: 0, data: sheetBatch.data });
      return undefined;
    };

    const putBefore = fake.calls.length;
    const putValues = [
      ["name", "qty", "note"],
      ["apple", 3, FORMULA_CELL],
    ];
    const put = await callTool(accessToken, "write_sheet", { action: "put", doc: SHEET_TOKEN, range: PUT_RANGE, values: putValues });
    expect(fake.calls.slice(putBefore).map((call) => call.url)).toContain(PUT_URL);
    expect(JSON.parse(fake.calls.slice(putBefore).find((call) => call.url === PUT_URL)?.body ?? "")).toEqual({
      valueRange: { range: PUT_RANGE, values: putValues },
    });
    expect(JSON.parse(toolText(put.body))).toEqual(sheetPut.data);

    const appendBefore = fake.calls.length;
    const appendValues = [["pear", 5, "probe"]];
    const append = await callTool(accessToken, "write_sheet", {
      action: "append",
      doc: SHEET_TOKEN,
      range: APPEND_RANGE,
      values: appendValues,
      insert_data_option: "INSERT_ROWS",
    });
    expect(fake.calls.slice(appendBefore).map((call) => call.url)).toContain(APPEND_URL);
    expect(JSON.parse(fake.calls.slice(appendBefore).find((call) => call.url === APPEND_URL)?.body ?? "")).toEqual({
      valueRange: { range: APPEND_RANGE, values: appendValues },
    });
    expect(JSON.parse(toolText(append.body))).toEqual(sheetAppend.data);

    const batchBefore = fake.calls.length;
    const batchRanges = [{ range: BATCH_RANGE, values: [["batch"]] }];
    const batch = await callTool(accessToken, "write_sheet", { action: "batch_update", doc: SHEET_TOKEN, value_ranges: batchRanges });
    expect(fake.calls.slice(batchBefore).map((call) => call.url)).toContain(BATCH_URL);
    expect(JSON.parse(fake.calls.slice(batchBefore).find((call) => call.url === BATCH_URL)?.body ?? "")).toEqual({
      valueRanges: batchRanges,
    });
    expect(JSON.parse(toolText(batch.body))).toEqual(sheetBatch.data);
  });

  it("writes a wiki-hosted sheet and refuses a type mismatch", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: SHEET_TOKEN, obj_type: "sheet", space_id: "spcW", node_token: "wikcnSHEET" } },
        });
      }
      if (method === "PUT" && url.pathname === `/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values`) {
        return Response.json({ code: 0, data: sheetPut.data });
      }
      return undefined;
    };
    const wiki = await callTool(accessToken, "write_sheet", {
      action: "put",
      doc: "https://example.feishu.cn/wiki/wikcnSHEET",
      range: PUT_RANGE,
      values: [["ok"]],
    });
    expect(JSON.parse(toolText(wiki.body))).toEqual(sheetPut.data);

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
    const mismatch = await callTool(accessToken, "write_sheet", {
      action: "put",
      doc: "https://example.feishu.cn/wiki/wikcnDOC",
      range: PUT_RANGE,
      values: [["no"]],
    });
    expect(toolText(mismatch.body)).toBe("this is a docx; use fetch_doc");
    expect((mismatch.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.slice(before).some((call) => call.method !== "GET" && call.url.includes("/sheets/"))).toBe(false);
  });

  it("passes 99991679 with a re-authorize hint and audits write_sheet", async () => {
    const logs = logLines();
    try {
      const { accessToken } = await login();
      fake.extra = (method, url) => {
        if (method === "POST" && url.pathname === CREATE_PATH) {
          return Response.json({ code: 99991679, msg: "unauthorized: missing scope sheets:spreadsheet:create" });
        }
        return undefined;
      };
      const response = await callTool(accessToken, "write_sheet", { action: "create", title: CREATE_TITLE });
      const text = toolText(response.body);
      expect(text).toContain("99991679");
      expect(text).toContain("re-authorize the connector to grant new scopes");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      const audited = logs.lines().filter((line) => line.includes('"event":"tool_call"') && line.includes('"tool":"write_sheet"'));
      expect(audited).toHaveLength(1);
      expect(audited[0]).toContain('"code":"99991679"');
      expect(audited[0]).toContain('"target":null');
      expect(audited[0]).not.toContain(CREATE_TITLE);
    } finally {
      logs.restore();
    }
  });

  it("sends sheet writes to open.larksuite.com when FEISHU_REGION is lark", async () => {
    env.FEISHU_REGION = "lark";
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === CREATE_PATH) {
        return Response.json({ code: 0, data: sheetCreate.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "write_sheet", { action: "create", title: CREATE_TITLE });
    expect(JSON.parse(toolText(response.body))).toEqual(sheetCreate.data);
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url === `https://open.larksuite.com${CREATE_PATH}`)).toBe(true);
    expect(outbound.every((url) => !url.includes("feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("POST", CREATE_URL)).toBe(true);
    expect(isEndpointAllowed("POST", `https://open.larksuite.com${CREATE_PATH}`)).toBe(false);
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import bitableCreate from "./fixtures/doc-types/write/w-bitable-app-create.json" with { type: "json" };
import fieldCreate from "./fixtures/doc-types/write/w-bitable-field-create.json" with { type: "json" };
import fieldDelete from "./fixtures/doc-types/write/w-bitable-field-delete-v1.json" with { type: "json" };
import fieldUpdate from "./fixtures/doc-types/write/w-bitable-field-update-v1.json" with { type: "json" };
import recordCreate from "./fixtures/doc-types/write/w-bitable-record-create-v1.json" with { type: "json" };
import recordDelete from "./fixtures/doc-types/write/w-bitable-record-delete-v1.json" with { type: "json" };
import recordUpdate from "./fixtures/doc-types/write/w-bitable-record-update-v1.json" with { type: "json" };
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const APP_TOKEN = "bascnEXAMPLE";
const TABLE_ID = "tblEx1";
const FOLDER_TOKEN = "fldcnEXAMPLE";
const FIELD_ID = "fldExQty";
const UPDATE_FIELD_ID = "fldExNum";
const RECORD_ID = "recEx1";
const DELETE_RECORD_ID = "recEx2";
const CREATE_NAME = "Example base";
const CREATE_PATH = "/open-apis/bitable/v1/apps";
const CREATE_URL = `https://open.feishu.cn${CREATE_PATH}`;
const TABLE_ROOT = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}`;
const FIELDS_URL = `${TABLE_ROOT}/fields`;
const UPDATE_FIELD_URL = `${FIELDS_URL}/${UPDATE_FIELD_ID}`;
const RECORDS_URL = `${TABLE_ROOT}/records`;
const RECORD_URL = `${RECORDS_URL}/${RECORD_ID}`;
const DELETE_RECORD_URL = `${RECORDS_URL}/${DELETE_RECORD_ID}`;
const V3_BATCH = `https://open.feishu.cn/open-apis/base/v3/bases/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_create`;
const DELETE_APP_URL = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}`;
const DELETE_TABLE_URL = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}`;

describe("write_bitable", () => {
  it("describes empty default rows and irreversible field/record deletes", async () => {
    const { accessToken } = await login();
    const tool = (await listTools(accessToken)).find((entry) => entry.name === "write_bitable");
    const annotations = tool?.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean };
    expect(annotations.readOnlyHint).toBe(false);
    expect(annotations.destructiveHint).toBe(true);
    const description = String(tool?.description);
    expect(description).toContain("10 empty rows");
    expect(description).toContain("delete_field");
    expect(description).toContain("delete_record");
    expect(description).toContain("irreversible");
    expect(description).toContain("wiki-hosted");
    expect(description).toContain("need no title confirmation");
  });

  it("allows the seven bitable-write endpoints and rejects near-misses, app delete, and table delete", () => {
    expect(isEndpointAllowed("POST", CREATE_URL)).toBe(true);
    expect(isEndpointAllowed("POST", FIELDS_URL)).toBe(true);
    expect(isEndpointAllowed("POST", RECORDS_URL)).toBe(true);
    expect(isEndpointAllowed("PUT", RECORD_URL)).toBe(true);
    expect(isEndpointAllowed("PUT", UPDATE_FIELD_URL)).toBe(true);
    expect(isEndpointAllowed("DELETE", UPDATE_FIELD_URL)).toBe(true);
    expect(isEndpointAllowed("DELETE", DELETE_RECORD_URL)).toBe(true);
    expect(isEndpointAllowed("GET", CREATE_URL)).toBe(false);
    expect(isEndpointAllowed("POST", `${CREATE_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("GET", FIELDS_URL)).toBe(true);
    expect(isEndpointAllowed("POST", `${FIELDS_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("PUT", FIELDS_URL)).toBe(false);
    expect(isEndpointAllowed("DELETE", FIELDS_URL)).toBe(false);
    expect(isEndpointAllowed("GET", RECORD_URL)).toBe(false);
    expect(isEndpointAllowed("POST", RECORD_URL)).toBe(false);
    expect(isEndpointAllowed("PUT", `${RECORD_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("POST", V3_BATCH)).toBe(false);
    expect(isEndpointAllowed("POST", `${RECORDS_URL}/search`)).toBe(false);
    expect(isEndpointAllowed("DELETE", DELETE_APP_URL)).toBe(false);
    expect(isEndpointAllowed("DELETE", `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables`)).toBe(false);
    expect(isEndpointAllowed("DELETE", DELETE_TABLE_URL)).toBe(false);
    expect(isEndpointAllowed("DELETE", RECORDS_URL)).toBe(false);
    expect(isEndpointAllowed("POST", `https://open.larksuite.com${CREATE_PATH}`)).toBe(false);
    expect(isEndpointAllowed("DELETE", `https://open.larksuite.com/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields/${UPDATE_FIELD_ID}`)).toBe(
      false,
    );
  });

  it("creates an app with the example body and returns the fixture", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === CREATE_PATH) {
        return Response.json({ code: 0, data: bitableCreate.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "write_bitable", {
      action: "create_app",
      name: CREATE_NAME,
      folder_token: FOLDER_TOKEN,
    });
    const outbound = fake.calls.slice(before).find((call) => call.url === CREATE_URL);
    expect(JSON.parse(outbound?.body ?? "")).toEqual({ name: CREATE_NAME, folder_token: FOLDER_TOKEN });
    expect(JSON.parse(toolText(response.body))).toEqual(bitableCreate.data);
  });

  it("forwards field and record create/update/delete bodies from the write fixtures", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields`) {
        return Response.json({ code: 0, data: fieldCreate.data });
      }
      if (method === "POST" && url.pathname === `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`) {
        return Response.json({ code: 0, data: recordCreate.data });
      }
      if (method === "PUT" && url.pathname === `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/${RECORD_ID}`) {
        return Response.json({ code: 0, data: recordUpdate.data });
      }
      if (method === "PUT" && url.pathname === `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields/${UPDATE_FIELD_ID}`) {
        return Response.json({ code: 0, data: fieldUpdate.data });
      }
      if (method === "DELETE" && url.pathname === `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields/${UPDATE_FIELD_ID}`) {
        return Response.json({ code: 0, data: fieldDelete.data });
      }
      if (method === "DELETE" && url.pathname === `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/${DELETE_RECORD_ID}`) {
        return Response.json({ code: 0, data: recordDelete.data });
      }
      return undefined;
    };

    const fieldBefore = fake.calls.length;
    const createdField = await callTool(accessToken, "write_bitable", {
      action: "create_field",
      doc: APP_TOKEN,
      table_id: TABLE_ID,
      field_name: "qty",
      type: 2,
      property: { formatter: "0.0" },
    });
    expect(fake.calls.slice(fieldBefore).map((call) => call.url)).toContain(FIELDS_URL);
    expect(JSON.parse(fake.calls.slice(fieldBefore).find((call) => call.url === FIELDS_URL)?.body ?? "")).toEqual({
      field_name: "qty",
      type: 2,
      property: { formatter: "0.0" },
    });
    expect(JSON.parse(toolText(createdField.body))).toEqual(fieldCreate.data);
    expect(toolText(createdField.body)).toContain(`"field_id":"${FIELD_ID}"`);

    const recordBefore = fake.calls.length;
    const createdRecord = await callTool(accessToken, "write_bitable", {
      action: "create_record",
      doc: APP_TOKEN,
      table_id: TABLE_ID,
      fields: { qty: 7 },
    });
    expect(fake.calls.slice(recordBefore).map((call) => call.url)).toContain(RECORDS_URL);
    expect(JSON.parse(fake.calls.slice(recordBefore).find((call) => call.url === RECORDS_URL)?.body ?? "")).toEqual({
      fields: { qty: 7 },
    });
    expect(JSON.parse(toolText(createdRecord.body))).toEqual(recordCreate.data);

    const updateRecordBefore = fake.calls.length;
    const updatedRecord = await callTool(accessToken, "write_bitable", {
      action: "update_record",
      doc: APP_TOKEN,
      table_id: TABLE_ID,
      record_id: RECORD_ID,
      fields: { qty: 8, note: "example-row" },
    });
    expect(fake.calls.slice(updateRecordBefore).map((call) => call.url)).toContain(RECORD_URL);
    expect(JSON.parse(fake.calls.slice(updateRecordBefore).find((call) => call.url === RECORD_URL)?.body ?? "")).toEqual({
      fields: { qty: 8, note: "example-row" },
    });
    expect(JSON.parse(toolText(updatedRecord.body))).toEqual(recordUpdate.data);

    const updateFieldBefore = fake.calls.length;
    const updatedField = await callTool(accessToken, "write_bitable", {
      action: "update_field",
      doc: APP_TOKEN,
      table_id: TABLE_ID,
      field_id: UPDATE_FIELD_ID,
      field_name: "qty_renamed",
      type: 2,
      property: { formatter: "0.00" },
    });
    expect(fake.calls.slice(updateFieldBefore).map((call) => call.url)).toContain(UPDATE_FIELD_URL);
    expect(JSON.parse(fake.calls.slice(updateFieldBefore).find((call) => call.url === UPDATE_FIELD_URL)?.body ?? "")).toEqual({
      field_name: "qty_renamed",
      type: 2,
      property: { formatter: "0.00" },
    });
    expect(JSON.parse(toolText(updatedField.body))).toEqual(fieldUpdate.data);

    const deleteFieldBefore = fake.calls.length;
    const deletedField = await callTool(accessToken, "write_bitable", {
      action: "delete_field",
      doc: APP_TOKEN,
      table_id: TABLE_ID,
      field_id: UPDATE_FIELD_ID,
    });
    expect(fake.calls.slice(deleteFieldBefore).map((call) => `${call.method} ${call.url}`)).toContain(`DELETE ${UPDATE_FIELD_URL}`);
    expect(fake.calls.slice(deleteFieldBefore).find((call) => call.url === UPDATE_FIELD_URL)?.body).toBe("");
    expect(JSON.parse(toolText(deletedField.body))).toEqual(fieldDelete.data);
    expect(toolText(deletedField.body)).toContain('"deleted":true');
    expect(toolText(deletedField.body)).toContain(`"field_id":"${UPDATE_FIELD_ID}"`);

    const deleteRecordBefore = fake.calls.length;
    const deletedRecord = await callTool(accessToken, "write_bitable", {
      action: "delete_record",
      doc: APP_TOKEN,
      table_id: TABLE_ID,
      record_id: DELETE_RECORD_ID,
    });
    expect(fake.calls.slice(deleteRecordBefore).map((call) => `${call.method} ${call.url}`)).toContain(`DELETE ${DELETE_RECORD_URL}`);
    expect(JSON.parse(toolText(deletedRecord.body))).toEqual(recordDelete.data);
    expect(toolText(deletedRecord.body)).toContain(`"record_id":"${DELETE_RECORD_ID}"`);
  });

  it("writes a wiki-hosted Base and refuses a type mismatch", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: APP_TOKEN, obj_type: "bitable", space_id: "spcW", node_token: "wikcnBASE" } },
        });
      }
      if (method === "POST" && url.pathname === `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`) {
        return Response.json({ code: 0, data: recordCreate.data });
      }
      return undefined;
    };
    const wiki = await callTool(accessToken, "write_bitable", {
      action: "create_record",
      doc: "https://example.feishu.cn/wiki/wikcnBASE",
      table_id: TABLE_ID,
      fields: { qty: 7 },
    });
    expect(JSON.parse(toolText(wiki.body))).toEqual(recordCreate.data);

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
    const mismatch = await callTool(accessToken, "write_bitable", {
      action: "create_record",
      doc: "https://example.feishu.cn/wiki/wikcnSHEET",
      table_id: TABLE_ID,
      fields: { qty: 7 },
    });
    expect(toolText(mismatch.body)).toBe("this is a sheet; use write_sheet");
    expect((mismatch.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.slice(before).some((call) => call.method !== "GET" && call.url.includes("/bitable/"))).toBe(false);
  });

  it("passes 99991679 with a re-authorize hint and audits write_bitable", async () => {
    const logs = logLines();
    try {
      const { accessToken } = await login();
      fake.extra = (method, url) => {
        if (method === "POST" && url.pathname === CREATE_PATH) {
          return Response.json({ code: 99991679, msg: "unauthorized: missing scope base:app:create" });
        }
        return undefined;
      };
      const response = await callTool(accessToken, "write_bitable", { action: "create_app", name: CREATE_NAME });
      const text = toolText(response.body);
      expect(text).toContain("99991679");
      expect(text).toContain("re-authorize the connector to grant new scopes");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      const audited = logs.lines().filter((line) => line.includes('"event":"tool_call"') && line.includes('"tool":"write_bitable"'));
      expect(audited).toHaveLength(1);
      expect(audited[0]).toContain('"code":"99991679"');
      expect(audited[0]).toContain('"target":null');
      expect(audited[0]).not.toContain(CREATE_NAME);
    } finally {
      logs.restore();
    }
  });

  it("sends bitable writes to open.larksuite.com when FEISHU_REGION is lark", async () => {
    env.FEISHU_REGION = "lark";
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === CREATE_PATH) {
        return Response.json({ code: 0, data: bitableCreate.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "write_bitable", { action: "create_app", name: CREATE_NAME });
    expect(JSON.parse(toolText(response.body))).toEqual(bitableCreate.data);
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url === `https://open.larksuite.com${CREATE_PATH}`)).toBe(true);
    expect(outbound.every((url) => !url.includes("feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("POST", CREATE_URL)).toBe(true);
    expect(isEndpointAllowed("POST", `https://open.larksuite.com${CREATE_PATH}`)).toBe(false);
  });
});

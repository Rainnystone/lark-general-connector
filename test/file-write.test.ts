import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import { bytesToStandardBase64 } from "../src/feishu/media";
import { FILE_UPLOAD_MAX } from "../src/mcp/doc-file";
import fileUpload from "./fixtures/doc-types/write/w-file-upload.json" with { type: "json" };
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const FOLDER_TOKEN = "fldcnEXAMPLE";
const FILE_NAME = "notes-example.txt";
const FILE_BYTES = new TextEncoder().encode("example file bytes\n");
const FILE_BASE64 = bytesToStandardBase64(FILE_BYTES);
const UPLOAD_URL = "https://open.feishu.cn/open-apis/drive/v1/files/upload_all";
const UPLOAD_PATH = "/open-apis/drive/v1/files/upload_all";

function equalUploadBase64(): string {
  const groups = Math.floor(FILE_UPLOAD_MAX / 3);
  return `${"AAAA".repeat(groups)}AA==`;
}

describe("write_file", () => {
  it("says re-upload creates a new token and is not read-only", async () => {
    const { accessToken } = await login();
    const tool = (await listTools(accessToken)).find((entry) => entry.name === "write_file");
    const annotations = tool?.annotations as { readOnlyHint?: boolean };
    expect(annotations.readOnlyHint).toBe(false);
    const description = String(tool?.description);
    expect(description).toContain("new file_token");
    expect(description).toContain("re-upload");
    expect(description).toContain("10 MiB");
    expect(FILE_UPLOAD_MAX).toBe(10 * 1024 * 1024);
    expect(FILE_BYTES.byteLength).toBe(fileUpload.data.size);
  });

  it("allows POST upload_all and rejects near-misses", () => {
    expect(isEndpointAllowed("POST", UPLOAD_URL)).toBe(true);
    expect(isEndpointAllowed("GET", UPLOAD_URL)).toBe(false);
    expect(isEndpointAllowed("POST", `${UPLOAD_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("POST", "https://open.feishu.cn/open-apis/drive/v1/files/upload_prepare")).toBe(false);
    expect(isEndpointAllowed("POST", "https://open.feishu.cn/open-apis/drive/v1/files/upload")).toBe(false);
    expect(isEndpointAllowed("POST", `https://open.larksuite.com${UPLOAD_PATH}`)).toBe(false);
  });

  it("uploads multipart fields from the fixture and returns file_token and url", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === UPLOAD_PATH) {
        return Response.json({ code: 0, data: fileUpload.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "write_file", {
      action: "upload",
      file_name: FILE_NAME,
      content_base64: FILE_BASE64,
      folder_token: FOLDER_TOKEN,
    });
    const outbound = fake.calls.slice(before).find((call) => call.url === UPLOAD_URL);
    expect(outbound?.form?.file_name).toEqual({ value: FILE_NAME });
    expect(outbound?.form?.parent_type).toEqual({ value: "explorer" });
    expect(outbound?.form?.parent_node).toEqual({ value: FOLDER_TOKEN });
    expect(outbound?.form?.size).toEqual({ value: String(FILE_BYTES.byteLength) });
    expect(outbound?.form?.file).toEqual({ value: "example file bytes\n", fileName: FILE_NAME, size: FILE_BYTES.byteLength });
    expect(outbound?.headers["content-type"]).not.toBe("application/json");
    const parsed = JSON.parse(toolText(response.body)) as Record<string, unknown>;
    expect(parsed).toEqual(fileUpload.data);
    expect(parsed.file_token).toBe(fileUpload.data.file_token);
    expect(parsed.url).toBe(fileUpload.data.url);
  });

  it("sends empty parent_node for the default root and does not resolve wiki URLs", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === UPLOAD_PATH) {
        return Response.json({ code: 0, data: fileUpload.data });
      }
      return undefined;
    };
    const rootBefore = fake.calls.length;
    await callTool(accessToken, "write_file", {
      action: "upload",
      file_name: FILE_NAME,
      content_base64: FILE_BASE64,
    });
    const root = fake.calls.slice(rootBefore).find((call) => call.url === UPLOAD_URL);
    expect(root?.form?.parent_node).toEqual({ value: "" });
    expect(fake.calls.slice(rootBefore).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(false);

    const wikiBefore = fake.calls.length;
    await callTool(accessToken, "write_file", {
      action: "upload",
      file_name: FILE_NAME,
      content_base64: FILE_BASE64,
      folder_token: "https://example.feishu.cn/wiki/wikcnFOLDER",
    });
    const wiki = fake.calls.slice(wikiBefore).find((call) => call.url === UPLOAD_URL);
    expect(wiki?.form?.parent_node).toEqual({ value: "https://example.feishu.cn/wiki/wikcnFOLDER" });
    expect(fake.calls.slice(wikiBefore).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(false);
  });

  it("uploads a file whose decoded size equals 10 MiB", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === UPLOAD_PATH) {
        return Response.json({ code: 0, data: { ...fileUpload.data, size: FILE_UPLOAD_MAX } });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "write_file", {
      action: "upload",
      file_name: FILE_NAME,
      content_base64: equalUploadBase64(),
    });
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
    const outbound = fake.calls.slice(before).find((call) => call.url === UPLOAD_URL);
    expect(outbound?.form?.size).toEqual({ value: String(FILE_UPLOAD_MAX) });
    expect(outbound?.form?.file?.size).toBe(FILE_UPLOAD_MAX);
    expect(JSON.parse(toolText(response.body))).toEqual({ ...fileUpload.data, size: FILE_UPLOAD_MAX });
  });

  it("refuses an over-cap file before any outbound call", async () => {
    const { accessToken } = await login();
    const before = fake.calls.length;
    const over = "A".repeat(Math.ceil(((FILE_UPLOAD_MAX + 1) * 4) / 3));
    const response = await callTool(accessToken, "write_file", {
      action: "upload",
      file_name: FILE_NAME,
      content_base64: over,
    });
    expect(toolText(response.body)).toContain("10 MiB");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.slice(before).some((call) => call.url.includes("/drive/v1/files/upload_all"))).toBe(false);
  });

  it("passes 99991679 with a re-authorize hint and audits write_file", async () => {
    const logs = logLines();
    try {
      const { accessToken } = await login();
      fake.extra = (method, url) => {
        if (method === "POST" && url.pathname === UPLOAD_PATH) {
          return Response.json({ code: 99991679, msg: "unauthorized: missing scope drive:file:upload" });
        }
        return undefined;
      };
      const response = await callTool(accessToken, "write_file", {
        action: "upload",
        file_name: FILE_NAME,
        content_base64: FILE_BASE64,
      });
      const text = toolText(response.body);
      expect(text).toContain("99991679");
      expect(text).toContain("re-authorize the connector to grant new scopes");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      const audited = logs.lines().filter((line) => line.includes('"event":"tool_call"') && line.includes('"tool":"write_file"'));
      expect(audited).toHaveLength(1);
      expect(audited[0]).toContain('"code":"99991679"');
      expect(audited[0]).toContain('"target":null');
      expect(audited[0]).not.toContain(FILE_NAME);
    } finally {
      logs.restore();
    }
  });

  it("sends file uploads to open.larksuite.com when FEISHU_REGION is lark", async () => {
    env.FEISHU_REGION = "lark";
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === UPLOAD_PATH) {
        return Response.json({ code: 0, data: fileUpload.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "write_file", {
      action: "upload",
      file_name: FILE_NAME,
      content_base64: FILE_BASE64,
    });
    expect(JSON.parse(toolText(response.body))).toEqual(fileUpload.data);
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url === `https://open.larksuite.com${UPLOAD_PATH}`)).toBe(true);
    expect(outbound.every((url) => !url.includes("feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("POST", UPLOAD_URL)).toBe(true);
    expect(isEndpointAllowed("POST", `https://open.larksuite.com${UPLOAD_PATH}`)).toBe(false);
  });
});

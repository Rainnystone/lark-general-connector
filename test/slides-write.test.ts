import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import slidesCreate from "./fixtures/doc-types/write/w-slides-create.json" with { type: "json" };
import slidesAdd from "./fixtures/doc-types/write/w-slides-slide-create.json" with { type: "json" };
import slidesDelete from "./fixtures/doc-types/write/w-slides-slide-delete.json" with { type: "json" };
import slidesReplaceError from "./fixtures/doc-types/write/w-slides-slide-replace.ERROR-wrong-field.json" with { type: "json" };
import slidesReplace from "./fixtures/doc-types/write/w-slides-update-slide.json" with { type: "json" };
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const SLIDES_TOKEN = "sldcnEXAMPLE";
const SLIDE_ID = "sldEx1";
const CREATE_TITLE = "Demo deck";
const SLIDE_XML = '<slide xmlns="https://www.larkoffice.com/sml/2.0"><data></data></slide>';
const CREATE_PATH = "/open-apis/slides_ai/v1/xml_presentations";
const SLIDE_PATH = `${CREATE_PATH}/${SLIDES_TOKEN}/slide`;
const REPLACE_PATH = `${SLIDE_PATH}/replace`;
const CREATE_URL = `https://open.feishu.cn${CREATE_PATH}`;
const SLIDE_URL = `https://open.feishu.cn${SLIDE_PATH}`;
const REPLACE_URL = `https://open.feishu.cn${REPLACE_PATH}`;
const DELETE_URL = `${SLIDE_URL}?slide_id=${SLIDE_ID}`;

function lastJson(path: string): Record<string, unknown> {
  const call = [...fake.calls].reverse().find((entry) => new URL(entry.url).pathname === path);
  return JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
}

describe("write_slides", () => {
  it("is a write tool and says delete_slide is irreversible", async () => {
    const { accessToken } = await login();
    const tool = (await listTools(accessToken)).find((entry) => entry.name === "write_slides");
    const annotations = tool?.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean };
    expect(annotations.readOnlyHint).toBe(false);
    expect(annotations.destructiveHint).toBe(true);
    expect(String(tool?.description)).toContain("delete_slide");
    expect(String(tool?.description)).toMatch(/irreversible/i);
    expect(String(tool?.description)).toContain("replacement");
    expect(String(tool?.description)).not.toContain("confirm_title");
  });

  it("allows the four write endpoints and rejects near-misses", () => {
    expect(isEndpointAllowed("POST", CREATE_URL)).toBe(true);
    expect(isEndpointAllowed("POST", SLIDE_URL)).toBe(true);
    expect(isEndpointAllowed("POST", REPLACE_URL)).toBe(true);
    expect(isEndpointAllowed("DELETE", DELETE_URL)).toBe(true);
    expect(isEndpointAllowed("GET", CREATE_URL)).toBe(false);
    expect(isEndpointAllowed("POST", `${CREATE_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("GET", SLIDE_URL)).toBe(false);
    expect(isEndpointAllowed("PUT", SLIDE_URL)).toBe(false);
    expect(isEndpointAllowed("DELETE", CREATE_URL)).toBe(false);
    expect(isEndpointAllowed("POST", `${SLIDE_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("DELETE", REPLACE_URL)).toBe(false);
    expect(isEndpointAllowed("POST", `https://open.larksuite.com${CREATE_PATH}`)).toBe(false);
    expect(isEndpointAllowed("DELETE", `https://open.larksuite.com${SLIDE_PATH}?slide_id=${SLIDE_ID}`)).toBe(false);
  });

  it("creates a deck with the presentation XML shell", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === CREATE_PATH) return Response.json({ code: 0, data: slidesCreate.data });
      return undefined;
    };
    const response = await callTool(accessToken, "write_slides", { action: "create", title: CREATE_TITLE });
    expect(JSON.parse(toolText(response.body))).toEqual(slidesCreate.data);
    const body = lastJson(CREATE_PATH);
    const content = (body.xml_presentation as { content?: string } | undefined)?.content ?? "";
    expect(content).toBe(
      '<presentation xmlns="https://www.larkoffice.com/sml/2.0" width="960" height="540"><title>Demo deck</title></presentation>',
    );
    expect(fake.calls.some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(false);
  });

  it("resolves a wiki URL for add_slide and forwards add, replace, and delete bodies", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: SLIDES_TOKEN, obj_type: "slides", space_id: "spcW", node_token: "wikcnSLIDES" } },
        });
      }
      if (method === "POST" && url.pathname === SLIDE_PATH) return Response.json({ code: 0, data: slidesAdd.data });
      if (method === "POST" && url.pathname === REPLACE_PATH) return Response.json({ code: 0, data: slidesReplace.data });
      if (method === "DELETE" && url.pathname === SLIDE_PATH) return Response.json({ code: 0, data: slidesDelete.data });
      return undefined;
    };

    const added = await callTool(accessToken, "write_slides", {
      action: "add_slide",
      doc: "https://example.feishu.cn/wiki/wikcnSLIDES",
      slide: SLIDE_XML,
      before_slide_id: "sld_before",
    });
    expect(JSON.parse(toolText(added.body))).toEqual(slidesAdd.data);
    expect(lastJson(SLIDE_PATH)).toEqual({ slide: { content: SLIDE_XML }, before_slide_id: "sld_before" });

    const beforeReplace = fake.calls.length;
    const replaced = await callTool(accessToken, "write_slides", {
      action: "replace_slide",
      doc: `https://example.feishu.cn/slides/${SLIDES_TOKEN}`,
      slide_id: SLIDE_ID,
      slide: SLIDE_XML,
    });
    expect(JSON.parse(toolText(replaced.body))).toEqual(slidesReplace.data);
    const replaceBody = lastJson(REPLACE_PATH);
    expect(replaceBody).toEqual({ parts: [{ action: "block_replace", block_id: SLIDE_ID, replacement: SLIDE_XML }] });
    expect(JSON.stringify(replaceBody)).toContain('"replacement"');
    expect(JSON.stringify(replaceBody)).not.toContain('"content"');
    expect(fake.calls.slice(beforeReplace).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(false);

    const deleted = await callTool(accessToken, "write_slides", {
      action: "delete_slide",
      doc: SLIDES_TOKEN,
      slide_id: SLIDE_ID,
    });
    expect(JSON.parse(toolText(deleted.body))).toEqual(slidesDelete.data);
    const deleteCall = [...fake.calls].reverse().find((call) => call.method === "DELETE" && call.url.includes("/slide"));
    expect(deleteCall?.url).toBe(DELETE_URL);
    expect(new URL(deleteCall?.url ?? "").searchParams.get("slide_id")).toBe(SLIDE_ID);
  });

  it("puts slide_id and revision_id=-1 on the replace POST query", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === REPLACE_PATH) return Response.json({ code: 0, data: slidesReplace.data });
      return undefined;
    };
    const before = fake.calls.length;
    const replaced = await callTool(accessToken, "write_slides", {
      action: "replace_slide",
      doc: `https://example.feishu.cn/slides/${SLIDES_TOKEN}`,
      slide_id: SLIDE_ID,
      slide: SLIDE_XML,
    });
    expect(JSON.parse(toolText(replaced.body))).toEqual(slidesReplace.data);
    const replaceCall = fake.calls.slice(before).find((call) => call.method === "POST" && call.url.includes("/slide/replace"));
    expect(replaceCall?.url).toBe(`${REPLACE_URL}?slide_id=${SLIDE_ID}&revision_id=-1`);
    const params = new URL(replaceCall?.url ?? "").searchParams;
    expect(params.get("slide_id")).toBe(SLIDE_ID);
    expect(params.get("revision_id")).toBe("-1");
    expect(isEndpointAllowed("POST", replaceCall?.url ?? "")).toBe(true);
  });

  it("names the right write tool on a non-slides wiki node", async () => {
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
    const response = await callTool(accessToken, "write_slides", {
      action: "add_slide",
      doc: "https://example.feishu.cn/wiki/wikcnSHEET",
      slide: SLIDE_XML,
    });
    expect(toolText(response.body)).toBe("this is a sheet; use write_sheet");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.slice(before).some((call) => call.url.includes("/slides_ai/"))).toBe(false);
  });

  it("passes the 3350001 wrong-field fixture as an error", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === REPLACE_PATH) {
        return Response.json({ code: slidesReplaceError.error.code, msg: slidesReplaceError.error.message });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "write_slides", {
      action: "replace_slide",
      doc: `https://example.feishu.cn/slides/${SLIDES_TOKEN}`,
      slide_id: SLIDE_ID,
      slide: SLIDE_XML,
    });
    const text = toolText(response.body);
    expect(text).toContain("3350001");
    expect(text).toContain("invalid param");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("passes 99991679 with a re-authorize hint and audits write_slides", async () => {
    const logs = logLines();
    try {
      const { accessToken } = await login();
      fake.extra = (method, url) => {
        if (method === "POST" && url.pathname === CREATE_PATH) {
          return Response.json({ code: 99991679, msg: "unauthorized: missing scope slides:presentation:create" });
        }
        return undefined;
      };
      const response = await callTool(accessToken, "write_slides", { action: "create", title: CREATE_TITLE });
      const text = toolText(response.body);
      expect(text).toContain("99991679");
      expect(text).toContain("re-authorize the connector to grant new scopes");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      const audited = logs.lines().filter((line) => line.includes('"event":"tool_call"') && line.includes('"tool":"write_slides"'));
      expect(audited).toHaveLength(1);
      expect(audited[0]).toContain('"code":"99991679"');
      expect(audited[0]).toContain('"target":null');
      expect(audited[0]).not.toContain(CREATE_TITLE);
    } finally {
      logs.restore();
    }
  });

  it("sends slides writes to open.larksuite.com when FEISHU_REGION is lark", async () => {
    env.FEISHU_REGION = "lark";
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === CREATE_PATH) {
        return Response.json({ code: 0, data: slidesCreate.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "write_slides", { action: "create", title: CREATE_TITLE });
    expect(JSON.parse(toolText(response.body))).toEqual(slidesCreate.data);
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url === `https://open.larksuite.com${CREATE_PATH}`)).toBe(true);
    expect(outbound.every((url) => !url.includes("feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("POST", CREATE_URL)).toBe(true);
    expect(isEndpointAllowed("POST", `https://open.larksuite.com${CREATE_PATH}`)).toBe(false);
  });
});

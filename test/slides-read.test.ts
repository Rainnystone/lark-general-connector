import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import { BODY_CHAR_LIMIT } from "../src/feishu/payload";
import slidesGet from "./fixtures/doc-types/slides-xml-presentation-get.json" with { type: "json" };
import { OUTPUT_LIMIT } from "../src/mcp/tools";
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const SLIDES_TOKEN = "sldcnEXAMPLE";
const GET_PATH = `/open-apis/slides_ai/v1/xml_presentations/${SLIDES_TOKEN}`;
const GET_URL = `https://open.feishu.cn${GET_PATH}`;

describe("read_slides", () => {
  it("is read-only and says it returns Feishu XML as-is", async () => {
    const { accessToken } = await login();
    const tool = (await listTools(accessToken)).find((entry) => entry.name === "read_slides");
    const annotations = tool?.annotations as { readOnlyHint?: boolean };
    expect(annotations.readOnlyHint).toBe(true);
    expect(String(tool?.description)).toContain("XML");
    expect(String(tool?.description)).toContain("presentation_id");
    expect(String(tool?.description)).toContain("revision_id");
  });

  it("allows the slides get endpoint and rejects near-misses", () => {
    expect(isEndpointAllowed("GET", GET_URL)).toBe(true);
    expect(isEndpointAllowed("POST", GET_URL)).toBe(false);
    expect(isEndpointAllowed("GET", `${GET_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("GET", `${GET_URL}/slide`)).toBe(false);
    expect(isEndpointAllowed("DELETE", GET_URL)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.larksuite.com${GET_PATH}`)).toBe(false);
  });

  it("resolves a wiki URL, a slides URL, and a slides token, and returns fixture XML", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: SLIDES_TOKEN, obj_type: "slides", space_id: "spcW", node_token: "wikcnSLIDES" } },
        });
      }
      if (method === "GET" && url.pathname === GET_PATH) {
        return Response.json({ code: 0, data: slidesGet.data });
      }
      return undefined;
    };
    const wiki = toolText(
      (await callTool(accessToken, "read_slides", { doc: "https://example.feishu.cn/wiki/wikcnSLIDES", action: "get" })).body,
    );
    expect(wiki).toContain('"presentation_id":"sldcnEXAMPLE"');
    expect(wiki).toContain('"revision_id":2');
    expect(wiki).toContain("<presentation");
    expect(wiki).toContain("Demo deck");
    expect(JSON.parse(wiki)).toEqual(slidesGet.data);

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === GET_PATH) return Response.json({ code: 0, data: slidesGet.data });
      return undefined;
    };
    const beforeUrl = fake.calls.length;
    const fromUrl = await callTool(accessToken, "read_slides", {
      doc: `https://example.feishu.cn/slides/${SLIDES_TOKEN}`,
      action: "get",
    });
    expect(JSON.parse(toolText(fromUrl.body))).toEqual(slidesGet.data);
    expect(fake.calls.slice(beforeUrl).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(false);
    expect(fake.calls.slice(beforeUrl).map((call) => call.url)).toContain(GET_URL);

    const beforeToken = fake.calls.length;
    const fromToken = await callTool(accessToken, "read_slides", { doc: SLIDES_TOKEN, action: "get" });
    expect(toolText(fromToken.body)).toContain("<title>Demo deck</title>");
    expect(fake.calls.slice(beforeToken).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(true);
  });

  it("returns too_large instead of truncated JSON when the deck exceeds the tool output cap", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === GET_PATH) {
        return Response.json({
          code: 0,
          data: {
            xml_presentation: {
              content: "x".repeat(OUTPUT_LIMIT + 1),
              presentation_id: SLIDES_TOKEN,
              revision_id: 1,
            },
          },
        });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "read_slides", { doc: SLIDES_TOKEN, action: "get" });
    const text = toolText(response.body);
    expect(text.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    expect(text).not.toContain("[truncated; ask for the next page]");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toEqual({ too_large: true });
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("returns too_large when a successful deck body is truncated before parse", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === GET_PATH) {
        return Response.json({
          code: 0,
          data: {
            xml_presentation: {
              content: "x".repeat(BODY_CHAR_LIMIT),
              presentation_id: SLIDES_TOKEN,
              revision_id: 1,
            },
          },
        });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "read_slides", { doc: SLIDES_TOKEN, action: "get" });
    const text = toolText(response.body);
    expect(text.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    expect(text).not.toContain("[truncated; ask for the next page]");
    expect(JSON.parse(text)).toEqual({ too_large: true });
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("names the right tool on a non-slides wiki node", async () => {
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
    const response = await callTool(accessToken, "read_slides", { doc: "https://example.feishu.cn/wiki/wikcnSHEET", action: "get" });
    expect(toolText(response.body)).toBe("this is a sheet; use read_sheet");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.slice(before).some((call) => call.url.includes("/slides_ai/"))).toBe(false);
  });

  it("passes 99991679 with a re-authorize hint and audits read_slides", async () => {
    const logs = logLines();
    try {
      const { accessToken } = await login();
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === GET_PATH) {
          return Response.json({ code: 99991679, msg: "unauthorized: missing scope slides:presentation:read" });
        }
        return undefined;
      };
      const response = await callTool(accessToken, "read_slides", { doc: SLIDES_TOKEN, action: "get" });
      const text = toolText(response.body);
      expect(text).toContain("99991679");
      expect(text).toContain("re-authorize the connector to grant new scopes");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      const audited = logs.lines().filter((line) => line.includes('"event":"tool_call"') && line.includes('"tool":"read_slides"'));
      expect(audited).toHaveLength(1);
      expect(audited[0]).toContain('"code":"99991679"');
    } finally {
      logs.restore();
    }
  });

  it("sends slides reads to open.larksuite.com when FEISHU_REGION is lark", async () => {
    env.FEISHU_REGION = "lark";
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === GET_PATH) {
        return Response.json({ code: 0, data: slidesGet.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "read_slides", {
      doc: `https://example.feishu.cn/slides/${SLIDES_TOKEN}`,
      action: "get",
    });
    expect(JSON.parse(toolText(response.body))).toEqual(slidesGet.data);
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url === `https://open.larksuite.com${GET_PATH}`)).toBe(true);
    expect(outbound.every((url) => !url.includes("feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("GET", GET_URL)).toBe(true);
    expect(isEndpointAllowed("GET", `https://open.larksuite.com${GET_PATH}`)).toBe(false);
  });
});

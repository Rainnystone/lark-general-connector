import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isEndpointAllowed } from "../src/feishu/client";
import mindnoteNodes from "./fixtures/doc-types/mindnote-nodes-list.json" with { type: "json" };
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

const MIND_TOKEN = "bmncnEXAMPLE";
const NODES_PATH = `/open-apis/mindnote/v1/mindnotes/${MIND_TOKEN}/nodes`;
const NODES_URL = `https://open.feishu.cn${NODES_PATH}`;

describe("read_mindnote", () => {
  it("is read-only and says page_token is passed through", async () => {
    const { accessToken } = await login();
    const tool = (await listTools(accessToken)).find((entry) => entry.name === "read_mindnote");
    const annotations = tool?.annotations as { readOnlyHint?: boolean };
    expect(annotations.readOnlyHint).toBe(true);
    expect(String(tool?.description)).toContain("page_token");
    expect(String(tool?.description)).toContain("read-only");
  });

  it("allows GET nodes and rejects near-misses including POST", () => {
    expect(isEndpointAllowed("GET", NODES_URL)).toBe(true);
    expect(isEndpointAllowed("GET", `${NODES_URL}?page_token=p2`)).toBe(true);
    expect(isEndpointAllowed("POST", NODES_URL)).toBe(false);
    expect(isEndpointAllowed("PUT", NODES_URL)).toBe(false);
    expect(isEndpointAllowed("GET", `${NODES_URL}/extra`)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.feishu.cn/open-apis/mindnote/v1/mindnotes/${MIND_TOKEN}`)).toBe(false);
    expect(isEndpointAllowed("GET", `https://open.larksuite.com${NODES_PATH}`)).toBe(false);
  });

  it("resolves a wiki URL, a mindnotes URL, and a token, and returns fixture nodes", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({
          code: 0,
          data: { node: { obj_token: MIND_TOKEN, obj_type: "mindnote", space_id: "spcW", node_token: "wikcnMIND" } },
        });
      }
      if (method === "GET" && url.pathname === NODES_PATH) {
        return Response.json({ code: 0, data: mindnoteNodes.data });
      }
      return undefined;
    };
    const wiki = toolText(
      (await callTool(accessToken, "read_mindnote", { doc: "https://example.feishu.cn/wiki/wikcnMIND", action: "nodes" })).body,
    );
    expect(JSON.parse(wiki)).toEqual(mindnoteNodes.data);
    expect(wiki).toContain('"node_id":"ndeEx1"');

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === NODES_PATH) {
        return Response.json({ code: 0, data: mindnoteNodes.data });
      }
      return undefined;
    };
    const beforeUrl = fake.calls.length;
    const fromUrl = await callTool(accessToken, "read_mindnote", {
      doc: `https://example.feishu.cn/mindnotes/${MIND_TOKEN}`,
      action: "nodes",
    });
    expect(JSON.parse(toolText(fromUrl.body))).toEqual(mindnoteNodes.data);
    expect(fake.calls.slice(beforeUrl).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(false);
    expect(fake.calls.slice(beforeUrl).map((call) => call.url)).toContain(NODES_URL);

    const beforeToken = fake.calls.length;
    const fromToken = await callTool(accessToken, "read_mindnote", { doc: MIND_TOKEN, action: "nodes" });
    expect(JSON.parse(toolText(fromToken.body))).toEqual(mindnoteNodes.data);
    expect(fake.calls.slice(beforeToken).some((call) => call.url.includes("/wiki/v2/spaces/get_node"))).toBe(true);
  });

  it("passes page_token through on the nodes request", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === NODES_PATH) {
        expect(url.searchParams.get("page_token")).toBe("p2");
        return Response.json({ code: 0, data: mindnoteNodes.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    await callTool(accessToken, "read_mindnote", { doc: MIND_TOKEN, action: "nodes", page_token: "p2" });
    expect(fake.calls.slice(before).map((call) => call.url)).toContain(`${NODES_URL}?page_token=p2`);
  });

  it("names the right tool on a non-mindnote wiki node", async () => {
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
    const response = await callTool(accessToken, "read_mindnote", {
      doc: "https://example.feishu.cn/wiki/wikcnDOC",
      action: "nodes",
    });
    expect(toolText(response.body)).toBe("this is a docx; use fetch_doc");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(fake.calls.slice(before).some((call) => call.url.includes("/mindnote/"))).toBe(false);
  });

  it("passes 99991679 with a re-authorize hint and audits read_mindnote", async () => {
    const logs = logLines();
    try {
      const { accessToken } = await login();
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === NODES_PATH) {
          return Response.json({ code: 99991679, msg: "unauthorized: missing scope mindnote:node:read" });
        }
        return undefined;
      };
      const response = await callTool(accessToken, "read_mindnote", { doc: MIND_TOKEN, action: "nodes" });
      const text = toolText(response.body);
      expect(text).toContain("99991679");
      expect(text).toContain("re-authorize the connector to grant new scopes");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      const audited = logs.lines().filter((line) => line.includes('"event":"tool_call"') && line.includes('"tool":"read_mindnote"'));
      expect(audited).toHaveLength(1);
      expect(audited[0]).toContain('"code":"99991679"');
    } finally {
      logs.restore();
    }
  });

  it("sends mindnote reads to open.larksuite.com when FEISHU_REGION is lark", async () => {
    env.FEISHU_REGION = "lark";
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === NODES_PATH) {
        return Response.json({ code: 0, data: mindnoteNodes.data });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "read_mindnote", {
      doc: `https://example.feishu.cn/mindnotes/${MIND_TOKEN}`,
      action: "nodes",
    });
    expect(JSON.parse(toolText(response.body))).toEqual(mindnoteNodes.data);
    const outbound = fake.calls.slice(before).map((call) => call.url);
    expect(outbound.some((url) => url === `https://open.larksuite.com${NODES_PATH}`)).toBe(true);
    expect(outbound.every((url) => !url.includes("feishu.cn"))).toBe(true);
    expect(isEndpointAllowed("GET", NODES_URL)).toBe(true);
    expect(isEndpointAllowed("GET", `https://open.larksuite.com${NODES_PATH}`)).toBe(false);
  });
});

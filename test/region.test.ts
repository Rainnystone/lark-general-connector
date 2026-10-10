import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { EndpointNotAllowedError, FeishuClient, endpointAllowlist, rewriteUrlForRegion } from "../src/feishu/client";
import { callTool, logLines, login, toolText, useFakeFeishu, workerFetch } from "./support";

const fake = useFakeFeishu();

function hostOf(url: string): string {
  return new URL(url).hostname;
}

function installToolFixtures(): void {
  fake.extra = (method, url, body) => {
    if (method === "POST" && url.pathname === "/mcp") {
      const payload = JSON.parse(body) as { method?: string };
      if (payload.method === "tools/call") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "colleague" }] } });
      }
      return undefined;
    }
    if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
      return Response.json({ code: 131005, msg: "not found" });
    }
    if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1") {
      return Response.json({ code: 0, data: { document: { document_id: "doxcn1", title: "Quarterly plan" } } });
    }
    if (method === "DELETE" && url.pathname === "/open-apis/drive/v1/files/doxcn1") {
      return Response.json({ code: 0, data: {} });
    }
    return undefined;
  };
}

async function exerciseConnector(): Promise<{ location: string; outbound: string[] }> {
  installToolFixtures();
  const session = await login();
  const proxied = await callTool(session.accessToken, "get_user", { user_id: "ou_ada" });
  expect(toolText(proxied.body)).toBe("colleague");
  const direct = await callTool(session.accessToken, "whoami");
  expect(toolText(direct.body)).toContain("open_id: ou_owner");
  const deleted = await callTool(session.accessToken, "delete_doc", { doc: "doxcn1", confirm_title: "Quarterly plan" });
  expect(toolText(deleted.body)).toBe("Moved to 云空间 回收站. It can be restored there.");
  await env.FEISHU_TOKENS.getByName("ou_owner").getAccess({ force: true });
  return { location: session.approved.feishu.toString(), outbound: fake.calls.map((call) => call.url) };
}

function expectLarksuiteOnly(urls: string[]): void {
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(hostOf(url).endsWith(".larksuite.com"), url).toBe(true);
    expect(url.includes("feishu.cn"), url).toBe(false);
  }
}

describe("FEISHU_REGION", () => {
  it("sends login, a proxied tool, a direct OpenAPI tool, and delete_doc to Lark", async () => {
    env.FEISHU_REGION = "lark";
    const { location, outbound } = await exerciseConnector();
    expect(hostOf(location)).toBe("accounts.larksuite.com");
    expect(location.includes("feishu.cn")).toBe(false);
    expectLarksuiteOnly(outbound);
    expect(outbound.some((url) => hostOf(url) === "accounts.larksuite.com" && url.includes("/oauth/v3/token"))).toBe(true);
    expect(outbound.some((url) => hostOf(url) === "mcp.larksuite.com" && new URL(url).pathname === "/mcp")).toBe(true);
    expect(outbound.some((url) => hostOf(url) === "open.larksuite.com" && url.includes("/open-apis/authen/v1/user_info"))).toBe(true);
    expect(outbound.some((url) => url === "https://open.larksuite.com/open-apis/drive/v1/files/doxcn1?type=docx")).toBe(true);
    const authorize = new URL(location);
    expect(authorize.pathname).toBe("/open-apis/authen/v1/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("cli_test");
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(fake.calls.some((call) => hostOf(call.url) === "accounts.larksuite.com" && call.body.includes("grant_type=refresh_token"))).toBe(true);
  });

  it("keeps the default region on feishu.cn and contacts no larksuite host", async () => {
    env.FEISHU_REGION = "feishu";
    const { location, outbound } = await exerciseConnector();
    expect(hostOf(location)).toBe("accounts.feishu.cn");
    expect(location.includes("larksuite.com")).toBe(false);
    expect(outbound.length).toBeGreaterThan(0);
    for (const url of outbound) {
      expect(hostOf(url).endsWith(".feishu.cn"), url).toBe(true);
      expect(url.includes("larksuite.com"), url).toBe(false);
    }
  });

  it("still refuses a non-allowlisted path under lark", async () => {
    env.FEISHU_REGION = "lark";
    expect(endpointAllowlist().some((line) => line.includes("larksuite"))).toBe(false);
    const fetchImpl = vi.fn(async () => new Response("nope"));
    const client = new FeishuClient({ fetchImpl });
    await expect(client.request("POST", "https://open.feishu.cn/open-apis/im/v1/messages", { body: "{}" })).rejects.toBeInstanceOf(EndpointNotAllowedError);
    await expect(client.request("GET", "https://open.larksuite.com/open-apis/authen/v1/user_info")).rejects.toBeInstanceOf(EndpointNotAllowedError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => rewriteUrlForRegion("https://example.feishu.cn/wiki/tok", "lark")).toThrow(/not mapped/);
  });

  it("fails closed on an invalid region before any upstream call", async () => {
    const logs = logLines();
    try {
      env.FEISHU_REGION = "intl";
      const before = fake.calls.length;
      const mcp = await workerFetch("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });
      const authorize = await workerFetch("/authorize");
      const callback = await workerFetch("/callback?code=auth-code&state=unused");
      for (const response of [mcp, authorize, callback]) {
        expect(response.status).toBe(503);
        expect(await response.text()).toBe("invalid FEISHU_REGION");
      }
      expect(fake.calls).toHaveLength(before);
      const events = logs.lines().filter((line) => line.includes('"event":"invalid_region"'));
      expect(events).toHaveLength(3);
    } finally {
      logs.restore();
    }
  });

  it("fails closed for every other region value", async () => {
    for (const value of ["", "Lark", "feishu ", "cn"]) {
      env.FEISHU_REGION = value;
      const before = fake.calls.length;
      const logs = logLines();
      try {
        const response = await workerFetch("/authorize");
        expect(response.status, value).toBe(503);
        expect(await response.text()).toBe("invalid FEISHU_REGION");
        expect(fake.calls).toHaveLength(before);
        expect(logs.lines().some((line) => line.includes('"event":"invalid_region"'))).toBe(true);
      } finally {
        logs.restore();
      }
    }
  });
});

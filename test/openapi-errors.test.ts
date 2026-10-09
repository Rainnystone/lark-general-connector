import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { callTool, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

interface ErrorCase {
  tool: string;
  args: Record<string, unknown>;
  backend?: string;
  pathname: string;
  body: { code: number; msg?: string };
  text: string;
}

const EVIDENCE: readonly ErrorCase[] = [
  {
    tool: "list_chat_messages",
    args: { chat_id: "oc_time" },
    pathname: "/open-apis/im/v1/messages",
    body: {
      code: 230001,
      msg: "Your request contains an invalid request parameter, ext=invalid start_time: 2026-09-01T00:00:00+08:00",
    },
    text: "Feishu error 230001: Your request contains an invalid request parameter, ext=invalid start_time: 2026-09-01T00:00:00+08:00 (invalid request parameter)",
  },
  {
    tool: "list_wiki_docs",
    args: { space_id: "space1" },
    backend: "list_wiki_docs",
    pathname: "/open-apis/wiki/v2/spaces/space1/nodes",
    body: { code: 131002, msg: "param err: invalid page_token" },
    text: "Feishu error 131002: param err: invalid page_token (invalid parameter)",
  },
  {
    tool: "fetch_doc",
    args: { doc: "doxcn1" },
    backend: "fetch_doc",
    pathname: "/open-apis/docx/v1/documents/doxcn1/raw_content",
    body: { code: 99992402, msg: "field validation failed" },
    text: "Feishu error 99992402: field validation failed (validation)",
  },
  {
    tool: "get_user",
    args: { user_id: "ou_botpeer" },
    backend: "get_user",
    pathname: "/open-apis/contact/v3/users/ou_botpeer",
    body: { code: 41050, msg: "no user authority error" },
    text: "Feishu error 41050: no user authority error (no user authority)",
  },
  {
    tool: "get_user",
    args: { user_id: "not-an-open-id", id_type: "open_id" },
    backend: "get_user",
    pathname: "/open-apis/contact/v3/users/not-an-open-id",
    body: {
      code: 99992351,
      msg: "The request you send is not a valid {open_id} or not exists. Invalid ids: [not-an-open-id] .",
    },
    text: "Feishu error 99992351: The request you send is not a valid {open_id} or not exists. Invalid ids: [not-an-open-id] . (invalid or nonexistent id)",
  },
  {
    tool: "get_user",
    args: { user_id: "ou_other", id_type: "union_id" },
    backend: "get_user",
    pathname: "/open-apis/contact/v3/users/ou_other",
    body: { code: 99992364, msg: "user id cross tenant" },
    text: "Feishu error 99992364: user id cross tenant (nonexistent or cross-tenant id)",
  },
  {
    tool: "fetch_doc",
    args: { doc: "shtcn1" },
    backend: "fetch_doc",
    pathname: "/open-apis/docx/v1/documents/shtcn1/raw_content",
    body: { code: 1770002, msg: "not found" },
    text: "Feishu error 1770002: not found",
  },
  {
    tool: "fetch_doc",
    args: { doc: "doxcnDeleted" },
    backend: "fetch_doc",
    pathname: "/open-apis/docx/v1/documents/doxcnDeleted/raw_content",
    body: { code: 1770003, msg: "resource deleted" },
    text: "Feishu error 1770003: resource deleted (deleted)",
  },
  {
    tool: "get_message",
    args: { message_id: "om_missing" },
    pathname: "/open-apis/im/v1/messages/om_missing",
    body: { code: 99992354, msg: "The request you send is not a valid open_message_id or not exists." },
    text: "Feishu error 99992354: The request you send is not a valid open_message_id or not exists.",
  },
];

describe("OpenAPI error text", () => {
  it("returns the Feishu code, scrubbed msg, and a hint for the audited codes", async () => {
    const { accessToken } = await login();
    for (const item of EVIDENCE) {
      env.TOOL_BACKENDS = item.backend ? JSON.stringify({ [item.backend]: "openapi" }) : "";
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === item.pathname) return Response.json(item.body);
        return undefined;
      };
      const logs = logLines();
      try {
        const response = await callTool(accessToken, item.tool, item.args);
        const text = toolText(response.body);
        expect(text, item.tool).toBe(item.text);
        expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
        const audited = logs.lines().join("\n");
        expect(audited).toContain(`"code":"${item.body.code}"`);
        if (item.body.msg) expect(audited).not.toContain(item.body.msg);
      } finally {
        logs.restore();
      }
    }
  });

  it("uses the hint when Feishu sends a code and no msg", async () => {
    const { accessToken } = await login();
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/shtcn1/raw_content") {
        return Response.json({ code: 1770002 });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "fetch_doc", { doc: "shtcn1" });
    expect(toolText(response.body)).toBe("Feishu error 1770002: not found");
  });

  it("scrubs secrets from the msg and keeps it to 200 characters", async () => {
    const { accessToken } = await login();
    const secret = "u-access-secret-value";
    const longId = "user_token_abcdefghij1234567890";
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1/raw_content") {
        return Response.json({
          code: 99992402,
          msg: `leak bearer ${secret} and https://open.feishu.cn/path?code=secret and ${longId}`,
        });
      }
      return undefined;
    };
    const scrubbed = await callTool(accessToken, "fetch_doc", { doc: "doxcn1" });
    const scrubbedText = toolText(scrubbed.body);
    expect(scrubbedText).toBe("Feishu error 99992402: leak bearer [redacted] and [url] and [redacted] (validation)");
    expect(scrubbedText).not.toContain(secret);
    expect(scrubbedText).not.toContain(longId);
    expect(scrubbedText).not.toContain("https://");

    const tail = "TAIL-MUST-NOT-APPEAR";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages/om_long") {
        return Response.json({ code: 99992354, msg: `${"bad parameter ".repeat(15)}${tail}` });
      }
      return undefined;
    };
    const capped = await callTool(accessToken, "get_message", { message_id: "om_long" });
    const cappedText = toolText(capped.body);
    const prefix = "Feishu error 99992354: ";
    expect(cappedText.startsWith(prefix)).toBe(true);
    expect(cappedText.slice(prefix.length)).toHaveLength(200);
    expect(cappedText).not.toContain(tail);
    expect(cappedText.endsWith("bad ")).toBe(true);

    const emoji = `${"a".repeat(19)} ${"a".repeat(19)} ${"a".repeat(19)} ${"a".repeat(19)} ${"a".repeat(19)} ${"a".repeat(19)} ${"a".repeat(19)} ${"a".repeat(19)} ${"a".repeat(19)} ${"a".repeat(19)}😀`;
    expect(Array.from(emoji)).toHaveLength(200);
    expect(emoji.length).toBe(201);
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages/om_emoji") {
        return Response.json({ code: 99992354, msg: emoji });
      }
      return undefined;
    };
    const emojiText = toolText((await callTool(accessToken, "get_message", { message_id: "om_emoji" })).body);
    expect(emojiText).toBe(`Feishu error 99992354: ${emoji}`);
    expect(emojiText.endsWith("😀")).toBe(true);

    const upperUrl = "HTTPS://host/path?token=short.secret";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcnUpper/raw_content") {
        return Response.json({ code: 99992402, msg: `see ${upperUrl} now` });
      }
      return undefined;
    };
    const upper = toolText((await callTool(accessToken, "fetch_doc", { doc: "doxcnUpper" })).body);
    expect(upper).toBe("Feishu error 99992402: see [url] now (validation)");
    expect(upper).not.toContain(upperUrl);
    expect(upper).not.toContain("short.secret");
  });

  it("keeps token-invalid and rate-limit handling, and shows a business code that has no msg", async () => {
    const { accessToken } = await login();
    const leaked = "token-invalid-msg-must-stay-hidden";
    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1/raw_content") {
        return Response.json({ code: 99991663, msg: leaked });
      }
      return undefined;
    };
    const invalid = await callTool(accessToken, "fetch_doc", { doc: "doxcn1" });
    expect(toolText(invalid.body)).toBe("Feishu request failed");
    expect(toolText(invalid.body)).not.toContain(leaked);

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
        return Response.json({ code: 230001, msg: "invalid start_time" }, { status: 429 });
      }
      return undefined;
    };
    const limited = await callTool(accessToken, "list_chat_messages", { chat_id: "oc_time" });
    expect(toolText(limited.body)).toBe("Feishu rate limit, retry shortly");
    expect(toolText(limited.body)).not.toContain("invalid start_time");

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/docx/v1/documents/doxcn1/raw_content") {
        return Response.json({ code: 500 });
      }
      return undefined;
    };
    const bare = await callTool(accessToken, "fetch_doc", { doc: "doxcn1" });
    expect(toolText(bare.body)).toBe("Feishu error 500");

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
        return Response.json({ code: 230002, msg: "raw feishu" });
      }
      return undefined;
    };
    const explained = await callTool(accessToken, "list_chat_messages", { chat_id: "oc_denied" });
    expect(toolText(explained.body)).toBe("The owner is not in this chat, so its messages cannot be read.");
    expect(toolText(explained.body)).not.toContain("raw feishu");

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
        return Response.json({
          code: 230001,
          msg: "Your request contains an invalid request parameter, ext=invalid container_id.",
        });
      }
      return undefined;
    };
    const parameter = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_bad" })).body);
    expect(parameter).toBe(
      "Feishu error 230001: Your request contains an invalid request parameter, ext=invalid container_id. (invalid request parameter)",
    );
    expect(parameter).not.toContain("bad time");

    env.TOOL_BACKENDS = JSON.stringify({ get_user: "openapi" });
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/on_missing") {
        return Response.json({ code: 99992364 });
      }
      return undefined;
    };
    const missingId = toolText((await callTool(accessToken, "get_user", { user_id: "on_missing", id_type: "union_id" })).body);
    expect(missingId).toBe("Feishu error 99992364: nonexistent or cross-tenant id");
    expect(missingId).not.toBe("Feishu error 99992364: cross-tenant id");

    env.TOOL_BACKENDS = JSON.stringify({ fetch_doc: "openapi" });
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        return Response.json({ code: 131002 });
      }
      return undefined;
    };
    const wikiNode = toolText((await callTool(accessToken, "fetch_doc", { doc: "https://example.feishu.cn/wiki/wikcnNODE" })).body);
    expect(wikiNode).toBe("Feishu error 131002: invalid parameter");
    expect(wikiNode).not.toContain("page_token");
    expect(wikiNode).not.toContain("page_size");
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MARKER } from "./fake-feishu";
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

describe("chat list and messages", () => {
  it("lists chat tools as read-only", async () => {
    const { accessToken } = await login();
    const before = fake.calls.length;
    const tools = await listTools(accessToken);
    expect(fake.calls).toHaveLength(before);

    const listed = (name: string) => {
      const tool = tools.find((entry) => entry.name === name);
      return {
        title: tool?.title,
        annotations: tool?.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean },
        schema: tool?.inputSchema as { properties?: Record<string, { enum?: string[] }>; required?: string[] },
      };
    };

    const chats = listed("list_chats");
    expect(chats.title).toBe("List my chats");
    expect(chats.annotations.readOnlyHint).toBe(true);
    expect(chats.annotations.destructiveHint).toBe(false);
    expect(chats.annotations.openWorldHint).toBe(true);
    expect(Object.keys(chats.schema.properties ?? {})).toEqual(["kind", "page_token"]);
    expect(chats.schema.required).toBeUndefined();
    expect(chats.schema.properties?.kind?.enum).toEqual(["all", "group", "p2p"]);

    const messages = listed("list_chat_messages");
    expect(messages.title).toBe("Read chat messages");
    expect(messages.annotations.readOnlyHint).toBe(true);
    expect(messages.annotations.destructiveHint).toBe(false);
    expect(messages.annotations.openWorldHint).toBe(true);
    expect(Object.keys(messages.schema.properties ?? {})).toEqual(["chat_id", "start_time", "end_time", "order", "page_token", "page_size"]);
    expect(messages.schema.required).toEqual(["chat_id"]);
    expect(messages.schema.properties?.order?.enum).toEqual(["asc", "desc"]);
  });

  it("lists group names and resolved p2p peer names", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({
          code: 0,
          data: {
            items: [
              { chat_id: "oc_group", chat_mode: "group", name: "Engineering", update_time: "1710000000" },
              { chat_id: "oc_p2p", chat_mode: "p2p", name: "", p2p_target_id: "ou_ada" },
            ],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      return undefined;
    };

    const before = fake.calls.length;
    const response = await callTool(accessToken, "list_chats", {});
    const chatCall = fake.calls.slice(before).find((call) => call.url.includes("/open-apis/im/v1/chats"));
    const chatUrl = new URL(chatCall?.url ?? "https://example.invalid/");
    expect(chatUrl.searchParams.get("types")).toBe("p2p,group");
    expect(chatUrl.searchParams.get("page_size")).toBe("100");
    const batch = fake.calls.slice(before).find((call) => call.url.includes("/open-apis/contact/v3/users/batch"));
    expect(new URL(batch?.url ?? "https://example.invalid/").searchParams.getAll("user_ids")).toEqual(["ou_ada"]);
    const text = toolText(response.body);
    expect(text).toContain("chat_id: oc_group");
    expect(text).toContain("kind: group");
    expect(text).toContain("name: Engineering");
    expect(text).not.toContain("last_activity");
    expect(text).toContain("chat_id: oc_p2p");
    expect(text).toContain("kind: p2p");
    expect(text).toContain("name: Ada Lovelace");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);

    const filteredBefore = fake.calls.length;
    const filtered = toolText((await callTool(accessToken, "list_chats", { kind: "p2p" })).body);
    const filteredCall = fake.calls.slice(filteredBefore).find((call) => call.url.includes("/open-apis/im/v1/chats"));
    expect(new URL(filteredCall?.url ?? "https://example.invalid/").searchParams.get("types")).toBe("p2p,group");
    expect(filtered).toContain("chat_id: oc_p2p");
    expect(filtered).toContain("name: Ada Lovelace");
    expect(filtered).not.toContain("oc_group");
    expect(filtered).not.toContain("Engineering");
  });

  it("returns groups and a note when Feishu rejects the types parameter", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/chats") return undefined;
      if (url.searchParams.has("types")) {
        return Response.json({ code: 99992402, msg: "field validation failed" });
      }
      return Response.json({
        code: 0,
        data: { items: [{ chat_id: "oc_group", name: "Engineering" }] },
      });
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "list_chats", {});
    const calls = fake.calls.slice(before).filter((call) => call.url.includes("/open-apis/im/v1/chats"));
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]?.url ?? "https://example.invalid/").searchParams.get("types")).toBe("p2p,group");
    expect(new URL(calls[1]?.url ?? "https://example.invalid/").searchParams.has("types")).toBe(false);
    const search = fake.calls.slice(before).find((call) => call.url.includes("/im/v1/messages/search"));
    expect(search?.method).toBe("POST");
    expect(JSON.parse(search?.body ?? "{}")).toEqual({ query: "", filter: { chat_type: "p2p" } });
    const text = toolText(response.body);
    expect(text).toContain("chat_id: oc_group");
    expect(text).toContain("kind: group");
    expect(text).toContain("name: Engineering");
    expect(text).toContain("p2p listing unavailable");
    expect(text).not.toContain("discovered_via: search");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("renders text and post messages and placeholders for image and file", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_text",
                msg_type: "text",
                create_time: "1710000000123",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: "hello from ada" }) },
              },
              {
                message_id: "om_post",
                msg_type: "post",
                create_time: "1710000000000",
                sender: { id: "ou_missing", id_type: "open_id", sender_type: "user" },
                body: {
                  content: JSON.stringify({
                    zh_cn: {
                      title: "Standup",
                      content: [
                        [
                          { tag: "text", text: "shipped " },
                          { tag: "a", text: "the notes", href: "https://example.com/notes" },
                        ],
                        [{ tag: "img", image_key: "img_secret" }],
                      ],
                    },
                  }),
                },
              },
              {
                message_id: "om_image",
                msg_type: "image",
                create_time: "1710000000000",
                sender: { id: "cli_bot", id_type: "app_id", sender_type: "app" },
                body: { content: JSON.stringify({ image_key: "img_only" }) },
              },
              {
                message_id: "om_file",
                msg_type: "file",
                create_time: "1710000000000",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ file_key: "file_secret", file_name: "report.pdf" }) },
              },
            ],
          },
        });
      }
      return undefined;
    };

    const before = fake.calls.length;
    const response = await callTool(accessToken, "list_chat_messages", {
      chat_id: "oc_group",
      start_time: "1700000000",
      end_time: "1720000000",
      order: "asc",
      page_size: 15,
    });
    const messageCall = fake.calls.slice(before).find((call) => call.url.includes("/open-apis/im/v1/messages"));
    const messageUrl = new URL(messageCall?.url ?? "https://example.invalid/");
    expect(messageUrl.searchParams.get("container_id_type")).toBe("chat");
    expect(messageUrl.searchParams.get("container_id")).toBe("oc_group");
    expect(messageUrl.searchParams.get("start_time")).toBe("1700000000");
    expect(messageUrl.searchParams.get("end_time")).toBe("1720000000");
    expect(messageUrl.searchParams.get("sort_type")).toBe("ByCreateTimeAsc");
    expect(messageUrl.searchParams.get("page_size")).toBe("15");
    const batchIds = fake.calls
      .slice(before)
      .filter((call) => call.url.includes("/open-apis/contact/v3/users/batch"))
      .flatMap((call) => new URL(call.url).searchParams.getAll("user_ids"));
    expect(batchIds).toContain("ou_ada");
    expect(batchIds).toContain("ou_missing");
    expect(batchIds).not.toContain("cli_bot");
    const text = toolText(response.body);
    expect(text).toContain("sender: Ada Lovelace\ntime: 2024-03-09T16:00:00+00:00\ntype: text\ntext: hello from ada");
    expect(text).toContain("sender: ou_missing\ntime: 2024-03-09T16:00:00+00:00\ntype: post\ntext: Standup\nshipped the notes (https://example.com/notes)\n[image]");
    expect(text).toContain("sender: bot cli_bot\ntime: 2024-03-09T16:00:00+00:00\ntype: image\ntext: [image]");
    expect(text).toContain("sender: Ada Lovelace\ntime: 2024-03-09T16:00:00+00:00\ntype: file\ntext: [file: report.pdf]");
    expect(text).not.toContain("img_secret");
    expect(text).not.toContain("img_only");
    expect(text).not.toContain("file_secret");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);

    const cappedBefore = fake.calls.length;
    await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group", page_size: 80 });
    const capped = fake.calls.slice(cappedBefore).find((call) => call.url.includes("/open-apis/im/v1/messages"));
    const cappedUrl = new URL(capped?.url ?? "https://example.invalid/");
    expect(cappedUrl.searchParams.get("sort_type")).toBe("ByCreateTimeDesc");
    expect(cappedUrl.searchParams.get("page_size")).toBe("50");
  });

  it("stops message history at the page cap and returns page_token", async () => {
    const { accessToken } = await login();
    let pages = 0;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/messages") return undefined;
      pages += 1;
      return Response.json({
        code: 0,
        data: {
          has_more: true,
          page_token: `cont-${pages}`,
          items: [
            {
              message_id: `om_${pages}`,
              msg_type: "text",
              create_time: "1710000000000",
              sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
              body: { content: JSON.stringify({ text: `page ${pages}` }) },
            },
          ],
        },
      });
    };
    const before = fake.calls.length;
    const response = await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group", page_size: 1 });
    const messageCalls = fake.calls.slice(before).filter((call) => call.url.includes("/open-apis/im/v1/messages"));
    expect(messageCalls).toHaveLength(10);
    expect(new URL(messageCalls[0]?.url ?? "https://example.invalid/").searchParams.has("page_token")).toBe(false);
    expect(new URL(messageCalls[9]?.url ?? "https://example.invalid/").searchParams.get("page_token")).toBe("cont-9");
    const text = toolText(response.body);
    expect(text).toContain("text: page 1");
    expect(text).toContain("text: page 10");
    expect(text).not.toContain("text: page 11");
    expect(text).toContain("page cap reached");
    expect(text).toContain("page_token: cont-10");
    expect(fake.calls.slice(before).length).toBeLessThanOrEqual(40);

    const continuedBefore = fake.calls.length;
    const continued = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group", page_token: "cont-10", page_size: 1 })).body);
    const continuedCall = fake.calls.slice(continuedBefore).find((call) => call.url.includes("/open-apis/im/v1/messages"));
    expect(new URL(continuedCall?.url ?? "https://example.invalid/").searchParams.get("page_token")).toBe("cont-10");
    expect(continued).toContain("text: page 11");
  });

  it("stops the chat list at the page cap and returns page_token", async () => {
    const { accessToken } = await login();
    let pages = 0;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/chats") return undefined;
      pages += 1;
      return Response.json({
        code: 0,
        data: {
          has_more: true,
          page_token: `chat-${pages}`,
          items: [
            { chat_id: `oc_group_${pages}`, chat_mode: "group", name: `Group ${pages}` },
            { chat_id: `oc_p2p_${pages}`, chat_mode: "p2p", p2p_target_id: "ou_ada" },
          ],
        },
      });
    };
    const before = fake.calls.length;
    const text = toolText((await callTool(accessToken, "list_chats", {})).body);
    const chatCalls = fake.calls.slice(before).filter((call) => call.url.includes("/open-apis/im/v1/chats"));
    expect(chatCalls).toHaveLength(10);
    for (const call of chatCalls) {
      const url = new URL(call.url);
      expect(url.searchParams.get("types")).toBe("p2p,group");
      expect(url.searchParams.get("page_size")).toBe("100");
    }
    expect(new URL(chatCalls[9]?.url ?? "https://example.invalid/").searchParams.get("page_token")).toBe("chat-9");
    expect(text).toContain("chat_id: oc_group_1");
    expect(text).toContain("name: Group 10");
    expect(text).toContain("chat_id: oc_p2p_1");
    expect(text).toContain("name: Ada Lovelace");
    expect(text).not.toContain("oc_group_11");
    expect(text).toContain("page cap reached");
    expect(text).toContain("page_token: p2pseen:chat-10");
    expect(fake.calls.slice(before).length).toBeLessThanOrEqual(40);
  });

  it("explains message errors 230002, 231204, and 230013", async () => {
    const { accessToken } = await login();
    const cases = [
      { code: 230002, text: "The owner is not in this chat, so its messages cannot be read." },
      { code: 231204, text: "This Feishu app has external sharing or associated organizations enabled, so messages cannot be read as the owner." },
      { code: 230013, text: "The other person is outside this app's availability, so this chat cannot be read." },
    ];
    for (const item of cases) {
      fake.extra = (method, url) => {
        if (method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
          return Response.json({ code: item.code, msg: "raw feishu" });
        }
        return undefined;
      };
      const logs = logLines();
      try {
        const response = await callTool(accessToken, "list_chat_messages", { chat_id: "oc_denied" });
        const text = toolText(response.body);
        expect(text).toBe(item.text);
        expect(text).not.toContain("raw feishu");
        expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
        expect(logs.lines().join("\n")).toContain(`"code":"${item.code}"`);
      } finally {
        logs.restore();
      }
    }
  });

  it("audits the chat id and leaves message text and chat names out of the log", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({
          code: 0,
          data: { items: [{ chat_id: "oc_audited", chat_mode: "group", name: MARKER }] },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: MARKER }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_secret",
                msg_type: "text",
                create_time: "1710000000000",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: MARKER }) },
              },
            ],
          },
        });
      }
      return undefined;
    };
    const logs = logLines();
    try {
      const listed = toolText((await callTool(accessToken, "list_chats", {})).body);
      const read = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_audited" })).body);
      expect(listed).toContain(`name: ${MARKER}`);
      expect(read).toContain(`text: ${MARKER}`);
      const joined = logs.lines().join("\n");
      expect(joined).toContain("oc_audited");
      expect(joined).not.toContain(MARKER);
    } finally {
      logs.restore();
    }
  });

  it("keeps auto and types_param on the types parameter when a p2p row is already listed", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({
          code: 0,
          data: { items: [{ chat_id: "oc_p2p", chat_mode: "p2p", p2p_target_id: "ou_ada" }] },
        });
      }
      return undefined;
    };
    for (const mode of ["", "auto", "types_param"]) {
      env.P2P_DISCOVERY = mode;
      const before = fake.calls.length;
      const text = toolText((await callTool(accessToken, "list_chats", {})).body);
      const calls = fake.calls.slice(before);
      expect(calls.some((call) => call.url.includes("/im/v1/messages/search"))).toBe(false);
      const chatCall = calls.find((call) => call.url.includes("/open-apis/im/v1/chats"));
      expect(new URL(chatCall?.url ?? "https://example.invalid/").searchParams.get("types")).toBe("p2p,group");
      expect(text).toContain("name: Ada Lovelace");
      expect(text).not.toContain("p2p listing unavailable");
    }
  });

  it("caps message text at 100000 characters and shows the open id when names fail", async () => {
    const { accessToken } = await login();
    const huge = "m".repeat(110_000);
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 99991672, msg: "no permission" });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({
          code: 0,
          data: { items: [{ chat_id: "oc_p2p", chat_mode: "p2p", p2p_target_id: "ou_ada" }] },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_big",
                msg_type: "text",
                create_time: "1710000000000",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: huge }) },
              },
            ],
          },
        });
      }
      return undefined;
    };
    const listed = toolText((await callTool(accessToken, "list_chats", { kind: "p2p" })).body);
    expect(listed).toContain("name: ou_ada");
    expect(listed).not.toContain("no permission");
    const text = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_p2p" })).body);
    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(text).toContain("[truncated; ask for the next page]");
    expect(text).toContain("sender: ou_ada");
    expect(text).not.toContain(huge);
  });

  it("replays omitted messages from the same page instead of skipping to the next token", async () => {
    const { accessToken } = await login();
    const chunk = "m".repeat(40_000);
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/messages") return undefined;
      if (url.searchParams.get("page_token") === "page-2") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_later",
                msg_type: "text",
                create_time: "1710000000000",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: "later-page" }) },
              },
            ],
          },
        });
      }
      return Response.json({
        code: 0,
        data: {
          has_more: true,
          page_token: "page-2",
          items: [1, 2, 3, 4].map((number) => ({
            message_id: `om_${number}`,
            msg_type: "text",
            create_time: "1710000000000",
            sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
            body: { content: JSON.stringify({ text: `${chunk}-${number}` }) },
          })),
        },
      });
    };
    const first = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group" })).body);
    expect(first.length).toBeLessThanOrEqual(100_000);
    expect(first).toContain(`${chunk}-1`);
    expect(first).not.toContain(`${chunk}-4`);
    expect(first).not.toContain("later-page");
    const token = first.match(/page_token: (\S+)/)?.[1];
    expect(token?.startsWith("rowcap:")).toBe(true);
    const before = fake.calls.length;
    const continued = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group", page_token: token })).body);
    const replay = fake.calls.slice(before).find((call) => call.url.includes("/open-apis/im/v1/messages"));
    expect(new URL(replay?.url ?? "https://example.invalid/").searchParams.has("page_token")).toBe(false);
    expect(continued).toContain(`${chunk}-3`);
    expect(continued).toContain(`${chunk}-4`);
  });

  it("refuses a garbled row cursor instead of repeating the first page", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/messages") return undefined;
      return Response.json({
        code: 0,
        data: {
          items: [
            {
              message_id: "om_first",
              msg_type: "text",
              create_time: "1710000000000",
              sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
              body: { content: JSON.stringify({ text: "first-page-text" }) },
            },
          ],
        },
      });
    };
    for (const pageToken of ["rowcap:", "rowcap:nope", "rowcap:1:0:rowcap:2:0:again"]) {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group", page_token: pageToken });
      const calls = fake.calls.slice(before).filter((call) => call.url.includes("/open-apis/im/v1/messages"));
      expect(calls).toHaveLength(0);
      expect(toolText(response.body)).toBe("invalid page_token");
      expect(toolText(response.body)).not.toContain("first-page-text");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    }
  });

  it("refuses a row cursor that would skip or jump past the fetched page", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/messages") return undefined;
      const token = url.searchParams.get("page_token");
      if (token === "page-2" || token === "500000:") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_later",
                msg_type: "text",
                create_time: "1710000000000",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: "should-not-appear" }) },
              },
            ],
          },
        });
      }
      return Response.json({
        code: 0,
        data: {
          has_more: true,
          page_token: "page-2",
          items: [1, 2].map((number) => ({
            message_id: `om_${number}`,
            msg_type: "text",
            create_time: "1710000000000",
            sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
            body: { content: JSON.stringify({ text: `kept-${number}` }) },
          })),
        },
      });
    };
    for (const pageToken of ["rowcap:50:", "rowcap:0:500000:"]) {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group", page_token: pageToken });
      const calls = fake.calls.slice(before).filter((call) => call.url.includes("/open-apis/im/v1/messages"));
      expect(calls.length).toBeLessThanOrEqual(1);
      expect(calls.some((call) => new URL(call.url).searchParams.get("page_token") === "page-2")).toBe(false);
      expect(toolText(response.body)).toBe("invalid page_token");
      expect(toolText(response.body)).not.toContain("should-not-appear");
      expect(toolText(response.body)).not.toContain("kept-1");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    }
  });

  it("returns the unread tail of a message cut by the output cap", async () => {
    const { accessToken } = await login();
    const huge = `${"m".repeat(110_000)}TAILMARKER`;
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/messages") return undefined;
      return Response.json({
        code: 0,
        data: {
          items: [
            {
              message_id: "om_big",
              msg_type: "text",
              create_time: "1710000000000",
              sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
              body: { content: JSON.stringify({ text: huge }) },
            },
          ],
        },
      });
    };
    const first = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group" })).body);
    expect(first.length).toBeLessThanOrEqual(100_000);
    expect(first).toContain("[truncated; ask for the next page]");
    expect(first).not.toContain("TAILMARKER");
    const token = first.match(/page_token: (\S+)/)?.[1];
    expect(token?.startsWith("rowcap:")).toBe(true);
    const before = fake.calls.length;
    const continued = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group", page_token: token })).body);
    const replay = fake.calls.slice(before).filter((call) => call.url.includes("/open-apis/im/v1/messages"));
    expect(replay).toHaveLength(1);
    expect(continued.length).toBeLessThanOrEqual(100_000);
    expect(continued).toContain("TAILMARKER");
    expect(continued).not.toContain("m".repeat(110_000));
  });

  it("converts message list times to unix seconds and rejects anything else", async () => {
    const { accessToken } = await login();
    const tools = await listTools(accessToken);
    const listed = tools.find((entry) => entry.name === "list_chat_messages");
    const schema = listed?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };
    expect(schema.properties?.start_time?.description).toContain("ISO 8601");
    expect(schema.properties?.start_time?.description).toContain("unix seconds");
    expect(schema.properties?.start_time?.description).toContain("timezone");
    expect(schema.properties?.end_time?.description).toContain("unix seconds");

    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/messages") return undefined;
      return Response.json({ code: 0, data: { items: [] } });
    };

    const isoBefore = fake.calls.length;
    const iso = await callTool(accessToken, "list_chat_messages", {
      chat_id: "oc_group",
      start_time: "2026-09-01T00:00:00+08:00",
      end_time: "1756656000",
    });
    const isoCall = fake.calls.slice(isoBefore).find((call) => call.url.includes("/open-apis/im/v1/messages"));
    const isoUrl = new URL(isoCall?.url ?? "https://example.invalid/");
    expect(isoUrl.searchParams.get("start_time")).toBe("1788192000");
    expect(isoUrl.searchParams.get("end_time")).toBe("1756656000");
    expect((iso.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);

    const msBefore = fake.calls.length;
    const ms = await callTool(accessToken, "list_chat_messages", {
      chat_id: "oc_group",
      start_time: "1756656000000",
    });
    expect(fake.calls.slice(msBefore).some((call) => call.url.includes("/open-apis/im/v1/messages"))).toBe(false);
    expect(toolText(ms.body)).toBe("start_time must be ISO 8601 or unix seconds");
    expect((ms.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);

    const slashBefore = fake.calls.length;
    const slash = await callTool(accessToken, "list_chat_messages", {
      chat_id: "oc_group",
      start_time: "09/01/2026",
    });
    expect(fake.calls.slice(slashBefore).some((call) => call.url.includes("/open-apis/im/v1/messages"))).toBe(false);
    expect(toolText(slash.body)).toBe("start_time must be ISO 8601 or unix seconds");

    const dateOnlyBefore = fake.calls.length;
    const dateOnly = await callTool(accessToken, "list_chat_messages", {
      chat_id: "oc_group",
      start_time: "2026-09-01",
    });
    expect(fake.calls.slice(dateOnlyBefore).some((call) => call.url.includes("/open-apis/im/v1/messages"))).toBe(false);
    expect(toolText(dateOnly.body)).toBe("start_time must be ISO 8601 or unix seconds");
    expect((dateOnly.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);

    const impossibleBefore = fake.calls.length;
    const impossible = await callTool(accessToken, "list_chat_messages", {
      chat_id: "oc_group",
      end_time: "2026-02-29T00:00:00Z",
    });
    expect(fake.calls.slice(impossibleBefore).some((call) => call.url.includes("/open-apis/im/v1/messages"))).toBe(false);
    expect(toolText(impossible.body)).toBe("end_time must be ISO 8601 or unix seconds");
    expect((impossible.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);

    const junkBefore = fake.calls.length;
    const junk = await callTool(accessToken, "list_chat_messages", {
      chat_id: "oc_group",
      end_time: "tomorrow",
    });
    expect(fake.calls.slice(junkBefore).some((call) => call.url.includes("/open-apis/im/v1/messages"))).toBe(false);
    expect(toolText(junk.body)).toBe("end_time must be ISO 8601 or unix seconds");
    expect((junk.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("prints message_id and any thread_id or parent_id", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_thread",
                thread_id: "omt_topic",
                parent_id: "om_parent",
                msg_type: "interactive",
                create_time: "1773198569042",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ title: "card" }) },
              },
              {
                message_id: "om_plain",
                msg_type: "text",
                create_time: "1773198569042",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({ text: "plain" }) },
              },
            ],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages/om_thread") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_thread",
                thread_id: "omt_topic",
                parent_id: "om_parent",
                msg_type: "interactive",
                create_time: "1773198569042",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                body: { content: JSON.stringify({}) },
              },
            ],
          },
        });
      }
      return undefined;
    };

    const listed = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_topic" })).body);
    expect(listed).toContain("message_id: om_thread\nthread_id: omt_topic\nparent_id: om_parent\n");
    expect(listed).toContain("type: interactive\ntext: [interactive]");
    expect(listed).toContain("message_id: om_plain\n");
    const plain = listed.slice(listed.indexOf("message_id: om_plain"));
    expect(plain).not.toContain("thread_id:");
    expect(plain).not.toContain("parent_id:");

    const one = toolText((await callTool(accessToken, "get_message", { message_id: "om_thread" })).body);
    expect(one).toContain("message_id: om_thread\nthread_id: omt_topic\nparent_id: om_parent\n");
  });

  it("uses the p2p chat name and peer type, and looks up a name only when it is empty", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({
          code: 0,
          data: {
            items: [
              { chat_id: "oc_bot", chat_mode: "p2p", name: "Feishu Assistant", p2p_target_id: "ou_bot", p2p_target_type: "bot" },
              { chat_id: "oc_ada", chat_mode: "p2p", name: "Ada Lovelace", p2p_target_id: "ou_ada", p2p_target_type: "user" },
              { chat_id: "oc_unnamed", chat_mode: "p2p", name: "", p2p_target_id: "ou_grace", p2p_target_type: "user" },
              { chat_id: "oc_group", chat_mode: "group", name: "Engineering" },
            ],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_grace", name: "Grace Hopper" }] } });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const text = toolText((await callTool(accessToken, "list_chats", {})).body);
    const batch = fake.calls.slice(before).filter((call) => call.url.includes("/open-apis/contact/v3/users/batch"));
    const ids = batch.flatMap((call) => new URL(call.url).searchParams.getAll("user_ids"));
    expect(ids).toEqual(["ou_grace"]);
    expect(text).toContain("chat_id: oc_bot\nkind: p2p\nname: Feishu Assistant\npeer_type: bot");
    expect(text).toContain("chat_id: oc_ada\nkind: p2p\nname: Ada Lovelace\npeer_type: user");
    expect(text).toContain("chat_id: oc_unnamed\nkind: p2p\nname: Grace Hopper\npeer_type: user");
    expect(text).toContain("chat_id: oc_group\nkind: group\nname: Engineering");
    expect(text).not.toContain("peer_type: \n");
    const group = text.slice(text.indexOf("chat_id: oc_group"));
    expect(group).not.toContain("peer_type:");
    expect(text).not.toContain("ou_bot");
    expect(text).not.toContain("ou_ada");
  });

  it("does not print last_activity", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/chats") return undefined;
      return Response.json({
        code: 0,
        data: {
          items: [
            { chat_id: "oc_group", chat_mode: "group", name: "Engineering", chat_status: "normal" },
            { chat_id: "oc_stale", chat_mode: "group", name: "Stale", update_time: "1710000000" },
          ],
        },
      });
    };
    const text = toolText((await callTool(accessToken, "list_chats", {})).body);
    expect(text).toContain("name: Engineering");
    expect(text).toContain("name: Stale");
    expect(text).not.toContain("last_activity");
  });

  it("keeps topic chats with groups", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/chats") return undefined;
      return Response.json({
        code: 0,
        data: {
          items: [
            { chat_id: "oc_group", chat_mode: "group", name: "Engineering" },
            { chat_id: "oc_topic", chat_mode: "topic", name: "Coding Agents" },
            { chat_id: "oc_p2p", chat_mode: "p2p", name: "Ada Lovelace", p2p_target_id: "ou_ada", p2p_target_type: "user" },
          ],
        },
      });
    };
    const grouped = toolText((await callTool(accessToken, "list_chats", { kind: "group" })).body);
    expect(grouped).toContain("chat_id: oc_group\nkind: group\nname: Engineering");
    expect(grouped).toContain("chat_id: oc_topic\nkind: topic\nname: Coding Agents");
    expect(grouped).not.toContain("oc_p2p");

    fake.extra = (method, url) => {
      if (method !== "GET" || url.pathname !== "/open-apis/im/v1/chats") return undefined;
      if (url.searchParams.has("types")) return Response.json({ code: 99992402, msg: "field validation failed" });
      return Response.json({
        code: 0,
        data: {
          items: [
            { chat_id: "oc_group", chat_mode: "group", name: "Engineering" },
            { chat_id: "oc_topic", chat_mode: "topic", name: "Coding Agents" },
            { chat_id: "oc_p2p", chat_mode: "p2p", name: "Ada Lovelace", p2p_target_id: "ou_ada" },
          ],
        },
      });
    };
    const fallback = toolText((await callTool(accessToken, "list_chats", {})).body);
    expect(fallback).toContain("chat_id: oc_topic\nkind: topic\nname: Coding Agents");
    expect(fallback).toContain("chat_id: oc_group\nkind: group\nname: Engineering");
    expect(fallback).not.toContain("oc_p2p");
  });

  it("replaces mention placeholders with @name", async () => {
    const { accessToken } = await login();
    const mentions = [
      { key: "@_user_1", name: "Ada", id: "ou_ada", id_type: "open_id" },
      { key: "@_user_10", name: "Grace", id: "ou_grace", id_type: "open_id" },
    ];
    const textBody = JSON.stringify({ text: "hello @_user_1 and @_user_10" });
    const postBody = JSON.stringify({
      zh_cn: { title: "Note", content: [[{ tag: "text", text: "cc @_user_1" }]] },
    });
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_mention",
                msg_type: "text",
                create_time: "1773198569042",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                mentions,
                body: { content: textBody },
              },
              {
                message_id: "om_post_mention",
                msg_type: "post",
                create_time: "1773198569042",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                mentions,
                body: { content: postBody },
              },
            ],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages/om_mention") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_mention",
                msg_type: "text",
                create_time: "1773198569042",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                mentions,
                body: { content: textBody },
              },
            ],
          },
        });
      }
      return undefined;
    };
    const listed = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group" })).body);
    expect(listed).toContain("text: hello @Ada and @Grace");
    expect(listed).not.toContain("@_user_");
    expect(listed).toContain("text: Note\ncc @Ada");
    const one = toolText((await callTool(accessToken, "get_message", { message_id: "om_mention" })).body);
    expect(one).toContain("text: hello @Ada and @Grace");
    expect(one).not.toContain("@_user_");
  });

  it("labels an app sender as a bot", async () => {
    const { accessToken } = await login();
    const bot = {
      message_id: "om_bot",
      msg_type: "interactive",
      create_time: "1773198569042",
      sender: { id: "cli_bot", id_type: "app_id", sender_type: "app" },
      body: { content: JSON.stringify({ title: "card" }) },
    };
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages") {
        return Response.json({ code: 0, data: { items: [bot] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages/om_bot") {
        return Response.json({ code: 0, data: { items: [bot] } });
      }
      return undefined;
    };
    const listed = toolText((await callTool(accessToken, "list_chat_messages", { chat_id: "oc_group" })).body);
    expect(listed).toContain("sender: bot cli_bot");
    expect(listed).not.toContain("sender: cli_bot\n");
    const one = toolText((await callTool(accessToken, "get_message", { message_id: "om_bot" })).body);
    expect(one).toContain("sender: bot cli_bot");
  });
});

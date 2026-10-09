import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MARKER } from "./fake-feishu";
import { callTool, listTools, logLines, login, toolText, useFakeFeishu } from "./support";

const fake = useFakeFeishu();

describe("message search and p2p fallback", () => {
  it("searches with every filter and returns the snippet without logging the query", async () => {
    const { accessToken } = await login();
    const tools = await listTools(accessToken);
    const listed = tools.find((entry) => entry.name === "search_messages");
    const annotations = listed?.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
    expect(listed?.title).toBe("Search my messages");
    expect(annotations.readOnlyHint).toBe(true);
    expect(annotations.destructiveHint).toBe(false);
    expect(annotations.openWorldHint).toBe(true);

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({
          code: 0,
          data: {
            total: 2,
            has_more: true,
            page_token: "search-next",
            items: [
              {
                meta_data: {
                  message_id: "om_hit",
                  chat_id: "oc_p2p",
                  from_id: "ou_ada",
                  create_time: "1710000000000",
                  is_p2p_chat: true,
                  type: "text",
                },
                display_info: "plain snippet",
              },
            ],
          },
        });
      }
      return undefined;
    };

    const logs = logLines();
    try {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "search_messages", {
        query: MARKER,
        chat_ids: ["oc_group", "oc_p2p"],
        from_ids: ["ou_ada"],
        chat_type: "p2p",
        start_time: "2024-03-01T00:00:00+08:00",
        end_time: "2024-03-10T00:00:00+08:00",
        is_at_me: true,
        page_token: "search-page",
        page_size: 30,
      });
      const search = fake.calls.slice(before).find((call) => call.url.includes("/open-apis/im/v1/messages/search"));
      const searchUrl = new URL(search?.url ?? "https://example.invalid/");
      expect(search?.method).toBe("POST");
      expect(searchUrl.searchParams.get("page_size")).toBe("30");
      expect(searchUrl.searchParams.get("page_token")).toBe("search-page");
      expect(JSON.parse(search?.body ?? "{}")).toEqual({
        query: MARKER,
        filter: {
          chat_ids: ["oc_group", "oc_p2p"],
          from_ids: ["ou_ada"],
          chat_type: "p2p",
          is_at_me: true,
          time_range: {
            start_time: "2024-03-01T00:00:00+08:00",
            end_time: "2024-03-10T00:00:00+08:00",
          },
        },
      });
      const text = toolText(response.body);
      expect(text).toContain("message_id: om_hit");
      expect(text).toContain("chat_id: oc_p2p");
      expect(text).toContain("is_p2p_chat: true");
      expect(text).toContain("sender: Ada Lovelace");
      expect(text).toContain("time: 2024-03-09T16:00:00+00:00");
      expect(text).toContain("type: text");
      expect(text).toContain("snippet: plain snippet");
      expect(text).toContain("page cap reached");
      expect(text).toContain("total: 2");
      expect(text).toContain("page_token: search-next");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
      const joined = logs.lines().join("\n");
      expect(joined).toContain("om_hit");
      expect(joined).not.toContain(MARKER);
    } finally {
      logs.restore();
    }
  });

  it("explains the message search rate limit", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({ code: 99991400, msg: "frequency limit" }, { status: 400 });
      }
      return undefined;
    };
    const response = await callTool(accessToken, "search_messages", { query: "weekly", page_size: 99 });
    const search = fake.calls.filter((call) => call.url.includes("/open-apis/im/v1/messages/search")).at(-1);
    expect(new URL(search?.url ?? "https://example.invalid/").searchParams.get("page_size")).toBe("30");
    const text = toolText(response.body);
    expect(text).toBe("Message search is limited to 100 requests per minute. Retry shortly.");
    expect(text).not.toContain("frequency limit");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
  });

  it("reads one post message by id", async () => {
    const { accessToken } = await login();
    const tools = await listTools(accessToken);
    const listed = tools.find((entry) => entry.name === "get_message");
    const annotations = listed?.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
    expect(listed?.title).toBe("Read one message");
    expect(annotations.readOnlyHint).toBe(true);
    expect(annotations.destructiveHint).toBe(false);
    expect(annotations.openWorldHint).toBe(true);
    const schema = listed?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {})).toEqual(["message_id"]);
    expect(schema.required).toEqual(["message_id"]);

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/messages/om_post") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_post",
                msg_type: "post",
                create_time: "1710000000000",
                sender: { id: "ou_ada", id_type: "open_id", sender_type: "user" },
                body: {
                  content: JSON.stringify({
                    zh_cn: {
                      title: "Standup",
                      content: [[{ tag: "text", text: "shipped " }, { tag: "a", text: "the notes", href: "https://example.com/notes" }]],
                    },
                  }),
                },
              },
            ],
          },
        });
      }
      return undefined;
    };

    const logs = logLines();
    try {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "get_message", { message_id: "om_post" });
      const read = fake.calls.slice(before).find((call) => call.method === "GET" && call.url.includes("/open-apis/im/v1/messages/om_post"));
      expect(new URL(read?.url ?? "https://example.invalid/").pathname).toBe("/open-apis/im/v1/messages/om_post");
      const text = toolText(response.body);
      expect(text).toContain("sender: Ada Lovelace");
      expect(text).toContain("time: 2024-03-09T16:00:00+00:00");
      expect(text).toContain("type: post");
      expect(text).toContain("Standup");
      expect(text).toContain("shipped the notes (https://example.com/notes)");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
      const joined = logs.lines().join("\n");
      expect(joined).toContain('"tool":"get_message"');
      expect(joined).toContain('"target":"om_post"');
      expect(joined).not.toContain("Standup");
    } finally {
      logs.restore();
    }
  });

  it("discovers p2p chats by search when listing with types fails", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "auto";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        if (url.searchParams.has("types")) return Response.json({ code: 99992402, msg: "field validation failed" });
        return Response.json({ code: 0, data: { items: [{ chat_id: "oc_group", chat_mode: "group", name: "Engineering" }] } });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                meta_data: { message_id: "om_owner", chat_id: "oc_p2p", from_id: "ou_owner", is_p2p_chat: true },
                display_info: "from the owner",
              },
              {
                meta_data: { message_id: "om_ada", chat_id: "oc_p2p", from_id: "ou_ada", is_p2p_chat: true },
                display_info: "from ada",
              },
            ],
          },
        });
      }
      return undefined;
    };

    const before = fake.calls.length;
    const response = await callTool(accessToken, "list_chats", {});
    const calls = fake.calls.slice(before);
    const search = calls.find((call) => call.url.includes("/open-apis/im/v1/messages/search"));
    const searchUrl = new URL(search?.url ?? "https://example.invalid/");
    expect(search?.method).toBe("POST");
    expect(searchUrl.searchParams.get("page_size")).toBe("30");
    expect(JSON.parse(search?.body ?? "{}")).toEqual({ query: "", filter: { chat_type: "p2p" } });
    const text = toolText(response.body);
    expect(text).toContain("chat_id: oc_group");
    expect(text).toContain("name: Engineering");
    expect(text).toContain("chat_id: oc_p2p");
    expect(text).toContain("kind: p2p");
    expect(text).toContain("name: Ada Lovelace");
    expect(text).toContain("discovered_via: search");
    expect(text).toContain("only chats with searchable messages");
    expect(text).not.toContain("from the owner");
    expect(text).not.toContain("from ada");
    expect((response.body as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
  });

  it("does not label a p2p chat with the owner when every search hit is theirs", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "auto";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_owner", name: "Owner Person" }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({
          code: 0,
          data: { has_more: false, items: [{ chat_id: "oc_group", chat_mode: "group", name: "Engineering" }] },
        });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({
          code: 0,
          data: {
            items: [{ meta_data: { message_id: "om_owner", chat_id: "oc_secret", from_id: "ou_owner", is_p2p_chat: true } }],
          },
        });
      }
      return undefined;
    };
    const text = toolText((await callTool(accessToken, "list_chats", {})).body);
    expect(text).toContain("chat_id: oc_group");
    expect(text).toContain("chat_id: oc_secret");
    expect(text).toContain("kind: p2p");
    expect(text).toContain("discovered_via: search");
    expect(text).not.toContain("ou_owner");
    expect(text).not.toContain("Owner Person");
  });

  it("searches when a complete chat listing has no p2p row and skips search when one is present", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "auto";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({
          code: 0,
          data: { has_more: false, items: [{ chat_id: "oc_group", chat_mode: "group", name: "Engineering" }] },
        });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                meta_data: { message_id: "om_ada", chat_id: "oc_found", from_id: "ou_ada", is_p2p_chat: true },
                display_info: "hidden snippet",
              },
            ],
          },
        });
      }
      return undefined;
    };

    const missingBefore = fake.calls.length;
    const missing = toolText((await callTool(accessToken, "list_chats", {})).body);
    const missingCalls = fake.calls.slice(missingBefore);
    expect(missingCalls.some((call) => call.url.includes("/im/v1/messages/search"))).toBe(true);
    expect(missing).toContain("chat_id: oc_group");
    expect(missing).toContain("chat_id: oc_found");
    expect(missing).toContain("discovered_via: search");
    expect(missing).toContain("name: Ada Lovelace");
    expect(missing).toContain("only chats with searchable messages");
    expect(missing).not.toContain("hidden snippet");

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({
          code: 0,
          data: {
            items: [
              { chat_id: "oc_group", chat_mode: "group", name: "Engineering" },
              { chat_id: "oc_p2p", chat_mode: "p2p", p2p_target_id: "ou_ada" },
            ],
          },
        });
      }
      return undefined;
    };
    const presentBefore = fake.calls.length;
    const present = toolText((await callTool(accessToken, "list_chats", {})).body);
    expect(fake.calls.slice(presentBefore).some((call) => call.url.includes("/im/v1/messages/search"))).toBe(false);
    expect(present).toContain("chat_id: oc_p2p");
    expect(present).toContain("name: Ada Lovelace");
    expect(present).not.toContain("discovered_via");
  });

  it("keeps types_param off search and never sends types in search mode", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        if (url.searchParams.has("types")) return Response.json({ code: 99992402, msg: "field validation failed" });
        return Response.json({ code: 0, data: { items: [{ chat_id: "oc_group", name: "Engineering" }] } });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({
          code: 0,
          data: {
            items: [{ meta_data: { message_id: "om_ada", chat_id: "oc_direct", from_id: "ou_ada", is_p2p_chat: true } }],
          },
        });
      }
      return undefined;
    };

    env.P2P_DISCOVERY = "types_param";
    const typesBefore = fake.calls.length;
    const typesText = toolText((await callTool(accessToken, "list_chats", {})).body);
    const typesCalls = fake.calls.slice(typesBefore);
    expect(typesCalls.some((call) => call.url.includes("/im/v1/messages/search"))).toBe(false);
    const typed = typesCalls.find((call) => call.url.includes("/open-apis/im/v1/chats"));
    expect(new URL(typed?.url ?? "https://example.invalid/").searchParams.get("types")).toBe("p2p,group");
    expect(typesText).toContain("p2p listing unavailable");
    expect(typesText).not.toContain("oc_direct");

    env.P2P_DISCOVERY = "search";
    const searchBefore = fake.calls.length;
    const searchText = toolText((await callTool(accessToken, "list_chats", {})).body);
    const searchCalls = fake.calls.slice(searchBefore);
    expect(searchCalls.some((call) => new URL(call.url).searchParams.has("types"))).toBe(false);
    expect(searchCalls.some((call) => call.url.includes("/im/v1/messages/search"))).toBe(true);
    expect(searchText).toContain("chat_id: oc_direct");
    expect(searchText).toContain("discovered_via: search");
    expect(searchText).toContain("name: Ada Lovelace");
    expect(searchText).toContain("only chats with searchable messages");
  });

  it("stops fallback search at five pages and continues from the returned page token", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "search";
    let pages = 0;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        pages += 1;
        return Response.json({
          code: 0,
          data: {
            has_more: true,
            page_token: `more-${pages}`,
            items: [{ meta_data: { message_id: `om_${pages}`, chat_id: `oc_${pages}`, from_id: "ou_ada", is_p2p_chat: true } }],
          },
        });
      }
      return undefined;
    };

    const before = fake.calls.length;
    const text = toolText((await callTool(accessToken, "list_chats", {})).body);
    const searches = fake.calls.slice(before).filter((call) => call.url.includes("/im/v1/messages/search"));
    expect(searches).toHaveLength(5);
    expect(new URL(searches[0]?.url ?? "https://example.invalid/").searchParams.has("page_token")).toBe(false);
    expect(new URL(searches[4]?.url ?? "https://example.invalid/").searchParams.get("page_token")).toBe("more-4");
    expect(text).toContain("chat_id: oc_1");
    expect(text).toContain("chat_id: oc_5");
    expect(text).not.toContain("chat_id: oc_6");
    expect(text).toContain("page cap reached");
    expect(text).toContain("page_token: more-5");
    expect(text).toContain("only chats with searchable messages");
    expect(fake.calls.slice(before).length).toBeLessThanOrEqual(40);

    const continuedBefore = fake.calls.length;
    const continued = toolText((await callTool(accessToken, "list_chats", { page_token: "more-5" })).body);
    const continuedSearch = fake.calls.slice(continuedBefore).find((call) => call.url.includes("/im/v1/messages/search"));
    expect(new URL(continuedSearch?.url ?? "https://example.invalid/").searchParams.get("page_token")).toBe("more-5");
    expect(continued).toContain("chat_id: oc_6");
    expect(fake.calls.slice(continuedBefore).length).toBeLessThanOrEqual(40);
  });

  it("does not search in types_param even when the page token is a search cursor", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "types_param";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({ code: 0, data: { items: [{ chat_id: "oc_group", chat_mode: "group", name: "Engineering" }] } });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const text = toolText((await callTool(accessToken, "list_chats", { page_token: "p2psearch:more-5" })).body);
    expect(fake.calls.slice(before).some((call) => call.url.includes("/im/v1/messages/search"))).toBe(false);
    const chat = fake.calls.slice(before).find((call) => call.url.includes("/open-apis/im/v1/chats"));
    expect(new URL(chat?.url ?? "https://example.invalid/").searchParams.get("page_token")).toBe("p2psearch:more-5");
    expect(text).toContain("chat_id: oc_group");
  });

  it("searches after the chat list fails and keeps the incompleteness note when search fails", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "auto";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") return Response.json({ code: 99992402, msg: "field validation failed" });
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({
          code: 0,
          data: { items: [{ meta_data: { message_id: "om_ada", chat_id: "oc_direct", from_id: "ou_ada", is_p2p_chat: true } }] },
        });
      }
      return undefined;
    };
    const failedBefore = fake.calls.length;
    const failed = toolText((await callTool(accessToken, "list_chats", {})).body);
    expect(fake.calls.slice(failedBefore).some((call) => call.url.includes("/im/v1/messages/search"))).toBe(true);
    expect(failed).toContain("chat_id: oc_direct");
    expect(failed).toContain("discovered_via: search");
    expect(failed).not.toContain("field validation failed");

    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({ code: 0, data: { items: [{ chat_id: "oc_group", chat_mode: "group", name: "Engineering" }] } });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({ code: 99991400, msg: "frequency limit" }, { status: 400 });
      }
      return undefined;
    };
    const limited = toolText((await callTool(accessToken, "list_chats", {})).body);
    expect(limited).toContain("chat_id: oc_group");
    expect(limited).toContain("only chats with searchable messages");
    expect(limited).toContain("Message search is limited to 100 requests per minute.");
    expect(limited).not.toContain("frequency limit");
  });

  it("does not search for p2p chats when the requested kind is group", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        if (url.searchParams.has("types")) return Response.json({ code: 99992402, msg: "field validation failed" });
        return Response.json({
          code: 0,
          data: { has_more: false, items: [{ chat_id: "oc_group", chat_mode: "group", name: "Engineering" }] },
        });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({ code: 0, data: { items: [] } });
      }
      return undefined;
    };

    env.P2P_DISCOVERY = "auto";
    const before = fake.calls.length;
    const text = toolText((await callTool(accessToken, "list_chats", { kind: "group" })).body);
    const calls = fake.calls.slice(before);
    expect(calls.some((call) => call.url.includes("/im/v1/messages/search"))).toBe(false);
    expect(text).toContain("chat_id: oc_group");
    expect(text).toContain("name: Engineering");

    env.P2P_DISCOVERY = "search";
    const searchBefore = fake.calls.length;
    const searched = toolText((await callTool(accessToken, "list_chats", { kind: "group" })).body);
    expect(fake.calls.slice(searchBefore).some((call) => call.url.includes("/im/v1/messages/search"))).toBe(false);
    expect(searched).toBe("no chats");
  });

  it("defers p2p search until a types fallback finishes listing groups", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "auto";
    let chatPages = 0;
    let searchPages = 0;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        if (url.searchParams.has("types")) return Response.json({ code: 99992402, msg: "field validation failed" });
        chatPages += 1;
        const finished = chatPages >= 11;
        return Response.json({
          code: 0,
          data: {
            has_more: !finished,
            ...(finished ? {} : { page_token: `chat-${chatPages}` }),
            items: [{ chat_id: `oc_group_${chatPages}`, name: `Group ${chatPages}` }],
          },
        });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        searchPages += 1;
        return Response.json({
          code: 0,
          data: {
            has_more: true,
            page_token: `more-${searchPages}`,
            items: [{ meta_data: { message_id: `om_${searchPages}`, chat_id: `oc_${searchPages}`, from_id: "ou_ada", is_p2p_chat: true } }],
          },
        });
      }
      return undefined;
    };
    const before = fake.calls.length;
    const text = toolText((await callTool(accessToken, "list_chats", {})).body);
    const calls = fake.calls.slice(before);
    expect(calls.filter((call) => call.url.includes("/open-apis/im/v1/chats"))).toHaveLength(11);
    expect(calls.filter((call) => call.url.includes("/im/v1/messages/search"))).toHaveLength(0);
    expect(text).toContain("page_token: chat-10");
    expect(text).not.toContain("p2psearch:");
    expect(text).toContain("chat_id: oc_group_10");
    expect(text).not.toContain("chat_id: oc_1");
    expect(text.match(/page cap reached/g)).toHaveLength(1);
    expect(calls.length).toBeLessThanOrEqual(40);

    const continuedBefore = fake.calls.length;
    const continued = toolText((await callTool(accessToken, "list_chats", { page_token: "chat-10" })).body);
    const continuedCalls = fake.calls.slice(continuedBefore);
    expect(continuedCalls.filter((call) => call.url.includes("/im/v1/messages/search"))).toHaveLength(5);
    expect(continued).toContain("chat_id: oc_group_11");
    expect(continued).toContain("chat_id: oc_1");
    expect(continued).toContain("chat_id: oc_5");
    expect(continued).not.toContain("chat_id: oc_6");
    expect(continued).toContain("page_token: p2psearch:more-5");
    expect(continued).not.toContain("page_token: chat-");
    expect(continued.match(/page cap reached/g)).toHaveLength(1);
    expect(continuedCalls.length).toBeLessThanOrEqual(40);
  });

  it("does not search again when a continuation already listed p2p chats", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "auto";
    let chatPages = 0;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        chatPages += 1;
        const finished = chatPages >= 11;
        const items: Array<{ chat_id: string; chat_mode: string; name: string }> = [
          { chat_id: `oc_group_${chatPages}`, chat_mode: "group", name: `Group ${chatPages}` },
        ];
        if (chatPages === 1) items.unshift({ chat_id: "oc_p2p_1", chat_mode: "p2p", name: "Ada" });
        return Response.json({
          code: 0,
          data: {
            has_more: !finished,
            ...(finished ? {} : { page_token: `chat-${chatPages}` }),
            items,
          },
        });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({
          code: 0,
          data: { items: [{ meta_data: { message_id: "om_again", chat_id: "oc_again", from_id: "ou_ada", is_p2p_chat: true } }] },
        });
      }
      return undefined;
    };
    const first = toolText((await callTool(accessToken, "list_chats", {})).body);
    expect(first).toContain("chat_id: oc_p2p_1");
    expect(first).toContain("page_token: p2pseen:chat-10");
    expect(first).not.toContain("discovered_via: search");
    const before = fake.calls.length;
    const continued = toolText((await callTool(accessToken, "list_chats", { page_token: "p2pseen:chat-10" })).body);
    const calls = fake.calls.slice(before);
    const chatCall = calls.find((call) => call.url.includes("/open-apis/im/v1/chats"));
    expect(new URL(chatCall?.url ?? "https://example.invalid/").searchParams.get("page_token")).toBe("chat-10");
    expect(calls.some((call) => call.url.includes("/im/v1/messages/search"))).toBe(false);
    expect(continued).toContain("chat_id: oc_group_11");
    expect(continued).not.toContain("chat_id: oc_again");
    expect(continued).not.toContain("discovered_via: search");
  });

  it("resumes p2p search by the unfiltered discovered order when a primary chat overlaps", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "auto";
    const big1 = "B".repeat(60_000);
    const big2 = "C".repeat(60_000);
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({
          code: 0,
          data: {
            items: [
              { open_id: "ou_ada", name: "Ada Lovelace" },
              { open_id: "ou_big1", name: big1 },
              { open_id: "ou_big2", name: big2 },
            ],
          },
        });
      }
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        if (url.searchParams.get("page_token") === "chat-next") return Response.json({ code: 1, msg: "list failed" });
        return Response.json({
          code: 0,
          data: {
            has_more: true,
            page_token: "chat-next",
            items: [
              { chat_id: "oc_shared", chat_mode: "p2p", p2p_target_id: "ou_ada" },
              { chat_id: "oc_group", chat_mode: "group", name: "Engineering" },
            ],
          },
        });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({
          code: 0,
          data: {
            items: [
              { meta_data: { message_id: "om_shared", chat_id: "oc_shared", from_id: "ou_ada", is_p2p_chat: true } },
              { meta_data: { message_id: "om_big1", chat_id: "oc_big1", from_id: "ou_big1", is_p2p_chat: true } },
              { meta_data: { message_id: "om_big2", chat_id: "oc_big2", from_id: "ou_big2", is_p2p_chat: true } },
            ],
          },
        });
      }
      return undefined;
    };

    const first = toolText((await callTool(accessToken, "list_chats", {})).body);
    expect(first).toContain("chat_id: oc_shared");
    expect(first).toContain("chat_id: oc_group");
    expect(first).toContain("chat_id: oc_big1");
    expect(first).not.toContain("chat_id: oc_big2");
    expect(first).toContain("page_token: rowcap:2:p2psearch:");
    const continued = toolText((await callTool(accessToken, "list_chats", { page_token: "rowcap:2:p2psearch:" })).body);
    expect(continued).toContain("chat_id: oc_big2");
    expect(continued).toContain(big2);
    expect(continued).not.toContain("chat_id: oc_big1");
    expect(continued).not.toContain("chat_id: oc_shared");
    expect(continued).not.toContain(big1);
  });

  it("refuses a forged p2pseen cursor instead of restarting discovery", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "auto";
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({
          code: 0,
          data: { items: [{ chat_id: "oc_group", chat_mode: "group", name: "Engineering" }] },
        });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({
          code: 0,
          data: { items: [{ meta_data: { message_id: "om_again", chat_id: "oc_again", from_id: "ou_ada", is_p2p_chat: true } }] },
        });
      }
      return undefined;
    };
    for (const pageToken of ["p2pseen:", "p2pseen:p2pseen:chat-10", "p2pseen:rowcap:1:0:chat-10"]) {
      const before = fake.calls.length;
      const response = await callTool(accessToken, "list_chats", { page_token: pageToken });
      const calls = fake.calls.slice(before);
      expect(calls.some((call) => call.url.includes("/open-apis/im/v1/chats"))).toBe(false);
      expect(calls.some((call) => call.url.includes("/im/v1/messages/search"))).toBe(false);
      expect(toolText(response.body)).toBe("invalid page_token");
      expect(toolText(response.body)).not.toContain("oc_group");
      expect(toolText(response.body)).not.toContain("oc_again");
      expect((response.body as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    }
  });

  it("keeps the last chat recoverable when the search note meets the output cap", async () => {
    const { accessToken } = await login();
    env.P2P_DISCOVERY = "auto";
    const header = "chat_id: oc_last\nkind: group\nname: ";
    const name = `${"n".repeat(99_950 - header.length - "UNIQUE_END".length)}UNIQUE_END`;
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") {
        return Response.json({
          code: 0,
          data: { has_more: false, items: [{ chat_id: "oc_last", chat_mode: "group", name }] },
        });
      }
      if (method === "POST" && url.pathname === "/open-apis/im/v1/messages/search") {
        return Response.json({ code: 0, data: { items: [] } });
      }
      return undefined;
    };
    const first = toolText((await callTool(accessToken, "list_chats", {})).body);
    expect(first.length).toBeLessThanOrEqual(100_000);
    const token = first.match(/page_token: (\S+)/)?.[1];
    const continued = token
      ? toolText((await callTool(accessToken, "list_chats", { page_token: token })).body)
      : "";
    expect(`${first}\n${continued}`).toContain("UNIQUE_END");
    expect(continued.length).toBeLessThanOrEqual(100_000);
    if (token) expect(token).not.toBe("p2pseen:");
  });

  it("does not drop a search hit to make room for a non-continuation token", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method === "GET" && url.pathname === "/open-apis/contact/v3/users/batch") {
        return Response.json({ code: 0, data: { items: [{ open_id: "ou_ada", name: "Ada Lovelace" }] } });
      }
      if (method !== "POST" || url.pathname !== "/open-apis/im/v1/messages/search") return undefined;
      if (url.searchParams.get("page_token") === "next-page") {
        return Response.json({
          code: 0,
          data: {
            items: [
              {
                meta_data: { message_id: "om_other", chat_id: "oc_other", from_id: "ou_ada", create_time: "1710000000000", is_p2p_chat: true, type: "text" },
                display_info: "other-page",
              },
            ],
          },
        });
      }
      const prefix = [
        "message_id: om_big",
        "chat_id: oc_p2p",
        "is_p2p_chat: true",
        "sender: Ada Lovelace",
        "time: 2024-03-09T16:00:00+00:00",
        "type: text",
        "snippet: ",
      ].join("\n");
      const snippet = `${"s".repeat(99_990 - prefix.length - "ENDMARKER".length)}ENDMARKER`;
      return Response.json({
        code: 0,
        data: {
          total: 1,
          has_more: false,
          page_token: "next-page",
          items: [
            {
              meta_data: {
                message_id: "om_big",
                chat_id: "oc_p2p",
                from_id: "ou_ada",
                create_time: "1710000000000",
                is_p2p_chat: true,
                type: "text",
              },
              display_info: snippet,
            },
          ],
        },
      });
    };
    const before = fake.calls.length;
    const first = toolText((await callTool(accessToken, "search_messages", { query: "quarterly" })).body);
    expect(first.length).toBeLessThanOrEqual(100_000);
    const jumped = fake.calls.slice(before).some((call) => new URL(call.url).searchParams.get("page_token") === "next-page");
    expect(jumped).toBe(false);
    const token = first.match(/page_token: (\S+)/)?.[1];
    const continued = token ? toolText((await callTool(accessToken, "search_messages", { query: "quarterly", page_token: token })).body) : "";
    expect(continued.length).toBeLessThanOrEqual(100_000);
    expect(`${first}\n${continued}`).toContain("ENDMARKER");
    expect(`${first}\n${continued}`).not.toContain("other-page");
  });

  it("prints an ISO 8601 search hit time", async () => {
    const { accessToken } = await login();
    fake.extra = (method, url) => {
      if (method !== "POST" || url.pathname !== "/open-apis/im/v1/messages/search") return undefined;
      return Response.json({
        code: 0,
        data: {
          has_more: false,
          items: [
            {
              display_info: "snippet",
              meta_data: {
                chat_id: "oc_group",
                create_time: "2026-10-09T06:57:32Z",
                from_id: "ou_ada",
                is_p2p_chat: false,
                message_id: "om_iso",
                type: "TEXT",
              },
            },
          ],
        },
      });
    };
    const text = toolText((await callTool(accessToken, "search_messages", { query: "weekly" })).body);
    expect(text).toContain("time: 2026-10-09T06:57:32+00:00");
    expect(text).toContain("message_id: om_iso");
  });

  it("filters search by sender kind and documents that from_ids are open ids", async () => {
    const { accessToken } = await login();
    const tools = await listTools(accessToken);
    const listed = tools.find((entry) => entry.name === "search_messages");
    const schema = listed?.inputSchema as {
      properties?: Record<string, { description?: string; items?: { enum?: string[] } }>;
    };
    expect(schema.properties?.from_ids?.description).toMatch(/ou_/);
    expect(schema.properties?.from_ids?.description?.toLowerCase()).toContain("app");
    expect(schema.properties?.from_types?.items?.enum).toEqual(["user", "bot"]);
    expect(schema.properties?.exclude_from_types?.items?.enum).toEqual(["user", "bot"]);

    fake.extra = (method, url) => {
      if (method !== "POST" || url.pathname !== "/open-apis/im/v1/messages/search") return undefined;
      return Response.json({ code: 0, data: { items: [] } });
    };
    const before = fake.calls.length;
    await callTool(accessToken, "search_messages", {
      query: "",
      from_ids: ["ou_ada"],
      from_types: ["bot"],
      exclude_from_types: ["user"],
    });
    const search = fake.calls.slice(before).find((call) => call.url.includes("/open-apis/im/v1/messages/search"));
    expect(JSON.parse(search?.body ?? "{}")).toEqual({
      query: "",
      filter: {
        from_ids: ["ou_ada"],
        from_types: ["bot"],
        exclude_from_types: ["user"],
      },
    });
  });
});

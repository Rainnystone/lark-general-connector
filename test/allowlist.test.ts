import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, EndpointNotAllowedError, FeishuClient } from "../src/feishu/client";

describe("endpoint allowlist", () => {
  it("rejects message and chat writes before any network call", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope"));
    const client = new FeishuClient({ fetchImpl });
    const forbidden: Array<[string, string]> = [
      ["POST", "https://open.feishu.cn/open-apis/im/v1/messages"],
      ["POST", "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply"],
      ["PUT", "https://open.feishu.cn/open-apis/im/v1/messages/om_1"],
      ["PATCH", "https://open.feishu.cn/open-apis/im/v1/messages/om_1"],
      ["DELETE", "https://open.feishu.cn/open-apis/im/v1/messages/om_1"],
      ["POST", "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reactions"],
      ["DELETE", "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reactions/emoji"],
      ["POST", "https://open.feishu.cn/open-apis/im/v1/chats"],
      ["PUT", "https://open.feishu.cn/open-apis/im/v1/chats/oc_1"],
      ["PATCH", "https://open.feishu.cn/open-apis/im/v1/chats/oc_1"],
      ["DELETE", "https://open.feishu.cn/open-apis/im/v1/chats/oc_1"],
      ["POST", "https://open.feishu.cn/open-apis/im/v1/chats/oc_1/members"],
      ["DELETE", "https://open.feishu.cn/open-apis/im/v1/chats/oc_1/members/ou_ada"],
    ];
    for (const [method, url] of forbidden) {
      await expect(client.request(method, url, { body: "{}" })).rejects.toBeInstanceOf(EndpointNotAllowedError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects permission and share endpoints before any network call", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope"));
    const client = new FeishuClient({ fetchImpl });
    const forbidden = [
      "https://open.feishu.cn/open-apis/drive/v1/permissions/doxcn/members",
      "https://open.feishu.cn/open-apis/drive/v1/permissions/doxcn/members/batch_create",
      "https://open.feishu.cn/open-apis/drive/v2/permissions/doxcn/public",
    ];
    for (const url of forbidden) {
      await expect(client.request("POST", url, { body: "{}" })).rejects.toBeInstanceOf(EndpointNotAllowedError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a contact write before any network call", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope"));
    const client = new FeishuClient({ fetchImpl });
    await expect(client.request("PATCH", "https://open.feishu.cn/open-apis/contact/v3/users/ou_ada", { body: "{}" })).rejects.toBeInstanceOf(EndpointNotAllowedError);
    await expect(client.request("GET", "https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id")).rejects.toBeInstanceOf(EndpointNotAllowedError);
    await expect(client.request("GET", "https://open.feishu.cn/open-apis/contact/v3/users/find_by_department")).rejects.toBeInstanceOf(EndpointNotAllowedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an unlisted docs endpoint before any network call", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope"));
    const client = new FeishuClient({ fetchImpl });
    await expect(client.request("POST", "https://open.feishu.cn/open-apis/drive/v1/permissions/doxcn/members", { body: "{}" })).rejects.toBeInstanceOf(EndpointNotAllowedError);
    await expect(client.request("DELETE", "https://open.feishu.cn/open-apis/wiki/v2/spaces/spc/nodes/wikcn")).rejects.toBeInstanceOf(EndpointNotAllowedError);
    await expect(client.request("GET", "https://open.feishu.cn/open-apis/docx/v1/documents/doxcn/blocks")).rejects.toBeInstanceOf(EndpointNotAllowedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects wiki delete, non-docx drive delete, and trash endpoints before any network call", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope"));
    const client = new FeishuClient({ fetchImpl });
    const forbidden: Array<[string, string]> = [
      ["DELETE", "https://open.feishu.cn/open-apis/wiki/v2/spaces/spc/nodes/wikcn"],
      ["POST", "https://open.feishu.cn/open-apis/wiki/v2/nodes/wikcn/move_wiki_to_docs"],
      ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=folder"],
      ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=sheet"],
      ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=bitable"],
      ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=doc"],
      ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=file"],
      ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn"],
      ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=docx&type=folder"],
      ["POST", "https://open.feishu.cn/open-apis/drive/v1/trash/empty"],
      ["DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn/trash"],
      ["POST", "https://open.feishu.cn/open-apis/drive/explorer/v2/file/delete"],
    ];
    for (const [method, url] of forbidden) {
      await expect(client.request(method, url)).rejects.toBeInstanceOf(EndpointNotAllowedError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await client.request("DELETE", "https://open.feishu.cn/open-apis/drive/v1/files/doxcn?type=docx");
    await client.request("GET", "https://open.feishu.cn/open-apis/docx/v1/documents/doxcn");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops the 41st outbound call before fetch", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response("ok");
    });
    const client = new FeishuClient({ fetchImpl, limit: 40 });
    for (let index = 0; index < 40; index += 1) {
      await client.request("GET", "https://open.feishu.cn/open-apis/authen/v1/user_info");
    }
    expect(calls).toBe(40);
    await expect(client.request("GET", "https://open.feishu.cn/open-apis/authen/v1/user_info")).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toBe(40);
  });
});

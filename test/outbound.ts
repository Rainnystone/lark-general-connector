function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

const TOKEN = {
  code: 0,
  access_token: "u-from-outbound",
  refresh_token: "ur-from-outbound",
  expires_in: 7200,
  refresh_token_expires_in: 2_592_000,
  token_type: "Bearer",
  scope: "offline_access",
};

async function feishuResponse(request: Request, url: URL): Promise<Response> {
  if (url.hostname === "accounts.feishu.cn" && url.pathname === "/oauth/v3/token") {
    const body = await request.text();
    if (body.includes("code_verifier=")) {
      return json({ error: "invalid_grant", error_description: "PKCE code challenge failed.", code: 20049 }, 400);
    }
    if (body.includes("code=auth-code-described")) {
      return json(
        {
          error: "invalid_grant",
          error_description: "The refresh token provided is invalid. auth-code-described test-app-secret",
          code: 20049,
        },
        400,
      );
    }
    if (body.includes("code=auth-code-permanent")) return json({ code: 20026 });
    if (body.includes("code=auth-code-userinfo")) {
      return json({ ...TOKEN, access_token: "u-userinfo-fail", refresh_token: "ur-userinfo-fail" });
    }
    return json(TOKEN);
  }
  if (url.hostname === "open.feishu.cn" && url.pathname === "/open-apis/authen/v1/user_info") {
    const authorization = request.headers.get("authorization") ?? "";
    if (authorization.includes("u-userinfo-fail")) return json({ code: 99991663, msg: "invalid" });
    return json({ code: 0, data: { name: "Owner", open_id: "ou_owner" } });
  }
  return new Response("unexpected feishu request", { status: 404 });
}

/** Miniflare outbound stand-in for Feishu. Other hosts keep the real network. */
export async function feishuOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === "accounts.feishu.cn" || url.hostname === "open.feishu.cn" || url.hostname === "mcp.feishu.cn") {
    return feishuResponse(request, url);
  }
  const init: RequestInit = { method: request.method, headers: request.headers };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();
  return fetch(request.url, init);
}

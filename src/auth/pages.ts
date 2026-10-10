export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
    },
  });
}

export function approvalPage(input: { clientName: string; redirectHost: string; handle: string }): Response {
  const body = `<p>Client: ${escapeHtml(input.clientName)}</p><p>Redirect host: ${escapeHtml(input.redirectHost)}</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(input.handle)}"><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form>`;
  return page("Approve Feishu connector", body, 200);
}

export function disabledPage(): Response {
  return page("Connector disabled", "<p>This connector is disabled by the owner.</p>", 503);
}

export function bootstrapDeniedPage(openId: string): Response {
  return page("Owner not configured", `<p>This Feishu account is not the owner.</p><p>open_id: ${escapeHtml(openId)}</p>`, 403);
}

export function forbiddenPage(): Response {
  return page("Forbidden", "<p>This Feishu account is not the owner.</p>", 403);
}

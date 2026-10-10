import { env } from "cloudflare:workers";
import { parseFeishuRegion, rewriteUrlForRegion, type FeishuRegion } from "./region";

export const OUTBOUND_LIMIT = 40;

export { parseFeishuRegion, rewriteUrlForRegion };
export type { FeishuRegion };

export function currentFeishuRegion(): FeishuRegion {
  const region = parseFeishuRegion(env.FEISHU_REGION);
  if (region === null) throw new Error("invalid FEISHU_REGION");
  return region;
}

interface AllowRule {
  method: string;
  host: string;
  path: string;
  query?: "type=docx";
}

const ALLOWED: readonly AllowRule[] = [
  { method: "DELETE", host: "open.feishu.cn", path: "^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/fields/[^/]+$" },
  { method: "DELETE", host: "open.feishu.cn", path: "^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/records/[^/]+$" },
  { method: "DELETE", host: "open.feishu.cn", path: "^/open-apis/drive/v1/files/[^/]+$", query: "type=docx" },
  { method: "DELETE", host: "open.feishu.cn", path: "^/open-apis/slides_ai/v1/xml_presentations/[^/]+/slide$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/authen/v1/user_info$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/base/v3/bases/[^/]+/tables/[^/]+/records$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/bitable/v1/apps/[^/]+$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/bitable/v1/apps/[^/]+/tables$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/fields$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/board/v1/whiteboards/[^/]+/nodes$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/contact/v3/users/(?!batch$|batch_get_id$|find_by_department$)[^/]+$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/contact/v3/users/batch$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/docx/v1/documents/[^/]+$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/docx/v1/documents/[^/]+/raw_content$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/drive/v1/files/[^/]+/comments$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/drive/v1/files/[^/]+/download$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/drive/v1/medias/[^/]+/download$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/im/v1/chats$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/im/v1/messages$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/im/v1/messages/om_[^/]+$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/mindnote/v1/mindnotes/[^/]+/nodes$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/search/v1/user$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/sheets/v2/spreadsheets/[^/]+/values/[^/]+$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/sheets/v3/spreadsheets/[^/]+/sheets/query$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/slides_ai/v1/xml_presentations/[^/]+$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/wiki/v2/spaces/[^/]+/nodes$" },
  { method: "GET", host: "open.feishu.cn", path: "^/open-apis/wiki/v2/spaces/get_node$" },
  { method: "POST", host: "accounts.feishu.cn", path: "^/oauth/v3/token$" },
  { method: "POST", host: "mcp.feishu.cn", path: "^/mcp$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/bitable/v1/apps$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/fields$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/records$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/docx/v1/documents$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/docx/v1/documents/[^/]+/blocks/[^/]+/children$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/drive/v1/files/[^/]+/comments$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/drive/v1/files/upload_all$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/drive/v1/metas/batch_query$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/im/v1/messages/search$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/search/v2/doc_wiki/search$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/sheets/v2/spreadsheets/[^/]+/values_append$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/sheets/v2/spreadsheets/[^/]+/values_batch_update$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/sheets/v3/spreadsheets$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/slides_ai/v1/xml_presentations$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/slides_ai/v1/xml_presentations/[^/]+/slide$" },
  { method: "POST", host: "open.feishu.cn", path: "^/open-apis/slides_ai/v1/xml_presentations/[^/]+/slide/replace$" },
  { method: "PUT", host: "open.feishu.cn", path: "^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/fields/[^/]+$" },
  { method: "PUT", host: "open.feishu.cn", path: "^/open-apis/bitable/v1/apps/[^/]+/tables/[^/]+/records/[^/]+$" },
  { method: "PUT", host: "open.feishu.cn", path: "^/open-apis/sheets/v2/spreadsheets/[^/]+/values$" },
];

function allowLine(rule: AllowRule): string {
  const base = `${rule.method} ${rule.host} ${rule.path}`;
  return rule.query ? `${base} ${rule.query}` : base;
}

/** Stable dump of every Feishu call this Worker may make. */
export function endpointAllowlist(): readonly string[] {
  return ALLOWED.map(allowLine);
}

function docxDelete(params: URLSearchParams): boolean {
  const types = params.getAll("type");
  return types.length === 1 && types[0] === "docx";
}

export class EndpointNotAllowedError extends Error {
  constructor(method: string, url: string) {
    super(`Feishu endpoint is not allowed: ${method} ${url}`);
    this.name = "EndpointNotAllowedError";
  }
}

export class BudgetExceededError extends Error {
  constructor(limit: number) {
    super(`outbound call budget exceeded (${limit})`);
    this.name = "BudgetExceededError";
  }
}

export function isEndpointAllowed(method: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const verb = method.toUpperCase();
  return ALLOWED.some((entry) => {
    if (entry.method !== verb || entry.host !== parsed.host || !new RegExp(entry.path).test(parsed.pathname)) return false;
    if (!entry.query) return true;
    switch (entry.query) {
      case "type=docx":
        return docxDelete(parsed.searchParams);
      default: {
        const unexpected: never = entry.query;
        return unexpected;
      }
    }
  });
}

type FetchImpl = typeof fetch;

export class FeishuClient {
  private used = 0;
  private readonly limit: number;
  private readonly fetchImpl: FetchImpl;

  constructor(options?: { fetchImpl?: FetchImpl; limit?: number }) {
    this.limit = options?.limit ?? OUTBOUND_LIMIT;
    this.fetchImpl = options?.fetchImpl ?? fetch.bind(globalThis);
  }

  async request(method: string, url: string, init?: { headers?: HeadersInit; body?: string | FormData }): Promise<Response> {
    if (!isEndpointAllowed(method, url)) {
      throw new EndpointNotAllowedError(method, url);
    }
    const target = rewriteUrlForRegion(url, currentFeishuRegion());
    if (this.used >= this.limit) {
      throw new BudgetExceededError(this.limit);
    }
    this.used += 1;
    return this.fetchImpl(target, {
      method,
      headers: init?.headers,
      body: init?.body,
    });
  }
}

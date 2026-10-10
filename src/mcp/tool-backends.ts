export const PROXIED_TOOLS = [
  "search_docs",
  "fetch_doc",
  "list_wiki_docs",
  "get_doc_comments",
  "create_doc",
  "update_doc",
  "add_doc_comment",
  "get_user",
  "search_users",
  "fetch_doc_media",
] as const;

export type ProxiedToolName = (typeof PROXIED_TOOLS)[number];
export type ToolBackend = "mcp" | "openapi";

/** search_docs pages with the doc_wiki page_token. That page size tops out at 20, as does MCP search. */
function defaultBackend(tool: ProxiedToolName): ToolBackend {
  switch (tool) {
    case "search_docs":
      return "openapi";
    case "fetch_doc":
    case "list_wiki_docs":
    case "get_doc_comments":
    case "create_doc":
    case "update_doc":
    case "add_doc_comment":
    case "get_user":
    case "search_users":
    case "fetch_doc_media":
      return "mcp";
    default: {
      const unexpected: never = tool;
      return unexpected;
    }
  }
}

export function toolBackend(raw: string | undefined, tool: ProxiedToolName): { backend: ToolBackend; invalid: boolean } {
  if (raw === undefined || raw.trim() === "") return { backend: defaultBackend(tool), invalid: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { backend: defaultBackend(tool), invalid: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { backend: defaultBackend(tool), invalid: true };
  const record = parsed as Record<string, unknown>;
  const invalid = Object.values(record).some((value) => !isBackend(value));
  const value = record[tool];
  if (value === "openapi") return { backend: "openapi", invalid };
  if (value === "mcp") return { backend: "mcp", invalid };
  if (value === undefined) return { backend: defaultBackend(tool), invalid };
  // A present value other than mcp or openapi stays on MCP. Only an omitted key selects the default.
  return { backend: "mcp", invalid: true };
}

function isBackend(value: unknown): value is ToolBackend {
  return value === "mcp" || value === "openapi";
}

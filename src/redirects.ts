export function corsOriginHostnames(publicUrl: string, allowlist: string): string[] {
  const hosts = new Set<string>(["localhost", new URL(publicUrl).hostname]);
  for (const entry of allowlist.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") continue;
    if (parsed.hostname === "") continue;
    hosts.add(parsed.hostname);
  }
  return [...hosts];
}

export function isRedirectAllowed(uri: string, allowlist: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return false;
  const entries = allowlist
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.some((entry) => {
    if (entry.endsWith("*")) return matchesWildcard(parsed, uri, entry.slice(0, -1));
    return entry.endsWith("/") ? uri.startsWith(entry) : uri === entry;
  });
}

// An entry ending in "*" matches a URI with the same scheme and host whose path is the
// entry's path followed only by [A-Za-z0-9_.-] characters, with no query or fragment.
function matchesWildcard(parsed: URL, uri: string, prefix: string): boolean {
  let base: URL;
  try {
    base = new URL(prefix);
  } catch {
    return false;
  }
  if (uri !== parsed.href || parsed.search !== "" || parsed.hash !== "") return false;
  if (parsed.protocol !== base.protocol || parsed.host !== base.host) return false;
  if (!parsed.pathname.startsWith(base.pathname)) return false;
  return /^[A-Za-z0-9_.-]+$/.test(parsed.pathname.slice(base.pathname.length));
}

export function registrationDecision(
  metadata: Record<string, unknown>,
  allowlist: string,
): { description: string } | undefined {
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return { description: "redirect_uris required" };
  }
  for (const uri of uris) {
    if (typeof uri !== "string" || !isRedirectAllowed(uri, allowlist)) {
      return { description: "redirect URI is not allowed" };
    }
  }
  return undefined;
}

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
  return entries.some((entry) => (entry.endsWith("/") ? uri.startsWith(entry) : uri === entry));
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

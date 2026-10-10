/** Above the 100_000 character tool output cap, so a successful body can be parsed and then projected. Anything larger is an error, never a raw prefix. */
export const BODY_CHAR_LIMIT = 200_000;

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export async function readBoundedJson(response: Response, limit = BODY_CHAR_LIMIT): Promise<{ value: unknown; parsed: boolean; truncated: boolean }> {
  const { text, truncated } = await readBoundedText(response, limit);
  if (text.length === 0) return { value: {}, parsed: true, truncated };
  try {
    return { value: JSON.parse(text) as unknown, parsed: true, truncated };
  } catch {
    return { value: text, parsed: false, truncated };
  }
}

async function readBoundedText(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length <= limit) return { text, truncated: false };
    return { text: text.slice(0, limit), truncated: true };
  }
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= limit) {
        truncated = true;
        text = text.slice(0, limit);
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    await reader.cancel();
  }
  if (text.length > limit) return { text: text.slice(0, limit), truncated: true };
  return { text, truncated };
}

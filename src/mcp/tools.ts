import type { CallToolResult } from "@modelcontextprotocol/server";
import { audit } from "../audit";
import type { Env } from "../env";
import { BudgetExceededError, EndpointNotAllowedError, FeishuClient } from "../feishu/client";
import { readUserInfo } from "../feishu/api";
import { revokeOwnerGrants } from "../auth/grants";
import type { AccessResult } from "../tokens/store";

export const RECONNECT = "Feishu authorization expired; reconnect the connector";
export const TOKEN_INVALID = new Set([99991663, 99991668, 99991677]);

export const OUTPUT_LIMIT = 100_000;
const TRUNCATION_MARKER = "\n[truncated; ask for the next page]";
const ROW_CURSOR = "rowcap:";
const OWNED_PREFIXES = ["rowcap:", "p2pseen:", "p2psearch:"] as const;

export const INVALID_PAGE_TOKEN = "invalid page_token";

export function invalidPageToken(): { kind: "done"; text: string; isError: true } {
  return { kind: "done", text: INVALID_PAGE_TOKEN, isError: true };
}

export interface PageCursor {
  token: string | undefined;
  skip: number;
  offset: number;
}

export function presentCapped(body: string, footer = ""): string {
  if (footer.length + TRUNCATION_MARKER.length >= OUTPUT_LIMIT) {
    const whole = `${body}${footer}`;
    if (whole.length <= OUTPUT_LIMIT) return whole;
    const room = OUTPUT_LIMIT - TRUNCATION_MARKER.length;
    return `${whole.slice(0, Math.max(0, room))}${TRUNCATION_MARKER}`;
  }
  const whole = `${body}${footer}`;
  if (whole.length <= OUTPUT_LIMIT) return whole;
  const room = OUTPUT_LIMIT - TRUNCATION_MARKER.length - footer.length;
  return `${body.slice(0, Math.max(0, room))}${TRUNCATION_MARKER}${footer}`;
}

export function pageTokenFooter(pageToken: string | null | undefined): string {
  if (pageToken === null || pageToken === undefined || pageToken.length === 0) return "";
  return `\npage cap reached\npage_token: ${pageToken}`;
}

export function joinBlocks(blocks: readonly string[]): string {
  return blocks.join("\n\n");
}

/**
 * Cursor that refetches `token`, skips whole rows, then skips `offset` characters of the next row.
 * Offset 0 stays `rowcap:<skip>:<token>` so existing continuations keep that shape.
 */
export function encodeResumeToken(token: string | undefined, skip: number, offset = 0): string {
  if (offset === 0) return `${ROW_CURSOR}${skip}:${token ?? ""}`;
  return `${ROW_CURSOR}${skip}:${offset}:${token ?? ""}`;
}

function safeCount(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function decodeResumeToken(pageToken: string | undefined): { ok: true; cursor: PageCursor } | { ok: false } {
  if (pageToken === undefined || pageToken.length === 0) return { ok: true, cursor: { token: undefined, skip: 0, offset: 0 } };
  if (!pageToken.startsWith(ROW_CURSOR)) return { ok: true, cursor: { token: pageToken, skip: 0, offset: 0 } };
  const rest = pageToken.slice(ROW_CURSOR.length);
  const three = /^(\d+):(\d+):(.*)$/.exec(rest);
  const two = three ? null : /^(\d+):(.*)$/.exec(rest);
  const skip = safeCount((three?.[1] ?? two?.[1] ?? ""));
  const offset = three ? safeCount(three[2] ?? "") : two ? 0 : null;
  if (skip === null || offset === null) return { ok: false };
  const tokenText = three ? (three[3] ?? "") : (two?.[2] ?? "");
  if (tokenText.startsWith(ROW_CURSOR)) return { ok: false };
  return { ok: true, cursor: { token: tokenText.length > 0 ? tokenText : undefined, skip, offset } };
}

/** Refuse another tool's cursor prefix. A raw Feishu token is allowed. */
export function readPageCursor(pageToken: string | undefined, allowedPrefixes: readonly string[]): { ok: true; cursor: PageCursor } | { ok: false } {
  const decoded = decodeResumeToken(pageToken);
  if (!decoded.ok) return decoded;
  const token = decoded.cursor.token;
  if (token === undefined) return decoded;
  const owned = OWNED_PREFIXES.some((prefix) => token.startsWith(prefix));
  if (!owned) return decoded;
  return allowedPrefixes.some((prefix) => token.startsWith(prefix)) ? decoded : { ok: false };
}

/**
 * `skip`/`offset` address rendered blocks. A cursor past the page is invalid.
 * A skip that lands on the end of the page means that page was fully returned.
 */
export function windowBlocks(
  blocks: readonly string[],
  skip: number,
  offset: number,
): { ok: false } | { ok: true; consumed: true } | { ok: true; consumed: false; blocks: string[]; skip: number; offset: number } {
  if (!Number.isSafeInteger(skip) || !Number.isSafeInteger(offset) || skip < 0 || offset < 0) return { ok: false };
  let row = skip;
  let char = offset;
  const current = blocks[row];
  if (current !== undefined && char === current.length) {
    row += 1;
    char = 0;
  }
  if (row > blocks.length) return { ok: false };
  if (row === blocks.length) return char === 0 ? { ok: true, consumed: true } : { ok: false };
  const block = blocks[row];
  if (block === undefined || char > block.length) return { ok: false };
  return { ok: true, consumed: false, blocks: blocks.slice(row), skip: row, offset: char };
}

export interface FitDecision {
  blocks: string[];
  replays: (string | null)[];
  omitted: boolean;
  resumeToken: string | null;
  /** Sealed tool text when rows were omitted. Already within the output cap. */
  text?: string;
  invalid?: boolean;
}

function within(body: string, footer: string): boolean {
  return body.length + footer.length <= OUTPUT_LIMIT;
}

function emittable(cursor: string | null): cursor is string {
  return cursor !== null && cursor.length > 0 && cursor !== "p2pseen:";
}

function replayCursor(requestToken: string | undefined, skip: number, offset: number): string | null {
  if (skip <= 0 && offset <= 0) {
    if (requestToken === "p2pseen:") return "p2pseen:";
    if (requestToken === undefined || requestToken.length === 0) return null;
    return requestToken;
  }
  return encodeResumeToken(requestToken, skip, offset);
}

function shiftCursor(replay: string | null, chars: number): string | null {
  if (!Number.isSafeInteger(chars) || chars <= 0) return emittable(replay) ? replay : null;
  const decoded = decodeResumeToken(replay ?? undefined);
  if (!decoded.ok) return null;
  const offset = decoded.cursor.offset + chars;
  if (!Number.isSafeInteger(offset)) return null;
  return encodeResumeToken(decoded.cursor.token, decoded.cursor.skip, offset);
}

function footerFor(cursor: string | null, notes: string, partial: boolean): string {
  const marker = partial ? TRUNCATION_MARKER : "";
  return `${marker}${notes}${pageTokenFooter(emittable(cursor) ? cursor : null)}`;
}

function longestPrefix(prior: readonly string[], text: string, notes: string, resumeAt: (chars: number) => string | null): number {
  let best = 0;
  let lo = 1;
  let hi = text.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const body = joinBlocks([...prior, text.slice(0, mid)]);
    if (within(body, footerFor(resumeAt(mid), notes, true))) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Drop or shorten trailing rows until `footer` fits, and point the cursor at the first omitted character. */
export function finishRows(blocks: readonly string[], replays: readonly (string | null)[], footer: string, notes: string, emptyText: string): string {
  const kept = [...blocks];
  const reps = [...replays];
  let tail = footer;
  while (kept.length > 0 && !within(joinBlocks(kept), tail)) {
    const last = kept[kept.length - 1] ?? "";
    const replay = reps[reps.length - 1] ?? null;
    const prior = kept.slice(0, -1);
    if (prior.length === 0 || !emittable(replay)) {
      const prefix = longestPrefix(prior, last, notes, (chars) => shiftCursor(replay, chars));
      if (prefix > 0 && prefix < last.length) {
        kept[kept.length - 1] = last.slice(0, prefix);
        tail = footerFor(shiftCursor(replay, prefix), notes, true);
        break;
      }
    }
    if (kept.length > 1 && emittable(replay)) {
      kept.pop();
      reps.pop();
      tail = footerFor(replay, notes, false);
      continue;
    }
    kept.pop();
    reps.pop();
    tail = notes;
    break;
  }
  const body = kept.length === 0 ? emptyText : joinBlocks(kept);
  const text = `${body}${tail}`;
  if (text.length <= OUTPUT_LIMIT) return text;
  return presentCapped(body, tail);
}

/**
 * Keep a prefix of `page` that still fits under the output cap, including the footer
 * needed to replay the first omitted row. `page` starts at `baseSkip`/`baseOffset`.
 */
export function fitPage(
  prior: readonly string[],
  priorReplays: readonly (string | null)[],
  page: readonly string[],
  baseSkip: number,
  baseOffset: number,
  requestToken: string | undefined,
  nextToken: string | null,
  extraFooter = "",
): FitDecision {
  const kept = [...prior];
  const replays = [...priorReplays];
  for (let index = 0; index < page.length; index += 1) {
    const full = page[index];
    if (full === undefined || full.length === 0) continue;
    const start = index === 0 ? baseOffset : 0;
    if (start > full.length) return { blocks: kept, replays, omitted: true, resumeToken: null, invalid: true };
    const display = full.slice(start);
    if (display.length === 0) continue;
    const origin = replayCursor(requestToken, baseSkip + index, start);
    const moreOnPage = index + 1 < page.length;
    const nextCursor = moreOnPage ? replayCursor(requestToken, baseSkip + index + 1, 0) : nextToken;
    const candidate = [...kept, display];
    const candidateReplays = [...replays, origin];
    const fullFooter = footerFor(nextCursor, extraFooter, false);
    if (within(joinBlocks(candidate), fullFooter)) {
      kept.push(display);
      replays.push(origin);
      continue;
    }
    const text = finishRows(candidate, candidateReplays, fullFooter, extraFooter, "");
    return { blocks: kept, replays, omitted: true, resumeToken: emittable(origin) ? origin : nextCursor, text };
  }
  return { blocks: kept, replays, omitted: false, resumeToken: nextToken };
}

/** Tool text when rows were omitted. Null when the caller should keep paging. */
export function renderFit(decision: FitDecision, emptyText: string, extraFooter = ""): string | null {
  if (decision.invalid) return null;
  if (decision.text !== undefined) return decision.text.length === 0 ? emptyText : decision.text;
  if (!decision.omitted) return null;
  return finishRows(decision.blocks, decision.replays, `${extraFooter}${pageTokenFooter(decision.resumeToken)}`, extraFooter, emptyText);
}

function capText(text: string): string {
  return presentCapped(text);
}

export function textResult(text: string, isError = false): CallToolResult {
  const capped = capText(text);
  return isError ? { isError: true, content: [{ type: "text", text: capped }] } : { content: [{ type: "text", text: capped }] };
}

export async function resolveAccess(env: Env, openId: string, force: boolean): Promise<AccessResult> {
  return env.FEISHU_TOKENS.getByName(openId).getAccess({ force });
}

export async function failAccess(env: Env, openId: string, access: Extract<AccessResult, { ok: false }>): Promise<CallToolResult> {
  if (access.refreshFailed) {
    audit({ event: "reauth_required", code: access.code });
    await revokeOwnerGrants(env, openId);
  }
  if (access.reauth) return textResult(RECONNECT, true);
  return textResult("Feishu request failed", true);
}

export async function callWhoami(env: Env, openId: string): Promise<CallToolResult> {
  const started = Date.now();
  let code = "0";
  let ok = false;
  let result = textResult("Feishu request failed", true);
  try {
    const client = new FeishuClient();
    let access = await resolveAccess(env, openId, false);
    if (!access.ok) {
      code = access.code;
      result = await failAccess(env, openId, access);
      return result;
    }
    let info = await readUserInfo(client, access.accessToken);
    if (TOKEN_INVALID.has(info.code)) {
      access = await resolveAccess(env, openId, true);
      if (!access.ok) {
        code = access.code;
        result = await failAccess(env, openId, access);
        return result;
      }
      info = await readUserInfo(client, access.accessToken);
    }
    if (info.code !== 0 || !info.openId) {
      code = String(info.code);
      result = textResult("Feishu request failed", true);
      return result;
    }
    ok = true;
    code = "0";
    result = textResult(`name: ${info.name}\nopen_id: ${info.openId}`);
    return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof EndpointNotAllowedError) {
      code = "budget";
      result = textResult(error.message, true);
      return result;
    }
    code = "error";
    result = textResult("Feishu request failed", true);
    return result;
  } finally {
    audit({ event: "tool_call", tool: "whoami", target: null, ok, code, ms: Date.now() - started });
  }
}


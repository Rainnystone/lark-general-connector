import { FeishuClient } from "./client";
import { feishuOpen, stringField } from "./docs";
import { asRecord } from "./payload";

const BATCH_SIZE = 50;

function batchUrl(ids: readonly string[]): string {
  const url = new URL("https://open.feishu.cn/open-apis/contact/v3/users/batch");
  url.searchParams.set("user_id_type", "open_id");
  for (const id of ids) url.searchParams.append("user_ids", id);
  return url.toString();
}

/** OpenAPI codes that mean the user token must be refreshed. Further batches would spend the same dead token. */
function tokenInvalid(code: number): boolean {
  return code === 99991663 || code === 99991668 || code === 99991677;
}

type NameLoad = { ok: true; names: Map<string, string> } | { ok: false; tokenInvalid: boolean };

async function loadNames(client: FeishuClient, accessToken: string, ids: readonly string[]): Promise<NameLoad> {
  try {
    const result = await feishuOpen(client, "GET", batchUrl(ids), accessToken);
    if (tokenInvalid(result.code)) return { ok: false, tokenInvalid: true };
    if (result.code !== 0 || result.rawText !== undefined) return { ok: false, tokenInvalid: false };
    const items = Array.isArray(result.data.items) ? result.data.items : [];
    const names = new Map<string, string>();
    for (const item of items) {
      const record = asRecord(item);
      const openId = stringField(record, "open_id");
      const name = stringField(record, "name");
      if (openId.length > 0 && name.length > 0) names.set(openId, name);
    }
    return { ok: true, names };
  } catch {
    return { ok: false, tokenInvalid: false };
  }
}

interface ResolvedNames {
  values: string[];
  tokenInvalid: boolean;
}

async function resolveNames(client: FeishuClient, accessToken: string, openIds: readonly string[]): Promise<ResolvedNames> {
  const names = new Map<string, string>();
  const unique: string[] = [];
  for (const id of openIds) {
    if (id.length === 0 || names.has(id)) continue;
    names.set(id, id);
    unique.push(id);
  }
  for (let index = 0; index < unique.length; index += BATCH_SIZE) {
    const chunk = unique.slice(index, index + BATCH_SIZE);
    const loaded = await loadNames(client, accessToken, chunk);
    if (!loaded.ok) {
      if (loaded.tokenInvalid) return { values: openIds.map((id) => names.get(id) ?? id), tokenInvalid: true };
      continue;
    }
    for (const [openId, name] of loaded.names) {
      if (names.has(openId)) names.set(openId, name);
    }
  }
  return { values: openIds.map((id) => names.get(id) ?? id), tokenInvalid: false };
}

/** Resolve open_ids to display names. A Feishu failure leaves those ids unchanged. An invalid token stops further batches. */
export async function resolveOpenIdNames(client: FeishuClient, accessToken: string, openIds: readonly string[]): Promise<string[]> {
  const resolved = await resolveNames(client, accessToken, openIds);
  return resolved.values;
}

/** Names that differ from the open_id. A dead token stops further batches and is reported so the caller can refresh. */
export async function openIdNameLookup(
  client: FeishuClient,
  accessToken: string,
  openIds: readonly string[],
): Promise<{ names: Map<string, string>; tokenInvalid: boolean }> {
  const resolved = await resolveNames(client, accessToken, openIds);
  const names = new Map<string, string>();
  openIds.forEach((id, index) => {
    const name = resolved.values[index];
    if (id.length > 0 && name && name !== id) names.set(id, name);
  });
  return { names, tokenInvalid: resolved.tokenInvalid };
}

/** Names that differ from the open_id. Failed lookups are omitted. */
export async function openIdNameMap(client: FeishuClient, accessToken: string, openIds: readonly string[]): Promise<Map<string, string>> {
  const looked = await openIdNameLookup(client, accessToken, openIds);
  return looked.names;
}

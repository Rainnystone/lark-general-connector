import type { Env } from "../env";

export function grantUserId(openId: string): string {
  return encodeURIComponent(openId);
}

export async function revokeOwnerGrants(env: Env, openId: string): Promise<void> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return;
  const userId = grantUserId(openId);
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, cursor ? { cursor, limit: 100 } : { limit: 100 });
    for (const grant of page.items) {
      await oauth.revokeGrant(grant.id, userId);
    }
    cursor = page.cursor;
  } while (cursor);
}

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  namespace Cloudflare {
    interface Env {
      FEISHU_APP_ID: string;
      FEISHU_APP_SECRET: string;
      COOKIE_SECRET: string;
      OWNER_OPEN_ID: string;
      FEISHU_REGION: string;
      PUBLIC_URL?: string;
      MCP_DISABLED: string;
      TOOL_BACKENDS: string;
      P2P_DISCOVERY: string;
      OAUTH_PROVIDER?: OAuthHelpers;
    }
  }
}

export type Env = Cloudflare.Env;

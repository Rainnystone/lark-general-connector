export type FeishuRegion = "feishu" | "lark";

const LARK_HOSTS: Readonly<Record<string, string>> = {
  "open.feishu.cn": "open.larksuite.com",
  "accounts.feishu.cn": "accounts.larksuite.com",
  "mcp.feishu.cn": "mcp.larksuite.com",
};

/** Only the two configured regions are valid. Anything else fails closed. */
export function parseFeishuRegion(value: string | undefined): FeishuRegion | null {
  switch (value) {
    case "feishu":
    case "lark":
      return value;
    default:
      return null;
  }
}

export function regionHost(canonicalHost: string, region: FeishuRegion): string {
  switch (region) {
    case "feishu":
      return canonicalHost;
    case "lark": {
      const host = LARK_HOSTS[canonicalHost];
      if (host === undefined) throw new Error("Feishu host is not mapped for lark");
      return host;
    }
    default: {
      const unexpected: never = region;
      return unexpected;
    }
  }
}

export function regionHosts(region: FeishuRegion): { open: string; accounts: string; mcp: string } {
  return {
    open: regionHost("open.feishu.cn", region),
    accounts: regionHost("accounts.feishu.cn", region),
    mcp: regionHost("mcp.feishu.cn", region),
  };
}

export function consoleUrl(region: FeishuRegion): string {
  return `https://${regionHost("open.feishu.cn", region)}/app`;
}

/** Allowlist stays on canonical feishu.cn hosts. Lark rewrites the host after that check. */
export function rewriteUrlForRegion(url: string, region: FeishuRegion): string {
  switch (region) {
    case "feishu":
      return url;
    case "lark": {
      const parsed = new URL(url);
      parsed.host = regionHost(parsed.host, region);
      return parsed.toString();
    }
    default: {
      const unexpected: never = region;
      return unexpected;
    }
  }
}

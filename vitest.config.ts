import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { feishuOutbound } from "./test/outbound.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        outboundService: feishuOutbound,
        bindings: {
          FEISHU_APP_ID: "cli_test",
          FEISHU_APP_SECRET: "test-app-secret",
          OWNER_OPEN_ID: "ou_owner",
          COOKIE_SECRET: "test-cookie-secret-32-characters-min",
          MCP_DISABLED: "0",
          TOOL_BACKENDS: "",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

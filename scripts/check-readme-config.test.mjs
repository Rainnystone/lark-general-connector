// Seam: scanReadmeConfig, the README config-name check in the repo scan.
// Catches a README config name the code does not declare, and a code var or secret either language section omits.
// Misses prose parity (disclaimers, architecture) beyond those names.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanReadmeConfig } from "./check-no-secrets.mjs";

async function withTree(files, fn) {
  const root = await mkdtemp(join(tmpdir(), "readme-config-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const path = join(root, rel);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, text);
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const emptyCode = {
  "wrangler.jsonc": "{}\n",
  "src/env.ts": "interface Env {}\n",
  ".dev.vars.example": "",
  "package.json": "{}\n",
};

test("reports a README config name that is not in the code", async () => {
  await withTree(
    {
      ...emptyCode,
      "README.md": "## English\n\n`ENABLE_PROBE`\n\n## 中文\n\n`ENABLE_PROBE`\n",
    },
    async (root) => {
      const failures = scanReadmeConfig(root);
      assert.ok(failures.some((line) => /ENABLE_PROBE/.test(line) && /not a var, secret, or binding/.test(line)));
    },
  );
});

test("reports a secret in .dev.vars.example the README does not document", async () => {
  await withTree(
    {
      ...emptyCode,
      ".dev.vars.example": "FEISHU_APP_ID=\n",
      "README.md": "## English\n\n## 中文\n",
    },
    async (root) => {
      const failures = scanReadmeConfig(root);
      assert.ok(failures.some((line) => /FEISHU_APP_ID/.test(line) && /English/.test(line)));
      assert.ok(failures.some((line) => /FEISHU_APP_ID/.test(line) && /中文/.test(line)));
    },
  );
});

test("reports an env.ts string var and ignores the OAuth helper", async () => {
  await withTree(
    {
      ...emptyCode,
      "src/env.ts": `interface Env {\n  MCP_DISABLED: string;\n  OAUTH_PROVIDER?: OAuthHelpers;\n}\n`,
      "README.md": "## English\n\n## 中文\n",
    },
    async (root) => {
      const failures = scanReadmeConfig(root);
      assert.ok(failures.some((line) => /MCP_DISABLED/.test(line) && /English/.test(line)));
      assert.equal(failures.some((line) => /OAUTH_PROVIDER/.test(line)), false);
    },
  );
});

test("reports a wrangler binding the README does not document", async () => {
  await withTree(
    {
      ...emptyCode,
      "wrangler.jsonc": `{
  "kv_namespaces": [{ "binding": "OAUTH_KV" }],
  "durable_objects": { "bindings": [{ "name": "FEISHU_TOKENS", "class_name": "FeishuTokenStore" }] }
}\n`,
      "README.md": "## English\n\n## 中文\n",
    },
    async (root) => {
      const failures = scanReadmeConfig(root);
      assert.ok(failures.some((line) => /OAUTH_KV/.test(line) && /English/.test(line)));
      assert.ok(failures.some((line) => /FEISHU_TOKENS/.test(line) && /中文/.test(line)));
      assert.equal(failures.some((line) => /FeishuTokenStore/.test(line)), false);
    },
  );
});

test("reports a package.json binding the README does not document", async () => {
  await withTree(
    {
      ...emptyCode,
      "package.json": `{ "cloudflare": { "bindings": { "PUBLIC_URL": { "description": "origin" } } } }\n`,
      "README.md": "## English\n\n## 中文\n",
    },
    async (root) => {
      const failures = scanReadmeConfig(root);
      assert.ok(failures.some((line) => /PUBLIC_URL/.test(line) && /English/.test(line)));
      assert.ok(failures.some((line) => /PUBLIC_URL/.test(line) && /中文/.test(line)));
    },
  );
});

test("accepts a README that documents every code config in both languages", async () => {
  const documented = "## English\n\n`FEISHU_REGION` is `feishu`.\n\n## 中文\n\n`FEISHU_REGION` 为 `feishu`。\n";
  await withTree(
    {
      ...emptyCode,
      "wrangler.jsonc": "{\n  // committed\n  \"vars\": { \"FEISHU_REGION\": \"feishu\" }\n}\n",
      "README.md": documented,
    },
    async (root) => {
      assert.deepEqual(scanReadmeConfig(root), []);
      assert.deepEqual(scanReadmeConfig(`${root}/`), []);
    },
  );
});

test("reports a config documented in only one language", async () => {
  await withTree(
    {
      ...emptyCode,
      "wrangler.jsonc": `{ "vars": { "FEISHU_REGION": "feishu" } }\n`,
      "README.md": "## English\n\n`FEISHU_REGION`\n\n## 中文\n",
    },
    async (root) => {
      const failures = scanReadmeConfig(root);
      assert.deepEqual(failures, ["README.md 中文 section does not document FEISHU_REGION"]);
    },
  );
});

test("reports wrangler config that does not parse", async () => {
  await withTree(
    {
      ...emptyCode,
      "wrangler.jsonc": "{ not json\n",
      "README.md": "## English\n\n## 中文\n",
    },
    async (root) => {
      const failures = scanReadmeConfig(root);
      assert.ok(failures.some((line) => /wrangler\.jsonc/.test(line) && /parse/.test(line)));
    },
  );
});

test("the repository README documents every code config", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.deepEqual(scanReadmeConfig(root), []);
});

test("reports a code var the README does not document", async () => {
  await withTree(
    {
      ...emptyCode,
      "wrangler.jsonc": `{ "vars": { "FEISHU_REGION": "feishu" } }\n`,
      "README.md": "## English\n\n## 中文\n",
    },
    async (root) => {
      const failures = scanReadmeConfig(root);
      assert.ok(failures.some((line) => /FEISHU_REGION/.test(line) && /English/.test(line)));
      assert.ok(failures.some((line) => /FEISHU_REGION/.test(line) && /中文/.test(line)));
    },
  );
});

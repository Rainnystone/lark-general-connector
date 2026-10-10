import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);

function read(name) {
  return readFileSync(new URL(name, root), "utf8");
}

function parseJsonc(text) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

test(".dev.vars.example lists only the four deploy secrets", () => {
  const lines = read(".dev.vars.example").trim().split("\n");
  assert.deepEqual(lines, ["FEISHU_APP_ID=", "FEISHU_APP_SECRET=", "COOKIE_SECRET=", "OWNER_OPEN_ID=pending"]);
});

test("package.json prompts for the deploy bindings in 中文 and English", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.deploy, "wrangler deploy");
  const bindings = pkg.cloudflare.bindings;
  assert.deepEqual(Object.keys(bindings), [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "COOKIE_SECRET",
    "OWNER_OPEN_ID",
    "FEISHU_REGION",
    "PUBLIC_URL",
    "ALLOWED_REDIRECT_URIS",
  ]);
  for (const [name, binding] of Object.entries(bindings)) {
    assert.equal(typeof binding.description, "string", name);
    assert.match(binding.description, /\p{Script=Han}/u, name);
    assert.match(binding.description, /[A-Za-z]{3}/, name);
  }
  assert.match(bindings.COOKIE_SECRET.description, /openssl rand -hex 32/);
  assert.match(bindings.OWNER_OPEN_ID.description, /pending/);
});

test("wrangler config omits PUBLIC_URL and auto-provisions KV", () => {
  const config = parseJsonc(read("wrangler.jsonc"));
  assert.equal(Object.hasOwn(config.vars, "PUBLIC_URL"), false);
  assert.equal(Object.hasOwn(config, "previews"), false);
  assert.equal(config.account_id, undefined);
  assert.deepEqual(config.kv_namespaces, [{ binding: "OAUTH_KV" }]);
});

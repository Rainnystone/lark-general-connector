// Seam: AGENTS.md, the runbook a coding agent reads.
// Catches a missing shared deploy order, a region that leaves that order, or a missing locked rule.
// Misses a live deploy that reaches the bootstrap page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FEISHU_SCOPES } from "../src/scopes.ts";

const runbook = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

function headings(body) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("### "))
    .map((line) => line.slice(4));
}

function scopesBlock(text) {
  const match = text.match(/```scopes\n([\s\S]*?)```/);
  assert.ok(match, "scopes block");
  return match[1].replace(/\n$/, "").split("\n");
}

const deployOrder = [
  "1. Create the app",
  "2. Deploy",
  "3. Set the redirect",
  "4. Publish",
  "5. Connect a client",
  "6. Bootstrap login shows open_id",
  "7. Set OWNER_OPEN_ID",
  "8. Reconnect",
];


test("the runbook follows the shared deploy order", () => {
  assert.deepEqual(headings(runbook), deployOrder);
});

test("both regions use that order and the mapped console hosts", () => {
  const body = runbook;
  assert.match(body, /same order/);
  assert.match(body, /https:\/\/open\.feishu\.cn\/app/);
  assert.match(body, /https:\/\/open\.larksuite\.com\/app/);
  assert.match(body, /accounts\.feishu\.cn/);
  assert.match(body, /mcp\.feishu\.cn/);
  assert.match(body, /accounts\.larksuite\.com/);
  assert.match(body, /mcp\.larksuite\.com/);
  assert.match(body, /FEISHU_REGION:feishu/);
  assert.match(body, /FEISHU_REGION:lark/);
});

test("locked rules are explicit", () => {
  assert.match(runbook, /Never write secrets into files, commits or chat\./);
  assert.match(runbook, /Never deploy over an existing Worker name without the human's confirmation\./);
  assert.match(runbook, /Never widen scopes, tools or the endpoint allowlist\./);
  assert.match(runbook, /Do not type the existing Worker name yourself\./);
});

test("publish tells the human to enable the Bot capability first", () => {
  assert.match(runbook, /enables the Bot capability \(机器人\) on the custom app before publishing/);
  const englishReadme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const chineseReadme = readFileSync(new URL("../README.zh-CN.md", import.meta.url), "utf8");
  assert.match(englishReadme, /Enable the Bot capability \(机器人\) on the custom app before publishing\./);
  assert.match(chineseReadme, /发布之前，在自建应用里开通机器人能力（Bot）。/);
});

test("human-only steps tell the agent to wait", () => {
  const waits = runbook.match(/Stop\. Wait for the human\./g) ?? [];
  assert.ok(waits.length >= 5, `waits ${waits.length}`);
});

test("the wizard and the equivalent wrangler commands are both written down", () => {
  const body = runbook;
  assert.match(body, /npm run setup/);
  assert.match(body, /wrangler login/);
  assert.match(body, /deployments list --name/);
  assert.match(body, /wrangler deploy --name/);
  assert.match(body, /secret put FEISHU_APP_ID/);
  assert.match(body, /secret put FEISHU_APP_SECRET/);
  assert.match(body, /secret put COOKIE_SECRET/);
  assert.match(body, /secret put OWNER_OPEN_ID/);
  assert.match(body, /openssl rand -hex 32/);
  assert.match(body, /\[code: 10007\]/);
  assert.match(body, /pending/);
  assert.match(body, /\/callback/);
  assert.match(body, /\/mcp/);
  assert.match(body, /stdin/);
  assert.match(body, /Owner not configured/);
  assert.match(body, /403/);
});

test("the scope block is exactly FEISHU_SCOPES", () => {
  assert.deepEqual(scopesBlock(runbook), [...FEISHU_SCOPES]);
});

test("the README scope blocks are exactly FEISHU_SCOPES", () => {
  for (const name of ["../README.md", "../README.zh-CN.md"]) {
    const readme = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.deepEqual(scopesBlock(readme), [...FEISHU_SCOPES], name);
  }
});

function larkCliCommands(body) {
  return [...body.matchAll(/`(lark-cli [^`]*)`/g)].map((match) => match[1]).filter((command) => command !== "lark-cli --version");
}

test("every Lark CLI command names the connector's own profile", () => {
  const body = runbook;
  const commands = larkCliCommands(body);
  assert.ok(commands.length >= 6, `lark-cli commands ${commands.length}`);
  for (const command of commands) {
    assert.match(command, /--(profile|name) <profile>/, command);
  }
});

test("Lark CLI login is narrowed to one connector scope and logged out", () => {
  assert.ok(FEISHU_SCOPES.includes("contact:user.base:readonly"));
  const body = runbook;
  const logins = larkCliCommands(body).filter((command) => command.includes("auth login"));
  assert.ok(logins.length >= 2);
  for (const login of logins) {
    assert.match(login, /--scope contact:user\.base:readonly|--device-code/, login);
  }
  assert.match(body, /auth logout/);
  assert.match(body, /auth status --json \| node --experimental-strip-types scripts\/owner-open-id\.mjs \| npx wrangler secret put OWNER_OPEN_ID/);
});

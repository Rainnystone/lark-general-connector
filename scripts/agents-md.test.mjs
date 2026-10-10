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

test("both READMEs add the sheet example, type row, bulk-import tip, upgrade FAQ, and twenty-five tools", () => {
  const english = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const chinese = readFileSync(new URL("../README.zh-CN.md", import.meta.url), "utf8");
  assert.match(english, /Read the weekly summary sheet and tell me who hasn't filled it in yet\./);
  assert.match(chinese, /读一下周报表格，看看谁还没填。/);
  assert.match(english, /\*\*Sheets, Bases, slides, files\*\*/);
  assert.match(chinese, /\*\*表格、多维表格、幻灯片、文件\*\*/);
  assert.match(english, /formulas too/);
  assert.match(english, /Edit mind notes/);
  assert.match(english, /docs, sheets, Bases, slides and files in your own cloud space/);
  assert.match(english, /Deleting a Base field or record, or a slide page, can't be undone/);
  assert.match(chinese, /删掉多维表格的字段或记录，或删掉一页幻灯片，无法撤销/);
  assert.match(english, /bulk import \(批量导入\)/);
  assert.match(english, /scopes\.import\.json/);
  assert.match(chinese, /批量导入/);
  assert.match(chinese, /scopes\.import\.json/);
  assert.match(english, /I updated the connector\. How do I turn on the new features\?/);
  assert.match(chinese, /更新了连接器，新功能怎么打开？/);
  assert.match(english, /A Lark console may not offer every scope yet/);
  assert.match(chinese, /Lark 控制台可能还没有全部权限/);
  assert.match(english, /Twenty-five tools/);
  assert.match(chinese, /二十五个工具/);
  assert.match(english, /`read_sheet`/);
  assert.match(english, /`write_sheet`/);
  assert.match(english, /`read_bitable`/);
  assert.match(english, /`write_bitable`/);
  assert.match(english, /`read_slides`/);
  assert.match(english, /`write_slides`/);
  assert.match(english, /`read_file`/);
  assert.match(english, /`write_file`/);
  assert.match(english, /`read_mindnote`/);
  assert.match(english, /256 KiB/);
  assert.match(english, /10 MiB/);
  assert.match(english, /new `file_token`/);
  assert.match(chinese, /`read_sheet`/);
  assert.match(chinese, /`read_mindnote`/);
  assert.match(chinese, /256 KiB/);
  assert.match(chinese, /10 MiB/);
  for (const heading of ["What it can and cannot do", "FAQ", "Technical reference (for developers)"]) {
    assert.match(english, new RegExp(`## ${heading.replace(/[()]/g, "\\$&")}`));
  }
  for (const heading of ["它能做什么、不能做什么", "常见问题", "技术参考（给开发者）"]) {
    assert.match(chinese, new RegExp(`## ${heading.replace(/[()（）]/g, "\\$&")}`));
  }
});

test("the runbook names the widened delete, bulk-import file, and existing-Worker upgrade", () => {
  assert.match(runbook, /Doc delete only moves one cloud-space docx, sheet, bitable, slides or file/);
  assert.match(runbook, /scopes\.import\.json/);
  assert.match(runbook, /Upgrade an existing Worker/);
  assert.match(runbook, /Never widen scopes, tools or the endpoint allowlist\./);
});

test("CONTEXT.md names the file inline cap and in-doc delete", () => {
  const context = readFileSync(new URL("../CONTEXT.md", import.meta.url), "utf8");
  assert.match(context, /\*\*File inline cap\*\*/);
  assert.match(context, /256 KiB/);
  assert.match(context, /\*\*In-doc delete\*\*/);
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
  for (const command of larkCliCommands(body).filter((line) => /--device-code <|auth logout/.test(line))) {
    assert.match(command, />\/dev\/null 2>&1$/, command);
  }
  assert.match(body, /removes every app-identity scope before publishing/);
  for (const command of larkCliCommands(body).filter((line) => line.includes("config init"))) {
    assert.match(command, /\| grep --line-buffered -iv secret$/, command);
  }
  for (const command of larkCliCommands(body).filter((line) => line.includes("config show"))) {
    assert.match(command, /\| grep -o 'cli_\[0-9A-Za-z\]\*'/, command);
  }
  assert.match(body, /Node\.js 22\.6 or newer/);
  assert.match(body, /auth status --json \| node --experimental-strip-types scripts\/owner-open-id\.mjs \| npx wrangler secret put OWNER_OPEN_ID/);
});

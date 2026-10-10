// Seam: AGENTS.md, the runbook a coding agent reads.
// Catches a missing shared deploy order, a region that leaves that order, or a missing locked rule.
// Misses a live deploy that reaches the bootstrap page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FEISHU_SCOPES } from "../src/scopes.ts";

const text = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

function section(heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, heading);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

function headings(body) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("### "))
    .map((line) => line.slice(4));
}

const englishOrder = [
  "1. Create the app",
  "2. Deploy",
  "3. Set the redirect",
  "4. Publish",
  "5. Connect a client",
  "6. Bootstrap login shows open_id",
  "7. Set OWNER_OPEN_ID",
  "8. Reconnect",
];

const chineseOrder = [
  "1. 创建应用",
  "2. 部署",
  "3. 设置重定向",
  "4. 发布",
  "5. 连接客户端",
  "6. 引导登录显示 open_id",
  "7. 设置 OWNER_OPEN_ID",
  "8. 重新连接",
];

test("English and Chinese sections follow the shared deploy order", () => {
  assert.deepEqual(headings(section("## English")), englishOrder);
  assert.deepEqual(headings(section("## 中文")), chineseOrder);
});

test("both regions use that order and the mapped console hosts", () => {
  for (const body of [section("## English"), section("## 中文")]) {
    assert.match(body, /same order|都用这一顺序/);
    assert.match(body, /https:\/\/open\.feishu\.cn\/app/);
    assert.match(body, /https:\/\/open\.larksuite\.com\/app/);
    assert.match(body, /accounts\.feishu\.cn/);
    assert.match(body, /mcp\.feishu\.cn/);
    assert.match(body, /accounts\.larksuite\.com/);
    assert.match(body, /mcp\.larksuite\.com/);
    assert.match(body, /FEISHU_REGION:feishu/);
    assert.match(body, /FEISHU_REGION:lark/);
  }
});

test("locked rules are explicit in both languages", () => {
  const english = section("## English");
  const chinese = section("## 中文");
  assert.match(english, /Never write secrets into files, commits or chat\./);
  assert.match(english, /Never deploy over an existing Worker name without the human's confirmation\./);
  assert.match(english, /Never widen scopes, tools or the endpoint allowlist\./);
  assert.match(english, /Do not type the existing Worker name yourself\./);
  assert.match(chinese, /不要把密钥写入文件、提交或对话。/);
  assert.match(chinese, /未经人类确认，不要覆盖已存在的 Worker 名称。/);
  assert.match(chinese, /不要放宽权限、工具或端点允许列表。/);
  assert.match(chinese, /不要自己输入已存在的 Worker 名称。/);
});

test("publish tells the human to enable the Bot capability first", () => {
  assert.match(section("## English"), /enables the Bot capability \(机器人\) on the custom app before publishing/);
  assert.match(section("## 中文"), /在发布之前，于自建应用开通机器人能力（Bot）/);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const english = readme.slice(readme.indexOf("## English"), readme.indexOf("## 中文"));
  const chinese = readme.slice(readme.indexOf("## 中文"));
  assert.match(english, /Enable the Bot capability \(机器人\) on the custom app before publishing\./);
  assert.match(chinese, /发布之前，在自建应用里开通机器人能力（Bot）。/);
});

test("human-only steps tell the agent to wait", () => {
  const englishWaits = section("## English").match(/Stop\. Wait for the human\./g) ?? [];
  const chineseWaits = section("## 中文").match(/停下来。等人类完成。/g) ?? [];
  assert.ok(englishWaits.length >= 5, `english waits ${englishWaits.length}`);
  assert.ok(chineseWaits.length >= 5, `chinese waits ${chineseWaits.length}`);
});

test("the wizard and the equivalent wrangler commands are both written down", () => {
  for (const body of [section("## English"), section("## 中文")]) {
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
  }
});

test("the scope block is exactly FEISHU_SCOPES", () => {
  const match = text.match(/```scopes\n([\s\S]*?)```/);
  assert.ok(match, "scopes block");
  assert.deepEqual(match[1].replace(/\n$/, "").split("\n"), [...FEISHU_SCOPES]);
});

import { randomBytes } from "node:crypto";
import { configuredOwner } from "../src/auth/open-id.ts";
import { FEISHU_SCOPES } from "../src/scopes.ts";
import { consoleUrl, parseFeishuRegion, regionHosts } from "../src/feishu/region.ts";

export function renderSetupGuide(region, origin) {
  const parsed = parseFeishuRegion(region);
  if (parsed === null) throw new Error("invalid FEISHU_REGION");
  const hosts = regionHosts(parsed);
  const link = consoleUrl(parsed);
  const callbackUrl = new URL("/callback", origin).href;
  const lines = [
    "在开放平台创建应用，并开通下面的全部权限。",
    "Create the app in the open platform and enable every scope below.",
    `控制台 Console: ${link}`,
    `Open API: https://${hosts.open}`,
    `账号 Accounts: https://${hosts.accounts}`,
    `MCP: https://${hosts.mcp}`,
    `重定向 Redirect URI: ${callbackUrl}`,
    "权限 Scopes:",
    ...FEISHU_SCOPES,
  ];
  return {
    consoleUrl: link,
    hosts,
    callbackUrl,
    scopes: [...FEISHU_SCOPES],
    text: lines.join("\n"),
  };
}

export function interpretWorkerLookup(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0) return "present";
  if (text.includes("[code: 10007]")) return "absent";
  return "unknown";
}

export async function guardWorkerName({ name, run, confirm }) {
  const result = await run(["deployments", "list", "--name", name, "--json"]);
  const status = interpretWorkerLookup(result);
  if (status === "unknown") return { action: "refuse", status };
  if (status === "absent") return { action: "proceed", status };
  const typed = await confirm();
  if (typed.trim() === name) return { action: "proceed", status };
  return { action: "refuse", status };
}

export function generateCookieSecret(bytes = randomBytes) {
  const secret = bytes(32).toString("hex");
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("cookie secret generator failed");
  return secret;
}

export async function putWorkerSecret({ workerName, key, value, run }) {
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
    throw new Error(`refusing to send ${key}`);
  }
  const result = await run(["secret", "put", key, "--name", workerName], { input: value });
  if (result.code !== 0) throw new Error(`wrangler secret put ${key} failed`);
  return result;
}

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isWorkerName(name) {
  return WORKER_NAME.test(name);
}

export function originFromDeployOutput(output, workerName) {
  const escaped = workerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`https://${escaped}(?:\\.[a-z0-9-]+)+\\.workers\\.dev\\b`, "i"));
  return match ? match[0] : null;
}

function isHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function isSingleLine(value) {
  return value.length > 0 && !value.includes("\n") && !value.includes("\r");
}

async function askUntil(io, message, accept) {
  for (;;) {
    const answer = String(await io.prompt(message)).trim();
    if (accept(answer)) return answer;
    io.write("输入无效。 That answer is not valid.");
  }
}

async function askSecret(io, message, accept) {
  for (;;) {
    const value = String(await io.secret(message)).trim();
    if (accept(value)) return value;
    io.write("输入无效，请重试。没有保存这个值。 That value is not valid. Nothing was saved.");
  }
}

async function pause(io, message) {
  await io.prompt(`${message}\n完成后按回车。 Press enter when this step is done.`);
}

async function putSecrets(io, entries, run) {
  try {
    for (const entry of entries) {
      await putWorkerSecret({ workerName: entry.workerName, key: entry.key, value: entry.value, run });
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "wrangler secret put failed";
    io.write(`${message}\n已停止。 Stopped.`);
    return false;
  }
}

export async function runSetup({ io, run, bytes } = {}) {
  io.write([
    "这个向导会把连接器部署到你自己的 Cloudflare 账号，并在只有你能完成的步骤停下来。",
    "This wizard deploys the connector into your own Cloudflare account and pauses at each step only you can do.",
  ].join("\n"));

  const regionAnswer = await askUntil(
    io,
    "区域 Region：输入 feishu（飞书，直接回车默认）或 lark（Lark）。\nEnter feishu (Feishu; press enter for the default) or lark (Lark).",
    (value) => value === "" || parseFeishuRegion(value) !== null,
  );
  const region = regionAnswer === "" ? "feishu" : regionAnswer;
  const name = await askUntil(
    io,
    "Worker 名称 Worker name：只能用小写字母、数字和连字符。\nLowercase letters, numbers, and hyphens only.",
    isWorkerName,
  );

  const login = await run(["login"], { inherit: true });
  if (login.code !== 0) {
    io.write("登录失败，已停止，没有部署。 Login failed. Stopped. Nothing was deployed.");
    return { status: "stopped" };
  }

  const decision = await guardWorkerName({
    name,
    run,
    confirm: () => io.prompt("这个名称已存在。要覆盖部署，请再次输入完全相同的名称；直接回车会停止。\nThis name already exists. Type it again exactly to deploy over it, or press enter to stop."),
  });
  if (decision.action !== "proceed") {
    io.write("已停止，没有部署。 Stopped. Nothing was deployed.");
    return { status: "stopped" };
  }

  io.write(`控制台 Console: ${consoleUrl(region)}`);
  await pause(io, "创建应用 Create the app：在上面的控制台创建一个企业自建应用。\nCreate the app in the console above.");
  const appId = await askSecret(
    io,
    "FEISHU_APP_ID：凭证页上的 App ID。不会回显，也不会写入文件。\nApp ID from the credentials page. It is not echoed or written to a file.",
    isSingleLine,
  );
  const appSecret = await askSecret(
    io,
    "FEISHU_APP_SECRET：同一页的 App Secret。不会回显，也不会写入文件。\nApp Secret from that page. It is not echoed or written to a file.",
    isSingleLine,
  );

  const deployed = await run(["deploy", "--name", name, "--var", `FEISHU_REGION:${region}`], { interactive: true });
  if (deployed.code !== 0) {
    io.write("部署失败，已停止。密钥没有写入。 Deploy failed. Stopped. No secrets were written.");
    return { status: "stopped" };
  }

  const found = originFromDeployOutput(`${deployed.stdout}\n${deployed.stderr}`, name);
  const origin = found ?? await askUntil(
    io,
    "没有从部署输出里找到地址。请粘贴 https 开头的源，不要带路径。\nNo origin was found in the deploy output. Paste the https origin, with no path.",
    isHttpsOrigin,
  );
  const cookie = generateCookieSecret(bytes);
  const saved = await putSecrets(io, [
    { workerName: name, key: "FEISHU_APP_ID", value: appId },
    { workerName: name, key: "FEISHU_APP_SECRET", value: appSecret },
    { workerName: name, key: "COOKIE_SECRET", value: cookie },
    { workerName: name, key: "OWNER_OPEN_ID", value: "pending" },
  ], run);
  if (!saved) return { status: "stopped" };

  const guide = renderSetupGuide(region, origin);
  io.write(guide.text);
  await pause(io, "开通权限 Add the scopes：在应用里开通上面列出的每一项权限。权限管理里可以用批量导入，粘贴 scopes.import.json。\nAdd the scopes: enable every scope listed above. In Permissions & Scopes, you can bulk import (批量导入) and paste scopes.import.json.");
  await pause(io, "设置重定向 Set the redirect：把上面的 Redirect URI 填进应用的重定向 URL。\nSet the redirect: paste the Redirect URI above into the app.");
  await pause(io, "发布或申请审核 Publish：发布之前，在自建应用里开通机器人能力（Bot）。然后发布应用，或按管理员要求申请权限。\nPublish: enable the Bot capability (机器人) on the custom app before publishing. Then publish the app, or apply for approval.");
  const mcp = new URL("/mcp", origin).href;
  io.write(`先用这个地址连接客户端。 Connect a client at this address first.\nMCP: ${mcp}`);
  await pause(io, "连接客户端 Connect a client：把上面的 /mcp 地址加到 Claude 或 ChatGPT 并完成登录。页面会拒绝访问，且只显示你的 open_id。\nConnect a client: add the /mcp URL above to Claude or ChatGPT and finish login. The page denies access and shows only your open_id.");
  const openId = await askSecret(
    io,
    "OWNER_OPEN_ID：粘贴登录页上的 open_id。不会回显，也不会写入文件。\nPaste the open_id from the login page. It is not echoed or written to a file.",
    (value) => configuredOwner(value) === value,
  );
  const ownerSaved = await putSecrets(io, [
    { workerName: name, key: "OWNER_OPEN_ID", value: openId },
  ], run);
  if (!ownerSaved) return { status: "stopped" };

  io.write([
    "所有者已写入。请断开客户端后重新连接。",
    "The owner is saved. Reconnect the client.",
    `MCP: ${mcp}`,
  ].join("\n"));
  return { status: "done", origin, mcpUrl: mcp };
}

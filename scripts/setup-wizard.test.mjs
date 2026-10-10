// Seams: the printed setup guide (scopes and region links), and the worker-name collision decision from a wrangler lookup.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FEISHU_SCOPES } from "../src/scopes.ts";
import { runCommand } from "./setup.mjs";
import { consoleUrl, regionHosts } from "../src/feishu/region.ts";
import { generateCookieSecret, guardWorkerName, putWorkerSecret, renderSetupGuide, runSetup } from "./setup-wizard.mjs";

const origin = "https://example.workers.dev";

test("feishu setup guide prints the mapped console link, hosts, callback, and scope constant", () => {
  const guide = renderSetupGuide("feishu", origin);
  assert.equal(guide.consoleUrl, "https://open.feishu.cn/app");
  assert.equal(guide.consoleUrl, consoleUrl("feishu"));
  assert.deepEqual(guide.hosts, {
    open: "open.feishu.cn",
    accounts: "accounts.feishu.cn",
    mcp: "mcp.feishu.cn",
  });
  assert.deepEqual(guide.hosts, regionHosts("feishu"));
  assert.equal(guide.callbackUrl, "https://example.workers.dev/callback");
  assert.deepEqual(guide.scopes, [...FEISHU_SCOPES]);
  assert.match(guide.text, /\p{Script=Han}/u);
  assert.match(guide.text, /Redirect URI/);
  assert.equal(guide.text.includes("larksuite.com"), false);
  for (const scope of FEISHU_SCOPES) {
    assert.equal(guide.text.includes(scope), true, scope);
  }
});

test("lark setup guide prints larksuite console links and hosts from the region mapping", () => {
  const guide = renderSetupGuide("lark", origin);
  assert.equal(guide.consoleUrl, "https://open.larksuite.com/app");
  assert.equal(guide.consoleUrl, consoleUrl("lark"));
  assert.deepEqual(guide.hosts, {
    open: "open.larksuite.com",
    accounts: "accounts.larksuite.com",
    mcp: "mcp.larksuite.com",
  });
  assert.deepEqual(guide.hosts, regionHosts("lark"));
  assert.equal(guide.callbackUrl, "https://example.workers.dev/callback");
  assert.deepEqual(guide.scopes, [...FEISHU_SCOPES]);
  assert.equal(guide.text.includes("feishu.cn"), false);
  assert.match(guide.text, /\p{Script=Han}/u);
  assert.match(guide.text, /Redirect URI/);
});

const workerName = "example-worker";

function lookupArgs() {
  return ["deployments", "list", "--name", workerName, "--json"];
}

test("refuses an existing Worker name unless the user types that name again", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "[]", stderr: "" };
  };
  let confirmed = false;
  const refused = await guardWorkerName({
    name: workerName,
    run,
    confirm: async () => {
      confirmed = true;
      return "not-the-name";
    },
  });
  assert.equal(refused.action, "refuse");
  assert.equal(confirmed, true);
  assert.deepEqual(calls, [lookupArgs()]);

  const allowed = await guardWorkerName({
    name: workerName,
    run,
    confirm: async () => `  ${workerName}  `,
  });
  assert.equal(allowed.action, "proceed");
  assert.deepEqual(calls, [lookupArgs(), lookupArgs()]);
});

test("allows a Worker name when wrangler reports that it does not exist", async () => {
  let confirmed = false;
  const decision = await guardWorkerName({
    name: workerName,
    run: async (args) => {
      assert.deepEqual(args, lookupArgs());
      return {
        code: 1,
        stdout: "",
        stderr: "A request to the Cloudflare API (/accounts/example/workers/scripts/example-worker/deployments) failed.\n  This Worker does not exist on your account. [code: 10007]\n",
      };
    },
    confirm: async () => {
      confirmed = true;
      return workerName;
    },
  });
  assert.equal(decision.action, "proceed");
  assert.equal(confirmed, false);
});

test("refuses to treat a failed wrangler lookup as a free Worker name", async () => {
  let confirmed = false;
  const decision = await guardWorkerName({
    name: workerName,
    run: async () => ({ code: 1, stdout: "", stderr: "Not logged in. Run wrangler login." }),
    confirm: async () => {
      confirmed = true;
      return workerName;
    },
  });
  assert.equal(decision.action, "refuse");
  assert.equal(decision.status, "unknown");
  assert.equal(confirmed, false);
});

test("puts a secret only through wrangler secret put stdin", async () => {
  let seen;
  await putWorkerSecret({
    workerName,
    key: "COOKIE_SECRET",
    value: "generated-value",
    run: async (args, options) => {
      seen = { args, input: options.input };
      return { code: 0, stdout: "uploaded", stderr: "" };
    },
  });
  assert.deepEqual(seen.args, ["secret", "put", "COOKIE_SECRET", "--name", workerName]);
  assert.equal(seen.input, "generated-value");
  assert.equal(seen.args.join(" ").includes("generated-value"), false);
});

test("a failed secret put names the key and does not repeat the value", async () => {
  await assert.rejects(
    () => putWorkerSecret({
      workerName,
      key: "FEISHU_APP_SECRET",
      value: "generated-value",
      run: async () => ({ code: 1, stdout: "", stderr: "boom generated-value" }),
    }),
    (error) => {
      assert.equal(String(error.message).includes("generated-value"), false);
      assert.match(error.message, /FEISHU_APP_SECRET/);
      return true;
    },
  );
});

test("refuses an empty or multiline secret before calling wrangler", async () => {
  let called = false;
  const run = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(() => putWorkerSecret({ workerName, key: "COOKIE_SECRET", value: "", run }));
  await assert.rejects(() => putWorkerSecret({ workerName, key: "COOKIE_SECRET", value: "line\nbreak", run }));
  assert.equal(called, false);
});

test("generates a 32-byte hex cookie secret", () => {
  const secret = generateCookieSecret(() => Buffer.alloc(32, 0x3c));
  assert.equal(secret, "3c".repeat(32));
});

const cookieSecret = "3c".repeat(32);

function scriptedIo({ regions, names, confirm = "", secrets }) {
  const written = [];
  const prompts = [];
  const openIds = [...(secrets?.openIds ?? [])];
  return {
    written,
    prompts,
    write(text) {
      written.push(String(text));
    },
    async prompt(message) {
      prompts.push(message);
      if (message.includes("Region")) return regions.shift() ?? "";
      if (message.includes("Worker name")) return names.shift() ?? "";
      if (message.includes("already exists")) return confirm;
      return "";
    },
    async secret(message) {
      prompts.push(`secret:${message}`);
      if (message.includes("FEISHU_APP_SECRET")) return secrets.appSecret;
      if (message.includes("FEISHU_APP_ID")) return secrets.appId;
      if (message.includes("open_id")) return openIds.shift() ?? "";
      throw new Error("unexpected secret prompt");
    },
  };
}

function fakeWrangler({ exists = false, deployCode = 0, loginCode = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async run(args, options = {}) {
      calls.push({
        args: [...args],
        input: options.input,
        inherit: options.inherit === true,
        interactive: options.interactive === true,
      });
      if (args[0] === "login") return { code: loginCode, stdout: "", stderr: "" };
      if (args[0] === "deployments") {
        if (exists) return { code: 0, stdout: "[]", stderr: "" };
        return { code: 1, stdout: "", stderr: "This Worker does not exist on your account. [code: 10007]\n" };
      }
      if (args[0] === "deploy") {
        const name = args[args.indexOf("--name") + 1];
        const url = ["https://", name, ".example.workers.dev"].join("");
        return { code: deployCode, stdout: deployCode === 0 ? `Deployed ${name} triggers\n  ${url}\n` : "", stderr: "" };
      }
      if (args[0] === "secret") return { code: 0, stdout: "uploaded\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  };
}

const secrets = {
  appId: "cli_test",
  appSecret: "test-app-secret",
  openIds: ["pending", "ou_owner"],
};

test("a new Worker name deploys, prints the region guide, and sends secrets only on stdin", async () => {
  const io = scriptedIo({
    regions: ["nope", "lark"],
    names: ["My Worker", workerName],
    secrets,
  });
  const wrangler = fakeWrangler();
  const result = await runSetup({
    io,
    run: wrangler.run,
    bytes: () => Buffer.alloc(32, 0x3c),
  });
  assert.equal(result.status, "done");
  const commands = wrangler.calls.map((call) => call.args[0]);
  assert.deepEqual(commands, ["login", "deployments", "deploy", "secret", "secret", "secret", "secret", "secret"]);
  assert.equal(wrangler.calls[0].inherit, true);
  const deploy = wrangler.calls[2];
  assert.deepEqual(deploy.args, ["deploy", "--name", workerName, "--var", "FEISHU_REGION:lark"]);
  assert.equal(deploy.interactive, true);
  assert.equal(wrangler.calls[1].interactive, false);
  const secretCalls = wrangler.calls.filter((call) => call.args[0] === "secret");
  assert.deepEqual(secretCalls.map((call) => call.args[2]), [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "COOKIE_SECRET",
    "OWNER_OPEN_ID",
    "OWNER_OPEN_ID",
  ]);
  assert.deepEqual(secretCalls.map((call) => call.input), [
    "cli_test",
    "test-app-secret",
    cookieSecret,
    "pending",
    "ou_owner",
  ]);
  const callback = ["https://", workerName, ".example.workers.dev/callback"].join("");
  const mcp = ["https://", workerName, ".example.workers.dev/mcp"].join("");
  const shown = io.written.join("\n");
  assert.equal(shown.includes("https://open.larksuite.com/app"), true);
  assert.equal(shown.includes("search:docs:read"), true);
  assert.equal(shown.includes(callback), true);
  assert.equal(shown.includes(mcp), true);
  assert.equal(shown.includes("feishu.cn"), false);
  assert.match(shown, /\p{Script=Han}/u);
  assert.match(shown, /Reconnect/);
  for (const call of wrangler.calls) {
    const flat = call.args.join(" ");
    assert.equal(flat.includes("test-app-secret"), false);
    assert.equal(flat.includes("cli_test"), false);
    assert.equal(flat.includes("ou_owner"), false);
    assert.equal(flat.includes(cookieSecret), false);
  }
  assert.equal(shown.includes("test-app-secret"), false);
  assert.equal(shown.includes("cli_test"), false);
  assert.equal(shown.includes("ou_owner"), false);
  assert.equal(shown.includes(cookieSecret), false);
  const asked = io.prompts.join("\n");
  assert.match(asked, /创建应用/);
  assert.match(asked, /Create the app/);
  assert.match(asked, /开通权限/);
  assert.match(asked, /Add the scopes/);
  assert.match(asked, /scopes\.import\.json/);
  assert.match(asked, /批量导入/);
  assert.match(asked, /设置重定向/);
  assert.match(asked, /Set the redirect/);
  assert.match(asked, /发布/);
  assert.match(asked, /Publish/);
  assert.match(asked, /发布之前，在自建应用里开通机器人能力（Bot）/);
  assert.match(asked, /enable the Bot capability \(机器人\) on the custom app before publishing/);
  assert.match(asked, /连接客户端/);
  assert.match(asked, /Connect a client/);
});

test("an empty region answer deploys feishu", async () => {
  const io = scriptedIo({ regions: [""], names: [workerName], secrets });
  const wrangler = fakeWrangler();
  const result = await runSetup({ io, run: wrangler.run, bytes: () => Buffer.alloc(32, 0x3c) });
  assert.equal(result.status, "done");
  const deploy = wrangler.calls.find((call) => call.args[0] === "deploy");
  assert.equal(deploy.args.includes("FEISHU_REGION:feishu"), true);
});

test("an existing Worker name does not deploy when the typed confirmation does not match", async () => {
  const io = scriptedIo({ regions: ["feishu"], names: [workerName], confirm: "nope" });
  const wrangler = fakeWrangler({ exists: true });
  const result = await runSetup({ io, run: wrangler.run, bytes: () => Buffer.alloc(32, 0x3c) });
  assert.equal(result.status, "stopped");
  assert.deepEqual(wrangler.calls.map((call) => call.args[0]), ["login", "deployments"]);
  const shown = io.written.join("\n");
  assert.match(shown, /没有部署/);
  assert.match(shown, /Nothing was deployed/);
});

test("typing the existing Worker name back is what allows deploy", async () => {
  const io = scriptedIo({
    regions: ["feishu"],
    names: [workerName],
    confirm: workerName,
    secrets,
  });
  const wrangler = fakeWrangler({ exists: true });
  const result = await runSetup({ io, run: wrangler.run, bytes: () => Buffer.alloc(32, 0x3c) });
  assert.equal(result.status, "done");
  assert.equal(wrangler.calls.some((call) => call.args[0] === "deploy"), true);
  assert.equal(wrangler.calls.find((call) => call.args[0] === "deploy").args.includes("FEISHU_REGION:feishu"), true);
});

test("a failed deploy writes no secrets", async () => {
  const io = scriptedIo({ regions: ["lark"], names: [workerName], secrets });
  const wrangler = fakeWrangler({ deployCode: 1 });
  const result = await runSetup({ io, run: wrangler.run, bytes: () => Buffer.alloc(32, 0x3c) });
  assert.equal(result.status, "stopped");
  assert.equal(wrangler.calls.some((call) => call.args[0] === "secret"), false);
  assert.match(io.written.join("\n"), /No secrets were written/);
});

test("the command runner sends a secret on stdin and not as an argument", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-"));
  const script = join(root, "echo-stdin.mjs");
  await writeFile(script, [
    "let data = \"\";",
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.on(\"data\", (chunk) => { data += chunk; });",
    "process.stdin.on(\"end\", () => {",
    "  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), stdin: data.trimEnd() }));",
    "});",
    "",
  ].join("\n"));
  try {
    const result = await runCommand(process.execPath, [script, "secret", "put", "COOKIE_SECRET", "--name", workerName], {
      input: "generated-value",
      echo: false,
    });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.args, ["secret", "put", "COOKIE_SECRET", "--name", workerName]);
    assert.equal(parsed.stdin, "generated-value");
    assert.equal(parsed.args.join(" ").includes("generated-value"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed login does not look up or deploy a Worker", async () => {
  const io = scriptedIo({ regions: ["feishu"], names: [workerName] });
  const wrangler = fakeWrangler({ loginCode: 1 });
  const result = await runSetup({ io, run: wrangler.run, bytes: () => Buffer.alloc(32, 0x3c) });
  assert.equal(result.status, "stopped");
  assert.deepEqual(wrangler.calls.map((call) => call.args[0]), ["login"]);
  assert.match(io.written.join("\n"), /Nothing was deployed/);
});

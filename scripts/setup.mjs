import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { runSetup } from "./setup-wizard.mjs";

const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function runCommand(command, args, options = {}) {
  const inherit = options.inherit === true;
  const interactive = options.interactive === true;
  const hasInput = options.input !== undefined;
  const stdio = inherit ? "inherit" : hasInput ? ["pipe", "pipe", "pipe"] : interactive ? ["inherit", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd ?? repoRoot, stdio });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.on("error", (error) => finish({ code: 1, stdout: "", stderr: error.message }));
    if (inherit) {
      child.on("close", (code) => finish({ code: code ?? 1, stdout: "", stderr: "" }));
      return;
    }
    let stdoutText = "";
    let stderrText = "";
    child.stdout.on("data", (chunk) => {
      stdoutText += chunk;
      if (options.echo !== false) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrText += chunk;
      if (options.echo !== false) process.stderr.write(chunk);
    });
    if (hasInput) {
      child.stdin.on("error", () => {});
      child.stdin.write(options.input.endsWith("\n") ? options.input : `${options.input}\n`);
      child.stdin.end();
    }
    child.on("close", (code) => finish({ code: code ?? 1, stdout: stdoutText, stderr: stderrText }));
  });
}

function readHidden(message) {
  if (!stdin.isTTY) {
    return Promise.reject(new Error("密钥只能在交互终端里输入。 Secrets can only be entered in an interactive terminal."));
  }
  stdout.write(`${message}\n> `);
  stdin.setRawMode(true);
  stdin.resume();
  const chars = [];
  let skippingEscape = false;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (buf) => {
      const text = buf.toString("utf8");
      for (const char of text) {
        if (skippingEscape) {
          if ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "~") skippingEscape = false;
          continue;
        }
        if (char === "\u0003") {
          cleanup();
          const error = new Error("cancelled");
          error.code = "CANCELLED";
          reject(error);
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(chars.join(""));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          chars.pop();
          continue;
        }
        if (char === "\u001b") {
          skippingEscape = true;
          continue;
        }
        if (char >= " ") chars.push(char);
      }
    };
    stdin.on("data", onData);
  });
}

function createCliIo(rl) {
  return {
    write(text) {
      stdout.write(`${text}\n`);
    },
    prompt(message) {
      return rl.question(`${message}\n> `);
    },
    async secret(message) {
      rl.pause();
      try {
        return await readHidden(message);
      } finally {
        rl.resume();
      }
    },
    close() {
      rl.close();
    },
  };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const io = createCliIo(rl);
  rl.on("SIGINT", () => {
    stdout.write("\n已取消。 Cancelled.\n");
    rl.close();
    process.exit(1);
  });
  const run = (args, options) => {
    rl.pause();
    return runCommand(process.execPath, [wranglerBin, ...args], options).finally(() => rl.resume());
  };
  try {
    const result = await runSetup({ io, run });
    process.exitCode = result.status === "done" ? 0 : 1;
  } catch (error) {
    if (error?.code === "CANCELLED") stdout.write("已取消。 Cancelled.\n");
    else stdout.write(`${error instanceof Error ? error.message : "setup failed"}\n`);
    process.exitCode = 1;
  } finally {
    io.close();
  }
}

if (invokedDirectly()) await main();

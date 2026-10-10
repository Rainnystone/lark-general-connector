// Pipe `lark-cli auth status --json` in and `wrangler secret put OWNER_OPEN_ID` out,
// so the owner's open_id reaches Cloudflare without passing through an agent's transcript.
// The status JSON shape is Lark CLI's, not ours: accept exactly one open_id anywhere in it.
import { realpathSync } from "node:fs";
import { argv, stdin, stdout, stderr, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { configuredOwner } from "../src/auth/open-id.ts";

export function ownerOpenId(text) {
  const start = text.indexOf("{");
  if (start < 0) return { error: "no JSON on stdin" };
  let json;
  try {
    json = JSON.parse(text.slice(start));
  } catch {
    return { error: "stdin is not JSON" };
  }
  const found = new Set();
  collect(json, found);
  if (found.size === 1) return { openId: [...found][0] };
  return { error: found.size === 0 ? "no open_id in the status output" : "more than one open_id in the status output" };
}

function collect(value, found) {
  if (typeof value === "string") {
    if (configuredOwner(value) === value) found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collect(item, found);
  }
}

const isMain = argv[1] !== undefined && realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  let text = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) text += chunk;
  const result = ownerOpenId(text);
  if (result.error) {
    // The message never includes an id, so a failed pipe leaks nothing.
    stderr.write(`owner-open-id: ${result.error}\n`);
    exit(1);
  }
  stderr.write("owner-open-id: lark-cli must be logged in with this connector's app\n");
  stdout.write(result.openId);
}

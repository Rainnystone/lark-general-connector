// Seam: ownerOpenId, the filter between `lark-cli auth status --json` and `wrangler secret put OWNER_OPEN_ID`.
// Catches a status output with no open_id, more than one, or a malformed value reaching the secret.
// Misses a change in what Lark CLI means by its current user.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ownerOpenId } from "./owner-open-id.mjs";

test("finds the one open_id wherever the status output puts it", () => {
  const status = JSON.stringify({ appId: "app", users: [{ name: "Owner", userOpenId: "ou_ownerExample1" }] });
  assert.deepEqual(ownerOpenId(status), { openId: "ou_ownerExample1" });
});

test("skips log lines before the JSON", () => {
  assert.deepEqual(ownerOpenId('Checking status...\n{"user":{"open_id":"ou_ownerExample1"}}'), { openId: "ou_ownerExample1" });
});

test("counts a repeated open_id once", () => {
  const status = JSON.stringify({ current: "ou_ownerExample1", users: [{ id: "ou_ownerExample1" }] });
  assert.deepEqual(ownerOpenId(status), { openId: "ou_ownerExample1" });
});

test("refuses two different open_ids", () => {
  const status = JSON.stringify({ users: [{ id: "ou_ownerExample1" }, { id: "ou_otherExample2" }] });
  assert.equal(ownerOpenId(status).error, "more than one open_id in the status output");
});

test("refuses output with no open_id", () => {
  assert.equal(ownerOpenId('{"loggedIn":false}').error, "no open_id in the status output");
  assert.equal(ownerOpenId('{"id":"ou_bad value"}').error, "no open_id in the status output");
});

test("refuses output that is not JSON", () => {
  assert.equal(ownerOpenId("not logged in").error, "no JSON on stdin");
  assert.equal(ownerOpenId("{ broken").error, "stdin is not JSON");
});

test("the CLI prints only the open_id, and on failure prints no id", () => {
  const script = fileURLToPath(new URL("./owner-open-id.mjs", import.meta.url));
  const run = (input) => spawnSync(process.execPath, ["--experimental-strip-types", script], { input, encoding: "utf8" });

  const ok = run('{"user":{"open_id":"ou_ownerExample1"}}');
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "ou_ownerExample1");

  const failed = run('{"users":[{"id":"ou_ownerExample1"},{"id":"ou_otherExample2"}]}');
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.doesNotMatch(failed.stderr, /ou_/);
});

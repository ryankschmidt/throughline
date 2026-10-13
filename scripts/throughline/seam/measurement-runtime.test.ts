import { test } from "node:test";
import assert from "node:assert/strict";
import { capture, hash, join, posix } from "./measurement-runtime.ts";

test("Effect measurement adapter preserves SHA256 bytes and POSIX Git paths", () => {
  assert.equal(hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hash(new TextEncoder().encode("abc")), hash("abc"));
  assert.equal(posix.normalize(posix.join("apps/mobile/src", "../file.ts")), "apps/mobile/file.ts");
  assert.equal(join("/root", "file"), "/" + "root/file");
});
test("Effect measurement capture preserves separate stdout stderr and nonzero exit", async () => {
  const child =
    "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>{process.stdout.write(s);process.stderr.write('fixture stderr\\n');process.exitCode=7;});";
  const r = await capture(process.execPath, ["-e", child], { input: "fixture π\n" });
  assert.deepEqual(r, { stdout: "fixture π\n", stderr: "fixture stderr\n", status: 7 });
});

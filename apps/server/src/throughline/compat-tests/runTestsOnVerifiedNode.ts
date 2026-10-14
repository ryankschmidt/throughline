// @effect-diagnostics nodeBuiltinImport:off - package test launcher; runs before any Effect runtime exists.
/**
 * The server package's `test` script. The server V2 fixture runs the server inside the test
 * process and refuses any runner other than its verified private Node. When this host carries
 * that exact runtime, the tests run on it; otherwise they run on the current Node and the
 * fixture's own identity check refuses, unchanged.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { VERIFIED_FIXTURE_NODE, VERIFIED_FIXTURE_NODE_SHA256 } from "./verifiedFixtureNode.ts";

function verifiedNodeDirectory(): string | null {
  try {
    if (NodeFS.realpathSync(VERIFIED_FIXTURE_NODE) !== VERIFIED_FIXTURE_NODE) return null;
    const hash = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(VERIFIED_FIXTURE_NODE))
      .digest("hex");
    return hash === VERIFIED_FIXTURE_NODE_SHA256 ? NodePath.dirname(VERIFIED_FIXTURE_NODE) : null;
  } catch {
    return null;
  }
}

const directory = verifiedNodeDirectory();
const env = directory
  ? { ...process.env, PATH: [directory, process.env.PATH].filter(Boolean).join(NodePath.delimiter) }
  : process.env;
const vp = NodePath.join(
  NodePath.dirname(NodeModule.createRequire(import.meta.url).resolve("vite-plus/package.json")),
  "bin",
  "vp",
);
const run = NodeChildProcess.spawnSync(
  directory ? VERIFIED_FIXTURE_NODE : process.execPath,
  [vp, "test", "run", ...process.argv.slice(2)],
  { env, stdio: "inherit" },
);
process.exit(run.status ?? 1);

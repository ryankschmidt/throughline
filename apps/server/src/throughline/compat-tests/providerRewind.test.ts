// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import {
  assertProviderPackageExports,
  resolvePackagedProviderInputs,
  assertPackagedRelease,
} from "./providerRewind.ts";

describe("release-compatible packaged inputs (synthetic metadata only)", () => {
  const root = "/Users/Admin/throughline-worktrees/artifacts/synthetic-057";
  const custody = {
    release: "0.0.57",
    source_sha: "a".repeat(40),
    canonical_artifact_root: root,
    executable: root + "/side-app/ThroughLine.app/Contents/MacOS/ThroughLine",
    asar: root + "/side-app/ThroughLine.app/Contents/Resources/app.asar",
    public_server_entry:
      root + "/side-app/ThroughLine.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
    zip: root + "/artifacts/actual-057.zip",
    zip_sha256: "b".repeat(64),
    asar_sha256: "c".repeat(64),
    executable_sha256: "d".repeat(64),
    offline_import_authorized: true,
  };
  it("uses declared .57 paths and release metadata without a .51 filename", () => {
    const inputs = resolvePackagedProviderInputs(root, custody);
    expect(inputs.zip).toBe(custody.zip);
    expect(inputs.release).toBe("0.0.57");
    expect(inputs.source_sha).toBe(custody.source_sha);
    expect(() => assertPackagedRelease(inputs, "0.0.57")).not.toThrow();
  });
  it("rejects an archive/package release mismatch", () => {
    expect(() =>
      assertPackagedRelease(resolvePackagedProviderInputs(root, custody), "0.0.51"),
    ).toThrow("Packaged version differs");
  });
  it.each([
    { release: undefined, package_version: "0.0.57" },
    { source_sha: "short" },
    { zip: root + "/../foreign.zip" },
    { zip_sha256: "missing" },
    { offline_import_authorized: false },
    { canonical_artifact_root: root + "-other" },
    { public_server_entry: custody.asar + "/private.mjs" },
  ])("refuses incomplete or unsafe public custody %j before execution", (change) => {
    expect(() => resolvePackagedProviderInputs(root, { ...custody, ...change })).toThrow();
  });
});

describe("public V2 provider package metadata (not population acceptance)", () => {
  it("reads the public server export without retired private factories", () => {
    expect(
      assertProviderPackageExports({
        name: "@t3tools/provider-pi",
        exports: { "./server": { import: "./src/server.ts" } },
      }),
    ).toEqual({
      name: "@t3tools/provider-pi",
      exportKeys: ["./server"],
      behaviorProven: false,
    });
  });
  it.each([
    undefined,
    { name: "retired-provider", exports: { "./server": {} } },
    { name: "@t3tools/provider-pi", exports: {} },
  ])("refuses missing or foreign public package metadata", (metadata) => {
    expect(() => assertProviderPackageExports(metadata)).toThrow();
  });
});

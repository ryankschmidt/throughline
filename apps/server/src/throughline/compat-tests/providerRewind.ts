// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

/** Public release custody only; reject missing fields before readers or execution. */
export function resolvePackagedProviderInputs(artifactRoot: string, value: unknown) {
  const root = NodePath.resolve(artifactRoot);
  if (!root.startsWith("/Users/Admin/throughline-worktrees/artifacts/"))
    throw new Error("Packaged consumers require the relocated artifact root.");
  if (!value || typeof value !== "object") throw new Error("Public custody must be an object.");
  const custody = value as Record<string, unknown>;
  const text = (key: string, pattern?: RegExp) => {
    const field = custody[key];
    if (typeof field !== "string" || !field || (pattern && !pattern.test(field)))
      throw new Error(`Missing or invalid public custody field: ${key}`);
    return field;
  };
  const release = text("release", /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  const source_sha = text("source_sha", /^[a-f0-9]{40}$/);
  if (text("canonical_artifact_root") !== root)
    throw new Error("Public custody artifact root differs from the requested root.");
  if (custody.offline_import_authorized !== true)
    throw new Error("Public offline import is not explicitly authorized.");
  const member = (key: string) => {
    const file = text(key);
    if (
      !NodePath.isAbsolute(file) ||
      NodePath.resolve(file) !== file ||
      !file.startsWith(root + NodePath.sep)
    )
      throw new Error(`Public custody path escapes the artifact root: ${key}`);
    return file;
  };
  const executable = member("executable");
  const archive = member("asar");
  const entry = member("public_server_entry");
  if (entry !== NodePath.join(archive, "apps/server/dist/bin.mjs"))
    throw new Error("Public server entry is not the packaged bin.mjs entry.");
  return {
    root,
    release,
    source_sha,
    executable,
    archive,
    entry,
    zip: member("zip"),
    hashes: {
      zip: text("zip_sha256", /^[a-f0-9]{64}$/),
      archive: text("asar_sha256", /^[a-f0-9]{64}$/),
      executable: text("executable_sha256", /^[a-f0-9]{64}$/),
    },
  };
}

export function assertPackagedRelease(custody: { release: string }, packageVersion: string) {
  if (packageVersion !== custody.release)
    throw new Error("Packaged version differs from source custody release.");
}

/** Public package metadata is custody, never native rewind behavior proof. */
export function assertProviderPackageExports(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Provider package metadata is missing.");
  const metadata = value as { name?: unknown; exports?: unknown };
  if (metadata.name !== "@t3tools/provider-pi") throw new Error("Unexpected provider package.");
  if (!metadata.exports || typeof metadata.exports !== "object")
    throw new Error("Provider package exports are missing.");
  const exports = metadata.exports as Record<string, unknown>;
  if (!Object.hasOwn(exports, "./server"))
    throw new Error("Public provider server export is missing.");
  return { name: metadata.name, exportKeys: Object.keys(exports).sort(), behaviorProven: false };
}

/** Read/consume existing packaged bytes only. No bundler, GUI or backend startup. */
export async function inspectPackagedProviderContract(input: {
  artifactRoot: string;
  custodyManifest: string;
  asarReader: string;
  fuseReader: string;
  outputParent: string;
}) {
  const custody = resolvePackagedProviderInputs(
    input.artifactRoot,
    JSON.parse(NodeFS.readFileSync(input.custodyManifest, "utf8")),
  );
  const { root, archive, executable, zip, entry } = custody;
  for (const file of [archive, executable, zip]) {
    if (!NodeFS.existsSync(file))
      throw new Error(`Declared packaged member is not available: ${file}`);
    if (!NodeFS.realpathSync(file).startsWith(NodeFS.realpathSync(root) + NodePath.sep))
      throw new Error("Declared packaged member resolves outside artifact custody.");
  }
  const hashFile = (file: string) =>
    new Promise<string>((resolve, reject) => {
      const hash = NodeCrypto.createHash("sha256");
      const stream = NodeFS.createReadStream(file);
      stream.on("data", (bytes) => hash.update(bytes));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  const hashZipMember = (member: string) =>
    new Promise<string>((resolve, reject) => {
      const hash = NodeCrypto.createHash("sha256");
      const child = NodeChildProcess.spawn("/usr/bin/unzip", ["-p", zip, member], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout.on("data", (bytes) => hash.update(bytes));
      child.on("error", reject);
      child.on("close", (status) =>
        status === 0
          ? resolve(hash.digest("hex"))
          : reject(new Error(`ZIP member custody read failed: ${member}, exit ${status}`)),
      );
    });
  const zipSha256 = await hashFile(zip);
  const archiveSha256 = await hashFile(archive);
  const executableSha256 = await hashFile(executable);
  const zipArchiveSha256 = await hashZipMember("ThroughLine.app/Contents/Resources/app.asar");
  const zipExecutableSha256 = await hashZipMember("ThroughLine.app/Contents/MacOS/ThroughLine");
  if (archiveSha256 !== zipArchiveSha256 || executableSha256 !== zipExecutableSha256)
    throw new Error("Expanded packaged bytes do not match ZIP custody.");
  if (
    zipSha256 !== custody.hashes.zip ||
    archiveSha256 !== custody.hashes.archive ||
    executableSha256 !== custody.hashes.executable
  )
    throw new Error("Produced bytes do not match public custody hashes.");
  const archiveModule = await import(NodeURL.pathToFileURL(input.asarReader).href);
  const reader = (archiveModule.default ?? archiveModule) as {
    extractFile(archive: string, member: string): Buffer;
  };
  const fuseModule = await import(NodeURL.pathToFileURL(input.fuseReader).href);
  const fuses = (await fuseModule.getCurrentFuseWire(executable)) as Record<string, unknown>;
  if (fuses.version !== "1" || fuses["0"] !== 49)
    throw new Error("Produced executable has no proven RunAsNode fuse; GUI startup is forbidden.");
  const member = "apps/server/dist/bin.mjs";
  const serverBytes = reader.extractFile(archive, member);
  const source = serverBytes.toString("utf8");
  const pkg = JSON.parse(reader.extractFile(archive, "package.json").toString("utf8")) as {
    version: string;
  };
  assertPackagedRelease(custody, pkg.version);
  NodeFS.mkdirSync(input.outputParent, { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(input.outputParent, "packaged-contract-"));
  const home = NodePath.join(directory, "home");
  const backendHome = NodePath.join(directory, "backend-home");
  NodeFS.mkdirSync(home);
  NodeFS.mkdirSync(backendHome);
  const env = {
    ELECTRON_RUN_AS_NODE: "1",
    HOME: home,
    XDG_CONFIG_HOME: home,
    T3CODE_HOME: backendHome,
    PATH: "/usr/bin:/bin",
    NO_COLOR: "1",
  };
  const run = (args: string[]) => {
    const result = NodeChildProcess.spawnSync(executable, args, {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 128 * 1024,
    });
    return {
      args,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
  const interpreter = run([
    "-e",
    'process.stdout.write(JSON.stringify({node:process.version,executable:process.execPath,home:require("node:os").homedir()})+"\\n")',
  ]);
  if (interpreter.status !== 0)
    throw new Error("Packaged Node-mode interpreter did not run; no backend was launched.");
  const actualInterpreter = JSON.parse(interpreter.stdout.trim()) as {
    node: string;
    executable: string;
    home: string;
  };
  if (actualInterpreter.home !== home || actualInterpreter.executable !== executable)
    throw new Error("Packaged executable HOME isolation was not established.");
  const help = run([entry, "--help"]);
  if (
    help.status !== 0 ||
    !help.stdout.includes("--base-dir") ||
    !help.stdout.includes("--no-browser")
  )
    throw new Error("Packaged public CLI isolation contract is unavailable.");
  // Dynamic import executes the unmodified packaged module, not its main CLI.
  const exportsProbe = run([
    "-e",
    `import(${JSON.stringify(NodeURL.pathToFileURL(entry).href)}).then(m => process.stdout.write(JSON.stringify(Object.keys(m).sort())+"\\n"));`,
  ]);
  if (exportsProbe.status !== 0) throw new Error("Packaged export consumer did not run.");
  const publicExports = JSON.parse(exportsProbe.stdout.trim()) as string[];
  // Inspect the actual packaged public contract, not retired factories on bin.mjs.
  const providerPackageContract = assertProviderPackageExports(
    JSON.parse(reader.extractFile(archive, "packages/provider-pi/package.json").toString("utf8")),
  );
  const refusal = "Thread rollback is not supported by the Pi provider";
  const refusalOffset = source.indexOf(refusal);
  const nativeBridgeMarkers = ["throughline_rewind", "tl-rewind-", "navigation.mjs"].map(
    (value) => ({ value, present: source.includes(value) }),
  );
  const receipt = {
    schema: "throughline.packaged-provider-contract.v1",
    sourceSha: custody.source_sha,
    snapshot: {
      release: custody.release,
      sourceSha: custody.source_sha,
      sourceBinding: "producer custody; full packaged source identity not independently exposed",
    },
    packageVersion: pkg.version,
    artifactRoot: root,
    zip,
    archive,
    executable,
    member,
    hashes: {
      zip: zipSha256,
      archive: archiveSha256,
      executable: executableSha256,
      serverEntry: NodeCrypto.createHash("sha256").update(serverBytes).digest("hex"),
    },
    zipCustodyMatched: true,
    directory,
    home,
    backendHome,
    interpreter,
    actualInterpreter,
    help,
    exportsProbe,
    publicExports,
    providerPackageContract,
    legacyPiRefusalMarker: {
      present: refusalOffset >= 0,
      byteOffset: refusalOffset,
      currentOwningSource: "packages/provider-pi/src/server/adapter.ts",
      excerpt:
        refusalOffset >= 0 ? source.slice(refusalOffset - 160, refusalOffset + 100) : undefined,
    },
    legacyNativeBridgeMarkers: nativeBridgeMarkers,
    providerAcceptance:
      "not proven: static markers, interpreter and public CLI exports do not execute native provider rewind",
    backendStarted: false,
    guiStarted: false,
    modelRequests: false,
    credentialsRead: false,
    freshlyBundledFixtureUsed: false,
  };
  NodeFS.writeFileSync(
    NodePath.join(directory, "Packaged-Consumer-Receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return receipt;
}

// Completes the same bounded source-measurement packet without rerunning W1/W2.
import {
  capture,
  hash,
  join,
  posix,
  readBytes,
  readText,
  write,
  now,
  log,
} from "./measurement-runtime.ts";
import ts from "typescript-legacy";
import { git } from "./repo-binding.ts";
import { nameStatuses } from "./classify.ts";
type Row = { path: string; [key: string]: unknown };
type Packet = {
  schema: string;
  fork_head: string;
  upstream_pin: string;
  W1: Record<string, unknown>;
  W2: Record<string, unknown> & {
    hook_cases: { name: string; stderr_path: string; refusal: string }[];
  };
  W3: Record<string, unknown> & { entries: Row[] };
  W4: Record<string, unknown> & { rows: Row[] };
  W5: Record<string, unknown> & { files: (Row & { diff: string; changed_lines: string[] })[] };
  W6: Record<string, unknown>;
  W7: Record<string, unknown>;
  [key: string]: unknown;
};
const root = "/Users/Admin/throughline",
  home =
    "/Users/Admin/core-root/vault/01_Projects/workbench/infra/throughline/plans/next-gen-spec-2026-10-07/execution/phase-04/upstream-tax-design";
const output = join(home, "Worker-Seam-Return-01.json"),
  j = JSON.parse(await readText(output)) as Packet;
const head = j.fork_head,
  pin = j.upstream_pin,
  source = (p: string, sha = head) => git(root, "show", `${sha}:${p}`);
const evidence = (path: string, start: number, end: number) => ({
  path: join(root, path),
  commit: head,
  start_line: start,
  end_line: end,
  quote: source(path)
    .split("\n")
    .slice(start - 1, end)
    .join("\n"),
  command: `/usr/bin/git -C ${root} show ${head}:${path} | sed -n '${start},${end}p'`,
});
const follow = (path: string) =>
  git(root, "log", "--follow", "--format=%H %s", "-n", "4", pin, "--", path).trim();
for (const c of j.W2.hook_cases)
  c.refusal =
    (await readText(c.stderr_path))
      .split("\n")
      .find((line) => /^Error: UPSTREAM_TAX_REFUSED:/.test(line)) ?? c.refusal;
j.W2.command_contract_evidence = {
  path: "/Users/Admin/core-root/src/tools/throughline-ship/dist/upstream-tax.js",
  sha256: hash(
    await readBytes("/Users/Admin/core-root/src/tools/throughline-ship/dist/upstream-tax.js"),
  ),
  approval_path_gate_lines: [59, 60],
  baseline_history_gate_lines: [75, 76],
  actual_error: "UPSTREAM_TAX_REFUSED: TAX_APPROVAL_PATH",
};
j.W2.ledger_write_state =
  "Written only to the working ledger; not staged or committed. Canonical index unchanged. This ordered JSON shape does not pass the currently installed policy and is not enforcement-ready.";
const reasonLedger = JSON.parse(await readText(join(root, "throughline-seam.json"))) as {
  tax_policy: { approved_growth_files: { path: string; reason: string }[] };
  entries: { path: string; reason: string }[];
};
j.W2.reason_copy_check = reasonLedger.tax_policy.approved_growth_files.map((g) => ({
  path: g.path,
  byte_exact_reason: reasonLedger.entries.find((e) => e.path === g.path)?.reason === g.reason,
}));

const successors: Record<
  string,
  { paths: string[]; basis: string; evidence: ReturnType<typeof evidence>[] }
> = {
  "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts": {
    paths: [
      "apps/server/src/orchestration-v2/EffectWorker.ts",
      "apps/server/src/orchestration-v2/ProviderTurnStartService.ts",
    ],
    basis:
      "Responsibility split, not a Git rename: claimed outbox effects are executed by EffectWorker.layerExecutor; provider-turn.start delegates to ProviderTurnStartService.start. The old reactor was removed during the V2 migration.",
    evidence: [
      evidence("apps/server/src/orchestration-v2/EffectWorker.ts", 98, 113),
      evidence("apps/server/src/orchestration-v2/EffectWorker.ts", 152, 164),
    ],
  },
  "apps/server/src/orchestration/runtimeLayer.ts": {
    paths: ["apps/server/src/orchestration-v2/runtimeLayer.ts"],
    basis:
      "V2 assembly exports stores, event sink, provided effect executor and worker; no old V1 path remains.",
    evidence: [evidence("apps/server/src/orchestration-v2/runtimeLayer.ts", 311, 329)],
  },
  "apps/server/src/provider/Layers/CodexAdapter.ts": {
    paths: ["apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts"],
    basis:
      "Responsibility successor, not proven path rename: V2 Codex adapter owns native Codex operations and calls the carried provider utilities.",
    evidence: [evidence("apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts", 1, 20)],
  },
  "apps/server/src/provider/Layers/PiSessionRuntime.ts": {
    paths: ["packages/provider-pi/src/server/adapter.ts"],
    basis:
      "Responsibility successor, not proven path rename: package PiAdapterV2 drives Pi RPC process/session/turn lifecycle under the provider package boundary.",
    evidence: [evidence("packages/provider-pi/src/server/adapter.ts", 1, 25)],
  },
};
const migration = "de343914273eceb852a1d1d739cd1d38df7796ee";
const renameChanges = nameStatuses(
  git(root, "diff", "--name-status", "-z", "-M", migration + "^", migration),
);
for (const row of j.W3.entries) {
  const resolved = successors[row.path];
  row.upstream_follow_command = `/usr/bin/git log --follow --format='%H %s' -n 4 ${pin} -- ${row.path}`;
  if (!row.path.endsWith("/")) row.upstream_follow = follow(row.path);
  row.v2_migration_name_status = renameChanges.filter(
    (x) => x.path === row.path || x.renamedFrom === row.path,
  );
  row.v2_migration_diff_command = `/usr/bin/git diff --name-status -z -M ${migration}^ ${migration}`;
  if (resolved) {
    row.successor_path = resolved.paths[0];
    row.successor_paths = resolved.paths;
    row.successor_basis = resolved.basis;
    row.successor_evidence = resolved.evidence;
    row.successor_certainty =
      "source-grounded responsibility mapping, not accepted behavior parity";
    row.original_spec_path_at_pin = row.upstream_path_at_pin;
    row.upstream_responsibility_paths_at_pin = resolved.paths.filter((p) => {
      try {
        git(root, "cat-file", "-e", `${pin}:${p}`);
        return true;
      } catch {
        return false;
      }
    });
    row.upstream_successor_check_command = resolved.paths.map(
      (p) => `/usr/bin/git cat-file -e ${pin}:${p}`,
    );
  } else {
    row.successor_paths = [row.path];
    row.successor_basis =
      "The current path remains; the three restored stock paths carry no fork delta. Directory entries expand to the exact upstream-edit rows listed, not a single physical file.";
  }
}
j.W3.status = "measured";
j.W3.successors_named = j.W3.entries.filter((x) => typeof x.successor_path === "string").length;
j.W3.not_measured = [
  "No before/after feature equivalence or moved-code acceptance. Responsibility splits are explicitly not Git rename claims.",
];

for (const row of j.W4.rows) {
  const path = row.path,
    content = source(path),
    isCode = /\.(ts|tsx)$/.test(path);
  const diff = git(
    root,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--unified=1",
    pin,
    head,
    "--",
    path,
  );
  row.changed_fork_lines = diff
    .split("\n")
    .filter((x) => x.startsWith("+") && !x.startsWith("+++"));
  row.changed_fork_lines_command = `/usr/bin/git diff --no-ext-diff --no-textconv --no-renames --unified=1 ${pin} ${head} -- ${path}`;
  const regex = "import[[:space:]]*\\(|[A-Za-z_$][A-Za-z0-9_$]*\\.[A-Za-z_$]";
  const grep = await capture("grep", ["-nE", regex], {
    input: content,
  });
  const grepPath = join(home, "Worker-Seam-Scan-" + path.replaceAll("/", "_") + "-01.txt");
  await write(grepPath, grep.stdout ?? "");
  row.grep_scan = {
    command: `/usr/bin/git show ${head}:${path} | grep -nE '${regex}'`,
    exit_code: grep.status,
    matched_lines: (grep.stdout ?? "").split("\n").filter(Boolean).length,
    output_path: grepPath,
  };
  if (!isCode) {
    row.mount_lines =
      path === ".vite-hooks/pre-commit" ? [{ line: 1, quote: content.split("\n")[0] }] : [];
    row.mount_classification =
      path === ".vite-hooks/pre-commit"
        ? "one installed policy call plus stock formatter line"
        : "metadata/configuration entry, not a single executable mount";
    row.strictly_needed_private_imports = [];
    row.private_import_scope =
      "No TypeScript private imports apply to metadata or this shell mount.";
    row.fork_side_consumer_modules =
      path === ".vite-hooks/pre-commit"
        ? ["/Users/Admin/core-root/src/tools/throughline-ship/dist/upstream-tax.js"]
        : path === "apps/mobile/package.json"
          ? ["apps/mobile/src/throughline/runtime-compat/entry.ts"]
          : [];
    row.dynamic_import_scan =
      "not applicable: shell/JSON/YAML; no JS import-expression acceptance inferred from parsing metadata";
    row.upstream_internal_property_access_scan = "not applicable to non-TypeScript source";
    continue;
  }
  const sf = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imported: { symbol: string; module: string; fork: boolean }[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const mod = stmt.moduleSpecifier.text,
      resolved = mod.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), mod)) : mod,
      fork = /(^|\/)throughline\/|^packages\/throughline-[^/]+\//.test(resolved),
      c = stmt.importClause;
    if (c?.name) imported.push({ symbol: c.name.text, module: mod, fork });
    if (c?.namedBindings) {
      if (ts.isNamespaceImport(c.namedBindings))
        imported.push({ symbol: c.namedBindings.name.text, module: mod, fork });
      else
        for (const v of c.namedBindings.elements)
          imported.push({ symbol: v.name.text, module: mod, fork });
    }
  }
  const mountStatements = new Map<number, ts.Statement>();
  function collect(n: ts.Node) {
    if (ts.isIdentifier(n) && imported.some((i) => i.fork && i.symbol === n.text)) {
      let p: ts.Node | undefined = n;
      while (p && !ts.isStatement(p)) p = p.parent;
      if (p && ts.isStatement(p) && !ts.isImportDeclaration(p))
        mountStatements.set(p.getStart(sf), p);
    }
    ts.forEachChild(n, collect);
  }
  collect(sf);
  const mounts = [...mountStatements.values()].map((s) => ({
    line: sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1,
    end_line: sf.getLineAndCharacterOfPosition(s.end).line + 1,
    quote: s.getText(sf),
  }));
  row.mount_lines = mounts;
  const needed = imported.filter(
    (i) =>
      !i.fork &&
      i.module.startsWith(".") &&
      mounts.some((m) => new RegExp(`\\b${i.symbol}\\b`).test(m.quote)),
  );
  row.private_bindings_used_in_exact_mount_regions = needed;
  row.mount_region_needed_private_binding_count = needed.length;
  row.strictly_needed_private_imports =
    "not measured: lexical dependencies of the quoted current integration region are listed separately; a minimal extracted mount is not designed or accepted in this order";
  row.private_import_scope =
    "The ledger total covers whole-file imports, including unchanged upstream code; the exact quoted mount-region subset is separately listed. Region usage is not proof that a future minimal mount must retain every wiring dependency.";
  row.fork_side_consumer_modules = [
    ...new Set(imported.filter((x) => x.fork).map((x) => x.module)),
  ];
  row.mount_classification = mounts.length
    ? "quoted fork-namespace integration regions; not certified single-line mounts"
    : "no current fork-namespace mount: changed fork body/re-exports are quoted in changed_fork_lines";
  row.conflict_rule_needs_authorship =
    row.conflict_rule_source !== "authored" || row.conflict_rule_inferred !== false;
  row.not_measured = [
    "Minimal post-extraction interface imports and transitive/computed alias coupling. No new conflict rule or acceptance of keep proposal.",
  ];
}
j.W4.status =
  "partial: source scans and current integration quotes measured; strictly minimal private-import design not measured";
j.W4.not_measured = [
  "Strict minimal post-extraction imports cannot be established for bodies that have no namespace mount yet. Quoted current integration-region dependencies are measured, not a design-verified acceptance.",
  "No conflict-rule authorship invented; needs-authorship rows explicitly named.",
];

function hierarchy(content: string) {
  const stack: { indent: number; key: string }[] = [],
    out: string[] = [];
  for (const line of content.split("\n")) {
    const m = /^(\s*)(.+?):(?:\s|$)/.exec(line);
    if (m) {
      const indent = m[1]!.length;
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      stack.push({ indent, key: m[2]!.replace(/^['"]|['"]$/g, "") });
    }
    out.push(stack.map((x) => x.key).join("/"));
  }
  return out;
}
function lockReason(context: string, line: string): string {
  if (context.includes("expo-notifications"))
    return "Bind the carried notification Swift regression patch and its exact peer-resolved package snapshot.";
  if (context.includes("expo-modules-core"))
    return "Bind the carried Expo native-module compatibility patch and its exact peer-resolved package snapshot.";
  if (context.includes("expo-speech-recognition"))
    return "Pin the mobile native dictation package and its Expo/React Native peers.";
  if (context.includes("agent-mcp-relay"))
    return "Pin the local relay tarball bytes used by the fork's legacy MCP relay adapter.";
  if (
    context.includes("absurd-runtime") ||
    context.includes("absurd-sdk") ||
    context.includes("@types/pg")
  )
    return "Resolve the fork durable-runtime workspace, Absurd/Postgres runtime and type dependencies reproducibly.";
  if (context.includes("task-workspaces"))
    return "Resolve the added task-workspace package's Node and TypeScript development inputs reproducibly.";
  if (context.includes("core-js"))
    return "Register the already-pinned core-js snapshot for the admitted mobile Array compatibility entry.";
  if (context.includes("esbuild"))
    return "Pin server-side build/instrument tooling; no product-runtime behavior acceptance follows.";
  if (/react|clerk|bippy/.test(context) || /19\.2\.6|19\.3\.0/.test(line))
    return "Converge peer-resolved React/Clerk snapshots on React 19.3.0 instead of carrying duplicate 19.2.6 peer variants.";
  if (/drizzle|alchemy|zod/.test(context))
    return "Re-key peer snapshots after dependency convergence (Postgres types/Zod); this does not add a product feature by itself.";
  if (/\/diff(?:\/|$)/.test(context))
    return "Resolve the newly direct server diff dependency at the same pinned 8.0.3 version.";
  return "Carry the corresponding lockfile dependency/resolution edge of the pinned workspace graph; causal feature intent not independently established for this line.";
}
for (const file of j.W5.files) {
  const path = file.path;
  if (path !== "pnpm-lock.yaml") {
    const old = JSON.parse(source(path, pin)) as {
        version: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      },
      cur = JSON.parse(source(path)) as typeof old;
    const rows: { field: string; old: string | null; current: string; reason: string }[] = [];
    if (cur.version !== old.version)
      rows.push({
        field: "version",
        old: old.version,
        current: cur.version,
        reason:
          "Align this workspace with the current ThroughLine release identity; this is metadata, not an executable mount.",
      });
    for (const group of ["dependencies", "devDependencies"] as const)
      for (const [name, value] of Object.entries(cur[group] ?? {})) {
        if (old[group]?.[name] === value) continue;
        rows.push({
          field: group + "/" + name,
          old: old[group]?.[name] ?? null,
          current: value,
          reason:
            name === "core-js"
              ? "Enable Array compatibility bootstrap with the already-pinned 3.47.0 snapshot."
              : name === "expo-speech-recognition"
                ? "Provide the carried native mobile dictation engine."
                : name === "@ryan/agent-mcp-relay"
                  ? "Provide the fork legacy relay adapter from its versioned local tarball."
                  : name === "@t3tools/absurd-runtime"
                    ? "Provide the fork's durable task/record runtime workspace."
                    : name === "esbuild"
                      ? "Supply server-side build/instrument compilation tooling."
                      : name === "diff"
                        ? "Declare the direct server diff dependency already pinned elsewhere in the workspace."
                        : "Changed dependency measured; causal feature reason not independently established.",
        });
      }
    file.dependency_and_version_lines = rows;
    file.reason_source =
      "worker-authored measured-delta explanation, not approval of new dependencies";
    file.not_measured = [];
  } else {
    const oldLines = hierarchy(source(path, pin)),
      newLines = hierarchy(source(path));
    let before = 0,
      after = 0;
    const changed: {
      kind: string;
      line_number: number;
      quote: string;
      context: string;
      reason: string;
    }[] = [];
    for (const line of git(
      root,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=0",
      pin,
      head,
      "--",
      path,
    ).split("\n")) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) {
        before = Number(h[1]);
        after = Number(h[2]);
        continue;
      }
      if (line.startsWith("---") || line.startsWith("+++")) continue;
      if (line.startsWith("-") || line.startsWith("+")) {
        const kind = line[0] === "+" ? "added" : "removed",
          number = kind === "added" ? after++ : before++,
          context = (kind === "added" ? newLines : oldLines)[number - 1] ?? "";
        changed.push({
          kind,
          line_number: number,
          quote: line.slice(1),
          context,
          reason: lockReason(context, line),
        });
      } else if (line.startsWith(" ")) {
        before++;
        after++;
      }
    }
    file.dependency_and_version_lines = changed;
    file.reason_source =
      "worker-authored per-line delta explanations, semantic dependency chains and patch origins not accepted";
    file.not_measured = [
      "Causal intent for generic transitive resolution lines is explicitly not independently established.",
    ];
  }
}
j.W5.release_identity_feasibility = {
  web: {
    assessment:
      "Feasible for displayed/build-embedded identity without editing apps/web/package.json: Vite already prefers APP_VERSION over pkg.version and embeds APP_VERSION. License input and workspace/package metadata still read manifests; full release acceptance is not proved.",
    evidence: [
      evidence("apps/web/vite.config.ts", 44, 48),
      evidence("apps/web/vite.config.ts", 220, 224),
    ],
  },
  contracts: {
    assessment:
      "No standalone contracts build is declared (source exports plus typecheck/test). Removing its version edit requires the mobile Expo config and any package-version consumers to read one canonical build stamp instead. The release schema accepts supplied identity without reading package version, so a unified build stamp is technically plausible but not currently wired or tested.",
    evidence: [
      evidence("packages/contracts/package.json", 1, 34),
      evidence("packages/contracts/src/releaseIdentity.ts", 24, 40),
      evidence("apps/mobile/app.config.ts", 35, 52),
      evidence("scripts/update-release-package-versions.ts", 49, 54),
      evidence("scripts/update-release-package-versions.ts", 96, 101),
    ],
  },
  not_measured: [
    "No release artifact built, no manifest restored to upstream, no end-to-end stamping/consumer compatibility proof.",
  ],
};
j.W5.status =
  "measured diffs and source feasibility; causal transitive intent and behavior not accepted";
j.W5.not_measured = [
  "Technical feasibility notes only; no release-identity implementation or product/device proof.",
];

j.W6 = {
  status: "measured classification proposal",
  command:
    "/usr/bin/git log PIN --diff-filter=A --format='%H %s' -- PATH; /usr/bin/git diff --numstat PIN HEAD -- PATH; git cat-file -e PRIOR_PIN:PATH",
  files: ["apps/desktop/src/app/DesktopUserData.ts", "apps/desktop/src/main.ts"].map((path) => ({
    path,
    first_upstream_addition: git(
      root,
      "log",
      "--reverse",
      "--diff-filter=A",
      "--format=%H %s",
      pin,
      "--",
      path,
    )
      .trim()
      .split("\n")[0],
    upstream_addition_command: `/usr/bin/git log --reverse --diff-filter=A --format='%H %s' ${pin} -- ${path}`,
    present_at_prior_upstream_pin: (() => {
      try {
        git(root, "cat-file", "-e", `9f48092ec95dd9eab78931601de95be0107a930c:${path}`);
        return true;
      } catch {
        return false;
      }
    })(),
    diff_numstat: git(root, "diff", "--no-ext-diff", "--numstat", pin, head, "--", path).trim(),
    diff: git(root, "diff", "--no-ext-diff", "--unified=1", pin, head, "--", path),
    proposal: path.endsWith("main.ts")
      ? "Import-only adapter substitution: 1 added/1 removed import line routes the existing registration to the fork LegacyLocalStorage module. Not a fork-owned main body; whole-file private import count does not describe this delta."
      : "Two fork policy calls plus branding input type: 4 added/4 removed, retaining the stock user-data filesystem body. Mount-shaped but not R2's single-call-line form. No whole-file divergence demonstrated.",
    fork_side_consumer: path.endsWith("main.ts")
      ? "apps/desktop/src/throughline/LegacyLocalStorage.ts"
      : "apps/desktop/src/throughline/ProfilePolicy.ts",
  })),
  premise_limit:
    "Both paths already exist at the prior upstream 9f48092e pin. Git identifies upstream introduction commits, but does not establish that upstream copied Ryan's fork-only implementation. The physical count transition is not proof of an Oct 11 adoption event.",
  not_measured: [
    "No profile/legacy-storage behavior tests or acceptance of the classification proposal.",
  ],
};
j.W7 = {
  status: "measured source route; HTTP admission-refusal integration test not measured",
  command:
    "Targeted git show/sed of the quoted transport, service, effect-worker and decorator functions; source inspection only",
  routes: [
    {
      transport: "HTTP MCP /mcp",
      entry_file: "apps/server/src/mcp/McpHttpServer.ts",
      entry_function: "layerMcpTransport = McpServer.layerHttp",
      path: "/mcp",
      handler:
        "project toolkit launch handler -> ThreadMessageIntake.launchThread -> ThreadLaunchService.launch",
      evidence: [
        evidence("apps/server/src/mcp/McpHttpServer.ts", 868, 875),
        evidence("apps/server/src/mcp/toolkits/project/handlers.ts", 133, 146),
        evidence("apps/server/src/orchestration-v2/ThreadMessageIntake.ts", 186, 194),
      ],
    },
    {
      transport: "HTTP MCP /mcp",
      handler:
        "orchestrator toolkit send handler -> OrchestratorMcpService.sendToThread -> ThreadManagementService.sendToThread",
      evidence: [
        evidence("apps/server/src/mcp/toolkits/orchestrator/handlers.ts", 129, 141),
        evidence("apps/server/src/mcp/OrchestratorMcpService.ts", 2539, 2568),
      ],
    },
    {
      transport: "HTTP MCP /mcp ComsNet",
      handler: "ComsNet handlers explicitly call IntakeAdmission.dispatchCommand",
      evidence: [evidence("apps/server/src/mcp/toolkits/comsnet/handlers.ts", 143, 156)],
    },
  ],
  obsolete_path:
    "apps/server/src/orchestration/http.ts absent; orchestration-v2/http.ts is snapshot/history reads, not a turn-start mutation endpoint",
  rest_route_evidence: [
    evidence("apps/server/src/orchestration-v2/http.ts", 44, 55),
    evidence("apps/server/src/orchestration-v2/http.ts", 146, 167),
  ],
  decorator: {
    file: "apps/server/src/orchestration-v2/runtimeLayer.ts",
    name: "HeadroomAdmission.layer decorating EffectWorker.layerExecutor",
    signature:
      "OrchestrationEffectExecutorV2Shape.execute(effect, options); effect.request.type === provider-turn.start",
    evidence: [
      evidence("apps/server/src/orchestration-v2/runtimeLayer.ts", 311, 329),
      evidence("apps/server/src/throughline/headroom/HeadroomAdmission.ts", 79, 105),
      evidence("apps/server/src/orchestration-v2/EffectWorker.ts", 152, 164),
    ],
    result:
      "Transport-independent provider-turn.start effects enter the headroom wrapper; it defers fresh known-empty starts to waiting, and forwards unknown/stale headroom. This is not a blanket HTTP/signature denial and is not the planned prompt/intake decorator. Plain MCP project/orchestrator routes use native intake; ComsNet and WS use the separate durable IntakeAdmission wrapper.",
  },
  test: {
    path: "apps/server/src/throughline/headroom/HeadroomAdmission.test.ts",
    name: "known-empty first run waits atomically with no invented provider session and truthful null upstream reset",
    evidence: [
      evidence("apps/server/src/throughline/headroom/HeadroomAdmission.test.ts", 220, 266),
    ],
    scope:
      "controlled decorator unit fixture: executes provider-turn.start effect and asserts starts===0; not a real HTTP-to-engine refusal test",
    executed_this_order: false,
  },
  http_refusal_test:
    "none identified in the bounded inspected source/test set; no claim of exhaustive repository-wide absence",
  not_measured: [
    "No HTTP/MCP-to-decorator integrated refusal run; no installed/native/provider acceptance. The planned generic admission decorator is not mounted by the source quote.",
  ],
};
j.completed_at = now();
j.final_head = git(root, "rev-parse", "HEAD").trim();
j.ledger_sha256 = hash(await readBytes(join(root, "throughline-seam.json")));
j.measurement_instruments = [
  {
    path: join(root, "scripts/throughline/seam/shepherd-measure.ts"),
    sha256: hash(await readBytes(join(root, "scripts/throughline/seam/shepherd-measure.ts"))),
  },
  { path: import.meta.filename, sha256: hash(await readBytes(import.meta.filename)) },
];
j.typecheck = {
  command:
    "PATH=/Users/Admin/.nvm/versions/node/v24.13.1/bin:$PATH node_modules/.bin/tsc --noEmit --allowImportingTsExtensions --module nodenext --moduleResolution nodenext --target es2023 --types node --skipLibCheck scripts/throughline/seam/shepherd-measure.ts scripts/throughline/seam/shepherd-finalize.ts",
  output_path: join(home, "Worker-Seam-Typecheck-Final-01.txt"),
  historical_failure: join(home, "Worker-Seam-Typecheck-01.txt"),
  exit_code: 0,
  diagnostics: 0,
  proof_boundary:
    "Both authored scripts plus imported repository helper/type surfaces only; no repo-wide typecheck or product behavior acceptance.",
};
j.source_scope_check = {
  command: "git status --porcelain=v1 -- throughline-seam.json scripts/throughline/seam/",
  output: git(
    root,
    "status",
    "--porcelain=v1",
    "--",
    "throughline-seam.json",
    "scripts/throughline/seam/",
  ),
  no_stock_edit_except_ledger: true,
  no_view_regeneration: true,
  no_moves: true,
  no_hook_changes: true,
};
j.proactive_errors = [
  "Initial whole-file keep extraction included fork-added bookkeeping rows and generated oversized output; corrected by requiring class upstream-edit and decision keep.",
  "TS7 root module exports version metadata, not the former AST API: first instrument typecheck failed. Reused the already-installed TS6 AST module; no dependencies installed. Historical diagnostics preserved.",
  "Initial hook refusal parser matched the printed throw-source line, not the Error line. Corrected from closed logs without any hook rerun.",
];
await write(output, JSON.stringify(j, null, 2) + "\n");
await log(
  JSON.stringify(
    {
      output,
      count: j.W1.count,
      successors_named: j.W3.successors_named,
      head_unchanged: j.final_head === head,
      W2: "all three exit1 TAX_APPROVAL_PATH; expected-good fails",
      W6: j.W6.status,
      W7: j.W7.status,
    },
    null,
    2,
  ),
);

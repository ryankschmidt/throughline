// Evidence-only worker measurement. No product moves, hook edits or generated views.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
// Inspection uses the already-installed TS6 AST API; TS7's root exports version only.
// No package install or global compiler/model change is performed.
import ts from "../../../node_modules/.pnpm-upmerge-main/typescript@6.0.3/node_modules/typescript/lib/typescript.js";
import { bindRepository, git } from "./repo-binding.ts";
import { classifyFork, nameStatuses, type SeamClass } from "./classify.ts";
import type { SeamEntry, SeamManifest } from "../check-seam.ts";

type Entry = SeamEntry & {
  decision?: string;
  feature?: string;
  reason_author?: string;
  seam_side?: string;
  plan?: { destination?: string; [key: string]: unknown };
  evidence?: Record<string, unknown>;
  approval_state?: string;
};
type Manifest = Omit<SeamManifest, "entries"> & {
  entries: Entry[];
  tax_policy: {
    baseline_count: number;
    baseline_fork: string;
    pinned_upstream: string;
    approved_growth_files: unknown[];
    count_history: { fork: string; upstream: string; count: number; label: string }[];
    [key: string]: unknown;
  };
};
const { root, head } = bindRepository("/Users/Admin/throughline");
const home =
  "/Users/Admin/core-root/vault/01_Projects/workbench/infra/throughline/plans/next-gen-spec-2026-10-07/execution/phase-04/upstream-tax-design";
const output = join(home, "Worker-Seam-Return-01.json");
const upstream = "5cbe82a87006a7ee472f0f9c9fce5d5f24caa795";
const baseline = "e735392d5a4a9b91294f5ba0c4511621b7ae706f";
const command =
  "/Users/Admin/.nvm/versions/node/v24.13.1/bin/node scripts/throughline/seam/shepherd-measure.ts";
const started = new Date().toISOString();
const bytes = readFileSync(join(root, "throughline-seam.json"));
const manifest = JSON.parse(bytes.toString()) as Manifest;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const source = (path: string, ref = head) => git(root, "show", `${ref}:${path}`);
const exists = (path: string, ref = head) => {
  try {
    git(root, "cat-file", "-e", `${ref}:${path}`);
    return true;
  } catch {
    return false;
  }
};
const numstat = (path: string) => {
  const raw = git(
    root,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--numstat",
    upstream,
    head,
    "--",
    `:(literal)${path}`,
  ).trim();
  const [added = "0", removed = "0"] = raw.split("\t");
  return {
    added: added === "-" ? null : Number(added),
    removed: removed === "-" ? null : Number(removed),
    raw,
  };
};
const files = classifyFork(root, upstream, head);
const tax = [...files]
  .filter(([, x]) => ["upstream-edit", "upstream-removed"].includes(x.cls))
  .map(([p]) => p)
  .sort();
const previousTax = manifest.entries
  .filter((x) => ["upstream-edit", "upstream-removed"].includes(x.class))
  .map((x) => x.path)
  .sort();
const originalKeep = manifest.entries.filter(
  (x) => x.class === "upstream-edit" && x.decision === "keep",
);
const added = tax.filter((x) => !previousTax.includes(x)),
  removed = previousTax.filter((x) => !tax.includes(x));
if (manifest.upstream.sha !== upstream) throw Error("UPSTREAM_PIN_MISMATCH");
writeFileSync(join(home, "Worker-Seam-Ledger-Before-01.json"), bytes, { flag: "wx" });
const prior = new Map(manifest.entries.map((e) => [e.path, e]));
manifest.entries = [...files]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, f]): Entry => {
    const saved = prior.get(path);
    if (!saved)
      return {
        path,
        class: f.cls,
        reason: f.commits.join("\n"),
        reason_source: "commit-subjects",
        imported_private_symbols: [],
        schema_assumptions: [],
        contract_inspection: "not measured by this refresh",
        conflict_rule: "review",
        conflict_rule_source: "review",
        conflict_rule_inferred: true,
        marker: f.marker,
        commits: f.commits,
        legacy_rules: [],
        ...(f.renamedFrom ? { renamed_from: f.renamedFrom } : {}),
      };
    const entry: Entry = { ...saved, class: f.cls, commits: f.commits, marker: f.marker };
    if (f.renamedFrom) entry.renamed_from = f.renamedFrom;
    else delete entry.renamed_from;
    return entry;
  });
manifest.fork.sha = head;
manifest.merge_base = git(root, "merge-base", upstream, head).trim();
manifest.counts = { upstream_edit: 0, upstream_removed: 0, fork_added: 0, fork_namespace: 0 };
for (const [, f] of files)
  manifest.counts[f.cls.replaceAll("-", "_") as keyof typeof manifest.counts]++;
manifest.tax_policy.count_history.push({
  fork: head,
  upstream,
  count: tax.length,
  label: "Oct 12 shepherd refresh at HEAD",
});
const growthPaths = [
  "apps/mobile/src/features/diffs/nativeReviewDiffHighlighter.ts",
  "apps/mobile/src/features/diffs/nativeReviewDiffHighlighter.test.ts",
  "apps/mobile/src/features/threads/checkout-new-task-branch.test.ts",
];
const growth = growthPaths.map((path) => {
  const entry = manifest.entries.find((x) => x.path === path);
  if (!entry) throw Error(`MISSING_GROWTH_ROW ${path}`);
  const log = git(root, "log", "--follow", "--format=%H", `${baseline}..${head}`, "--", path)
    .trim()
    .split("\n")
    .filter(Boolean);
  return {
    path,
    reason: entry.reason,
    disposition: "move-to-fork-side",
    introducing_fork_commit: log.at(-1),
    approved_by: "Fable-Shepherd-Rulings.json R1",
    expires_when: "the path leaves the edited set",
    evidence_command: `/usr/bin/git log --follow --format=%H ${baseline}..${head} -- ${path}`,
  };
});
manifest.tax_policy.baseline_count = 177;
manifest.tax_policy.baseline_fork = baseline;
manifest.tax_policy.approved_growth_files = growth.map(
  ({ evidence_command: _e, ...entry }) => entry,
);
writeFileSync(join(root, "throughline-seam.json"), JSON.stringify(manifest, null, 2) + "\n");

const node = "/Users/Admin/.nvm/versions/node/v24.13.1/bin/node";
const indexes: {
  name: string;
  command: string;
  exit_code: number | null;
  first_line: string;
  refusal: string;
  stdout_path: string;
  stderr_path: string;
  expected: string;
  targeted_gate_measured: boolean;
}[] = [];
const fourth = git(root, "ls-tree", "-r", "--name-only", upstream, "--", "apps/server/src")
  .trim()
  .split("\n")
  .find((p) => p.endsWith(".ts") && exists(p) && !tax.includes(p));
if (!fourth) throw Error("NO_FOURTH_STOCK_FIXTURE");
for (const name of ["good", "bad-reason", "fourth-edit"]) {
  const indexPath = join(home, `Worker-Seam-Hook-${name}-01.index`);
  const env = {
    ...process.env,
    PATH: "/Users/Admin/.nvm/versions/node/v24.13.1/bin:" + process.env.PATH,
    GIT_INDEX_FILE: indexPath,
  };
  const igit = (...args: string[]) =>
    execFileSync("/usr/bin/git", ["-C", root, ...args], {
      env,
      encoding: "utf8",
      maxBuffer: 67108864,
    });
  igit("read-tree", head);
  const candidate = structuredClone(manifest);
  if (name === "bad-reason") candidate.entries.find((x) => x.path === growthPaths[0])!.reason = "";
  if (name === "fourth-edit") {
    const value =
      source(fourth) +
      "\n// synthetic unapproved fourth-edit fixture; never written to a stock file\n";
    const oid = execFileSync("/usr/bin/git", ["-C", root, "hash-object", "-w", "--stdin"], {
      input: value,
      encoding: "utf8",
    }).trim();
    igit("update-index", "--add", "--cacheinfo", `100644,${oid},${fourth}`);
    const template = candidate.entries.find((x) => x.path === growthPaths[0])!;
    candidate.entries.push({
      ...structuredClone(template),
      path: fourth,
      reason: "Synthetic fourth stock edit for refusal testing only.",
    });
    candidate.counts.upstream_edit++;
  }
  const oid = execFileSync("/usr/bin/git", ["-C", root, "hash-object", "-w", "--stdin"], {
    input: JSON.stringify(candidate, null, 2) + "\n",
    encoding: "utf8",
  }).trim();
  igit("update-index", "--add", "--cacheinfo", `100644,${oid},throughline-seam.json`);
  const run = spawnSync("/bin/sh", [".vite-hooks/pre-commit"], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 67108864,
    timeout: 60000,
  });
  const stdoutPath = join(home, `Worker-Seam-Hook-${name}-01.stdout.txt`),
    stderrPath = join(home, `Worker-Seam-Hook-${name}-01.stderr.txt`);
  writeFileSync(stdoutPath, run.stdout ?? "");
  writeFileSync(stderrPath, run.stderr ?? "");
  const combined = (run.stdout ?? "") + (run.stderr ?? "");
  indexes.push({
    name,
    command: `GIT_INDEX_FILE=${indexPath} PATH=/Users/Admin/.nvm/versions/node/v24.13.1/bin:$PATH /bin/sh .vite-hooks/pre-commit`,
    exit_code: run.status,
    first_line: combined.split("\n").find((x) => x.trim()) ?? "",
    refusal: combined.split("\n").find((x) => x.includes("UPSTREAM_TAX_REFUSED")) ?? "",
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    expected: name === "good" ? "exit 0" : "exit 1 at targeted gate",
    targeted_gate_measured:
      name === "good"
        ? run.status === 0
        : name === "bad-reason"
          ? combined.includes("TAX_AUTHORED_REASON_REQUIRED")
          : combined.includes("TAX_UNAPPROVED_GROWTH"),
  });
}

const specPaths = [
  "README.md",
  "apps/mobile/src/",
  "apps/server/package.json",
  "apps/server/src/auth/",
  "apps/server/src/git/GitManager.test.ts",
  "apps/server/src/git/GitManager.ts",
  "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
  "apps/server/src/orchestration/runtimeLayer.ts",
  "apps/server/src/provider/Layers/CodexAdapter.ts",
  "apps/server/src/provider/Layers/PiSessionRuntime.ts",
  "apps/server/src/server.ts",
  "apps/server/src/vcs/GitVcsDriver.ts",
  "apps/server/src/vcs/GitVcsDriverCore.test.ts",
  "apps/server/src/vcs/GitVcsDriverCore.ts",
  "apps/server/src/ws.ts",
  "packages/contracts/src/model.ts",
  "pnpm-lock.yaml",
];
const changes = nameStatuses(git(root, "diff", "--name-status", "-z", "-M", upstream, head));
const reconciliation = specPaths.map((path) => ({
  path,
  directory: path.endsWith("/"),
  exists_at_head: exists(path),
  fork_edited_at_head: path.endsWith("/")
    ? tax.some((p) => p.startsWith(path))
    : tax.includes(path),
  upstream_path_at_pin: exists(path, upstream)
    ? path
    : (changes.find((x) => x.path === path)?.renamedFrom ?? null),
  renamed_successor: changes.find((x) => x.renamedFrom === path)?.path ?? null,
  successor_path: exists(path) ? path : null,
  upstream_edit_rows: path.endsWith("/") ? tax.filter((p) => p.startsWith(path)) : undefined,
  evidence_command: `/usr/bin/git cat-file -e ${head}:${path}; /usr/bin/git cat-file -e ${upstream}:${path}; /usr/bin/git diff --name-status -z -M ${upstream} ${head}; /usr/bin/git log --follow --format=%H -- ${path}`,
  log_follow: path.endsWith("/")
    ? "directory: --follow not applicable"
    : git(root, "log", "--follow", "-n", "4", "--format=%H %s", head, "--", path).trim(),
}));

const keepRows = originalKeep.map((entry) => {
  const content = source(entry.path),
    lines = content.split("\n");
  const parsed = ts.createSourceFile(
    entry.path,
    content,
    ts.ScriptTarget.Latest,
    true,
    entry.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports: {
    specifier: string;
    bindings: string[];
    namespace: boolean;
    upstream_internal: boolean;
    quote: string;
    line: number;
  }[] = [];
  const dynamic: { line: number; expression: string }[] = [],
    members: { line: number; expression: string; module: string }[] = [];
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier.text,
      normalized = specifier.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(entry.path), specifier))
        : specifier;
    const clause = statement.importClause,
      bindings: string[] = [];
    if (clause?.name) bindings.push(clause.name.text);
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) bindings.push(clause.namedBindings.name.text);
      else bindings.push(...clause.namedBindings.elements.map((e) => e.name.text));
    }
    imports.push({
      specifier,
      bindings,
      namespace: /(^|\/)throughline\/|^@ryan\/|throughline-protocol/.test(normalized),
      upstream_internal: specifier.startsWith(".") && !/(^|\/)throughline\//.test(normalized),
      quote: statement.getText(parsed),
      line: parsed.getLineAndCharacterOfPosition(statement.getStart(parsed)).line + 1,
    });
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      dynamic.push({
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        expression: node.getText(parsed),
      });
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let base: ts.Expression = node.expression;
      while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base))
        base = base.expression;
      if (ts.isIdentifier(base)) {
        const imported = imports.find((i) => i.upstream_internal && i.bindings.includes(base.text));
        if (imported)
          members.push({
            line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
            expression: node.getText(parsed),
            module: imported.specifier,
          });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  const forkBindings = new Set(imports.filter((x) => x.namespace).flatMap((x) => x.bindings));
  const candidateLines = lines
    .map((quote, i) => ({ line: i + 1, quote }))
    .filter(
      (x) =>
        [...forkBindings].some((b) => new RegExp(`\\b${b}\\b`).test(x.quote)) &&
        !/^\s*import\b/.test(x.quote),
    );
  const needed = imports
    .filter((i) => i.upstream_internal)
    .flatMap((i) => i.bindings)
    .filter((binding) =>
      candidateLines.some((line) => new RegExp(`\\b${binding}\\b`).test(line.quote)),
    );
  return {
    path: entry.path,
    diff: numstat(entry.path),
    diff_command: `/usr/bin/git diff --no-ext-diff --no-textconv --no-renames --numstat ${upstream} ${head} -- ${entry.path}`,
    fork_imports: imports.filter((x) => x.namespace),
    mount_candidates: candidateLines,
    upstream_private_bindings_lexically_referenced_by_candidates: [...new Set(needed)],
    total_ledger_private_import_entries: entry.imported_private_symbols.length,
    ledger_private_imports: entry.imported_private_symbols,
    dynamic_import_scan: dynamic,
    upstream_internal_property_access_scan: members,
    grep_command: `grep -nE 'import\\(|[A-Za-z_$][A-Za-z0-9_$]*\\.[A-Za-z_$]' ${entry.path}`,
    scan_method:
      "TypeScript AST import declarations, ImportKeyword calls and member/element access rooted at local upstream-relative import bindings; reports lexical coupling, not transitive or aliased runtime analysis.",
    conflict_rule: entry.conflict_rule,
    conflict_rule_source: entry.conflict_rule_source,
    conflict_rule_inferred: entry.conflict_rule_inferred,
    conflict_authorship:
      entry.conflict_rule_source === "authored" && !entry.conflict_rule_inferred
        ? "authored"
        : entry.conflict_rule_inferred
          ? "inferred"
          : "legacy/capability/review; authorship not independently established",
    fork_side_consumers: imports.filter((i) => i.namespace).map((i) => i.specifier),
    not_measured: [
      "Mount candidates need per-row semantic confirmation; needed import list is lexical, not minimal design proof.",
      "Transitive coupling and computed aliases are not measured. No new conflict rule authored.",
    ],
  };
});
const metadataPaths = [
  "apps/mobile/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
  "pnpm-lock.yaml",
];
const dependencyDiffs = metadataPaths.map((path) => {
  const diff = git(
    root,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--unified=3",
    upstream,
    head,
    "--",
    path,
  );
  const changed = diff.split("\n").filter((line) => /^[+-]/.test(line) && !/^[+-]{3}/.test(line));
  return {
    path,
    command: `/usr/bin/git diff --no-ext-diff --no-textconv --no-renames --unified=3 ${upstream} ${head} -- ${path}`,
    diff,
    changed_lines: changed,
    reason_basis:
      "Exact diff collected; individual dependency/version reason population follows source read.",
    not_measured: ["Build-time release identity feasibility not yet populated."],
  };
});
const result = {
  schema: "throughline.worker-seam-return.v1",
  produced_at: new Date().toISOString(),
  started_at: started,
  fork_head: head,
  upstream_pin: upstream,
  measurement_script: import.meta.filename,
  measurement_command: command,
  baseline: { fork: baseline, count: 177 },
  stop: "after W7 or 75 minutes, whichever first",
  W1: {
    status: "measured",
    command: `${command}; classifyFork(root, upstream_pin, fork_head) from scripts/throughline/seam/classify.ts`,
    name_status_command: `/usr/bin/git diff --name-status -z -M ${upstream} ${head}`,
    count: tax.length,
    paths: tax,
    prior_count: previousTax.length,
    added,
    removed,
    counts: manifest.counts,
    history_row: manifest.tax_policy.count_history.at(-1),
    original_ledger_sha256: hash(bytes),
    refreshed_ledger_sha256: hash(readFileSync(join(root, "throughline-seam.json"))),
    not_measured: ["No accepted feature reduction or rendered-view refresh."],
  },
  W2: {
    status: "measured refusal; intended good case failed",
    command,
    baseline_count: 177,
    baseline_fork: baseline,
    growth,
    hook_cases: indexes,
    fourth_stock_path: fourth,
    installed_policy: "/Users/Admin/core-root/src/tools/throughline-ship/dist/upstream-tax.js",
    findings: [
      "Installed policy expects approved_growth_files to contain approval JSON path strings; the ordered per-path objects produce TAX_APPROVAL_PATH before good/reason/fourth gates.",
      "Installed history loop also rejects changes to founding baseline_fork/baseline_count/target_count with TAX_BASELINE_POLICY_CHANGED; replacing 180/9d9b with 177/e735 is not a ledger-only compatible update.",
      "No hook or installed policy was changed, and canonical Git index was not staged by these cases.",
    ],
    not_measured: [
      "New-values known-good admission and differentiated bad-reason/fourth-growth gates: prerequisite schema refusal; further enforcement repair outside this order.",
    ],
  },
  W3: {
    status: "partial",
    command,
    entries: reconciliation,
    absurd_fork_namespace: {
      path: "apps/server/src/throughline/record/AbsurdRuntimeInProcess.ts",
      exists_at_head: exists("apps/server/src/throughline/record/AbsurdRuntimeInProcess.ts"),
      absent_at_upstream: !exists(
        "apps/server/src/throughline/record/AbsurdRuntimeInProcess.ts",
        upstream,
      ),
      class: files.get("apps/server/src/throughline/record/AbsurdRuntimeInProcess.ts")?.cls,
    },
    not_measured: ["Successor responsibility for removed entries pending targeted source read."],
  },
  W4: {
    status: "partial",
    command,
    rows: keepRows,
    not_measured: [
      "Semantic mount selection and strictly-needed imports pending per-row inspection; candidates are not accepted one-line mounts.",
    ],
  },
  W5: {
    status: "partial",
    command,
    files: dependencyDiffs,
    not_measured: [
      "Individual changed-line reasons and build-time release feasibility pending source read.",
    ],
  },
  W6: {
    status: "not measured",
    reason: "pending upstream provenance and diff inspection",
    command,
  },
  W7: {
    status: "not measured",
    reason: "pending HTTP entrypoint and admission signature inspection",
    command,
  },
  unchanged_sources:
    "No stock file written except throughline-seam.json; alternate-index blobs only for synthetic source fixture. No hook edit, move, view regeneration, install, provider turn or app control.",
};
writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      output,
      fork_head: head,
      count: tax.length,
      added,
      removed,
      hook: indexes.map((x) => ({ name: x.name, exit_code: x.exit_code, refusal: x.refusal })),
      keep_rows: keepRows.length,
    },
    null,
    2,
  ),
);

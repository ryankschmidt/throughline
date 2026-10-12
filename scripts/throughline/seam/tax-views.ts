// @effect-diagnostics nodeBuiltinImport:off - deterministic repository facts projection, not app runtime.
import { wrapTaxMap, type TaxMapContext } from "./tax-map.ts";
type Entry = {
  path: string;
  class: string;
  reason: string;
  reason_source?: string;
  reason_author?: string;
  approval_state?: string;
  feature?: string;
  seam_side?: string;
  decision?: string;
  imported_private_symbols?: string[];
  schema_assumptions?: string[];
  contract_inspection?: string;
  renamed_from?: string;
  plan?: {
    status: string;
    destination?: string;
    action?: string;
    depends_on?: string[];
    risk?: string;
    size?: {
      changed_lines: number;
      static_private_imports: number;
      blob_bytes?: number;
      binary?: boolean;
      current_added_lines?: number | null;
      current_deleted_lines?: number | null;
      basis: string;
    };
  };
};
type Facts = {
  counts: Record<string, number>;
  upstream?: { sha: string };
  fork?: { sha: string };
  entries: Entry[];
  tax_policy: {
    baseline_count: number;
    target_count: number;
    count_history: { label: string; count: number; fork?: string; upstream?: string }[];
    plan_note: string;
    approved_growth_files?: string[];
  };
};
const seamLabel = (s: string) =>
  ({
    "fork-namespace": "Fork namespace",
    "fork-outside-namespace": "Fork additions outside the namespace",
    "upstream-implementation": "Upstream implementation",
    "upstream-mount": "Proposed upstream mounts",
  })[s] ?? s;
const escape = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const list = (xs: string[] | undefined) =>
  xs?.length
    ? `<ul>${xs.map((x) => `<li>${escape(x)}</li>`).join("")}</ul>`
    : '<p class="muted">None recorded in the scoped inspection; this is not proof of no dynamic/transitive coupling.</p>';
const table = (headers: string[], rows: string[][]) =>
  `<div class="table"><table><thead><tr>${headers.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const groups = (entries: Entry[], key: (e: Entry) => string) => {
  const m = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = key(e);
    m.set(k, [...(m.get(k) ?? []), e]);
  }
  return [...m].sort(([a], [b]) => a.localeCompare(b));
};
const source = (e: Entry) =>
  `<code>${escape(e.path)}</code>${e.renamed_from ? `<p class="muted">Renamed from ${escape(e.renamed_from)}</p>` : ""}`;
const detail = (e: Entry) =>
  `<details><summary>${source(e)}</summary><dl><dt>Reason · ${escape(e.reason_source ?? "authored")}</dt><dd>${escape(e.reason)}</dd><dt>Feature and decision</dt><dd>${escape(e.feature)} · ${escape(e.decision)}</dd><dt>Private upstream imports</dt><dd>${list(e.imported_private_symbols)}</dd><dt>Schema assumptions</dt><dd>${list(e.schema_assumptions)}</dd><dt>Inspection limit</dt><dd>${escape(e.contract_inspection)}</dd><dt>Author / authorization state</dt><dd>${escape(e.reason_author ?? "author not supplied")} · ${escape(e.approval_state ?? "no authorization claim")}</dd></dl><button class="copybtn" data-copy-entry="${escape(e.path)}">Copy exact ledger row</button></details>`;

/** Views and the move plan are different projections of the same manifest, never separate writable inventories. */
export function renderTaxViews(
  m: Facts,
  digest: string,
  planOnly = false,
  context?: TaxMapContext,
): string {
  if (!m.tax_policy || !Array.isArray(m.entries)) throw Error("TAX_VIEW_POLICY_REQUIRED");
  const seen = new Set<string>();
  for (const e of m.entries) {
    if (!e.path || seen.has(e.path) || !e.reason) throw Error("TAX_VIEW_INVALID_ENTRY " + e.path);
    seen.add(e.path);
  }
  const tax = m.entries.filter((e) => ["upstream-edit", "upstream-removed"].includes(e.class));
  const original = tax.filter((e) => e.plan?.status === "open-original-160"),
    extra = tax.filter((e) => e.plan?.status === "open-post-merge-3");
  const moves = tax.filter((e) => e.decision !== "keep");
  const count = tax.length,
    ceiling = m.tax_policy.baseline_count,
    target = m.tax_policy.target_count;
  const files = table(
    ["Every file · expand for the decision", "Feature", "Seam side", "Disposition"],
    m.entries.map((e) => [
      detail(e),
      escape(e.feature ?? "Unclassified"),
      escape(seamLabel(e.seam_side ?? e.class)),
      escape(e.decision),
    ]),
  );
  const features = groups(m.entries, (e) => e.feature ?? "Unclassified")
    .map(
      ([name, es]) =>
        `<details class="card"><summary><b>${escape(name)}</b> · ${es.filter((e) => e.class.startsWith("upstream")).length} tax / ${es.length} custom paths</summary>${es.map((e) => detail(e)).join("")}</details>`,
    )
    .join("");
  const seams = groups(m.entries, (e) => e.seam_side ?? e.class)
    .map(
      ([name, es]) =>
        `<details class="card"><summary><b>${escape(seamLabel(name))}</b> · ${es.length} paths</summary>${es.map((e) => detail(e)).join("")}</details>`,
    )
    .join("");
  const custom = table(
    ["Customization", "Current source location", "Planned home · not performed"],
    m.entries.map((e) => [
      escape(e.feature),
      source(e),
      `<code>${escape(e.plan?.destination ?? (e.class === "fork-namespace" ? e.path : "Relocation destination not assigned"))}</code><p>${escape(e.reason)}</p>`,
    ]),
  );
  const max = Math.max(...m.tax_policy.count_history.map((x) => x.count), count, 1);
  const history = m.tax_policy.count_history
    .map(
      (x) =>
        `<article class="history"><div><strong>${x.count}</strong><span>${escape(x.label)}</span></div><div class="track"><span style="width:${(x.count / max) * 100}%"></span><i style="left:${(target / max) * 100}%" title="Target ${target}"></i></div><p class="muted">Source ${escape(x.fork)} · upstream ${escape(x.upstream)}</p></article>`,
    )
    .join("");
  const moveRows = (rows: Entry[]) =>
    table(
      [
        "Upstream file",
        "Move and dependency",
        "Size proxy · not duration or feasibility",
        "Proposed fork-side destination",
      ],
      rows.map((e) => {
        const size = e.plan?.size,
          n = size?.changed_lines ?? 0;
        const current = size?.binary
          ? "N/A · binary"
          : size?.current_added_lines == null || size?.current_deleted_lines == null
            ? "Current text size unmeasured"
            : `${size.current_added_lines + size.current_deleted_lines} current changed lines (+${size.current_added_lines}/−${size.current_deleted_lines})`;
        return [
          source(e),
          `<b>${escape(e.decision)}</b><p>${escape(e.plan?.action)}</p>${list(e.plan?.depends_on)}<p class="muted">Risk: ${escape(e.plan?.risk ?? "not assessed")} · ${escape(e.plan?.status)}</p>`,
          `${escape(current)}<p>${size?.binary ? "N/A text baseline" : `${n} baseline changed lines`} · ${size?.static_private_imports ?? 0} static private imports · ${size?.blob_bytes ?? "unmeasured"} current source bytes</p><p class="muted">Proxy only. ${escape(size?.basis)}</p>`,
          `<code>${escape(e.plan?.destination)}</code>`,
        ];
      }),
    );
  const plan = `<section id="moves"><h2>Open moves · ${moves.length} files</h2><p class="notice">${escape(m.tax_policy.plan_note)}</p><h3>Execution order · no moves authorized in this slice</h3><ol><li>Prove representative restore/drop slices and keep their regression tests in the namespace.</li><li>Extract branding, packaging and build policy through retained configuration mounts; verify every platform.</li><li>Extract phone/web composer, identity, themes and context presentation through public client extension points. Missing extension points are named dependencies, not permission for hidden replacement patches.</li><li>Extract server policy, messaging, leases and persistence through public service decorators. Keep backwards-readable schemas and cold import/rewind tests.</li><li>After each slice, restore the old upstream file exactly, remeasure the real diff, regenerate these views and run the no-growth gate. Stop at 17 only when 17 physical paths remain and each pinned feature slice passes.</li></ol><p>Estimates below are measured change size and static import coupling, not invented hours. Time estimates stay unknown until a representative slice has recorded duration. Destination paths are proposed and cannot be used until their consumer seam is proven.</p><h3>Original ${original.length} extra edits at the Oct 11 merge</h3>${moveRows(original)}<h3>Post-merge additions · ${extra.length} additional edits</h3>${moveRows(extra)}<h3>Proposed retained mounts · ${tax.filter((e) => e.decision === "keep").length}</h3>${moveRows(tax.filter((e) => e.decision === "keep"))}</section>`;
  const titles = planOnly
    ? [["moves", "Move plan"]]
    : [
        ["files", "Every file"],
        ["features", "By feature"],
        ["seams", "By seam"],
        ["customizations", "Customizations"],
        ["history", "Count over time"],
        ["moves", "Open moves / plan"],
      ];
  const legacyHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ThroughLine upstream tax${planOnly ? " — move plan" : ""}</title><style>
 :root{color-scheme:light dark;--bg:#eef2f6;--panel:#fff;--ink:#172838;--muted:#536778;--line:#c9d6df;--blue:#0875a7;--warn:#913d0c;--soft:#fff0d9}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui}header,main{max-width:1480px;margin:auto;padding:32px}header{padding-bottom:8px}h1{font-size:38px;line-height:1.15}h2{font-size:29px}h3{margin-top:8px}p{max-width:100ch}nav{position:sticky;top:0;z-index:2;background:var(--panel);border-block:1px solid var(--line);padding:12px;display:flex;gap:8px;flex-wrap:wrap}nav a{color:var(--ink);text-decoration:none;padding:8px 14px;border:1px solid var(--line);border-radius:8px}nav a:hover,nav a:focus{background:var(--blue);color:white}section{scroll-margin-top:100px;padding-block:22px;border-bottom:1px solid var(--line)}.stats,.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}.stat,.card{background:var(--panel);border:1px solid var(--line);padding:20px;border-radius:12px}.stat b{display:block;font-size:36px}.muted{font-size:13px;color:var(--muted)}.notice{padding:18px;border-left:5px solid var(--warn);background:var(--soft);max-width:none}.table{overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:14px;border-bottom:1px solid var(--line);vertical-align:top}th{background:var(--bg)}td:first-child{min-width:270px}code{overflow-wrap:anywhere;white-space:normal;font-size:12px}details{padding:7px 0;border-bottom:1px solid var(--line)}summary{cursor:pointer}dl{padding:12px;background:var(--bg)}dt{font-weight:700}dd{margin:0 0 14px}.history{padding:15px;background:var(--panel);margin:14px 0;border-radius:8px}.history strong{font-size:26px;margin-right:15px}.track{height:24px;background:var(--bg);position:relative;margin:10px 0}.track span{display:block;height:100%;background:var(--blue)}.track i{position:absolute;top:-4px;bottom:-4px;width:3px;background:var(--warn)}input{padding:12px;margin:10px 0;width:min(650px,100%);background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px}.seam-graph{display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin:18px 0}.seam-graph article{flex:1;min-width:220px;background:var(--panel);padding:22px;border:2px solid var(--line);border-radius:10px}@media(prefers-color-scheme:dark){:root{--bg:#101923;--panel:#192734;--ink:#e0edf5;--muted:#a7bfce;--line:#355163;--blue:#399dca;--warn:#efb760;--soft:#31291a}}@media(max-width:640px){header,main{padding:18px}h1{font-size:28px}nav{position:static}.stats{grid-template-columns:1fr 1fr}.stat{padding:12px}.stat b{font-size:28px}}
 .seam-groups{grid-template-columns:repeat(auto-fit,minmax(420px,1fr))}@media(max-width:640px){.seam-groups{grid-template-columns:1fr}}
 section{display:none}#files{display:block}section:target{display:block}body:has(section:target) #files:not(:target){display:none}body.plan #moves{display:block}
 </style></head><body class="${planOnly ? "plan" : "views"}"><header><p class="muted">ThroughLine · upstream maintenance decisions · projected from one ledger</p><h1>${planOnly ? "The path to seventeen edits" : "See every upstream customization"}</h1><p>Candidate bookkeeping for source ${escape(m.fork?.sha)} against pinned upstream ${escape(m.upstream?.sha)}. This view is not an installation or behavioral acceptance witness.</p><div class="stats"><div class="stat"><b>${count}</b>actual upstream edits</div><div class="stat"><b>${ceiling}</b>no-growth baseline</div><div class="stat"><b>${target}</b>target physical paths</div><div class="stat"><b>${count - target}</b>extra paths to remove</div></div><p class="notice">${count > ceiling ? `${count - ceiling} inherited post-merge edits exceed the recorded baseline. No advance approval exists for them; enforcement must refuse until they are resolved, not retroactively authorized.` : "This refresh tightens the previous 202-file admission to the actual starting set. The historical 177-to-180 increase remains visible; it is not a future-growth approval. Coverage and authored reasons remain separate checks."} <b>No feature moves were performed.</b></p></header><nav>${titles.map(([id, title]) => `<a href="#${id}">${title}</a>`).join("")}</nav><main>
 ${planOnly ? "" : `<section id="files"><h2>Every file · ${m.entries.length} custom paths</h2><p>Expand a path to inspect its authored reason, feature, disposition, recorded private imports and schema assumptions. The list distinguishes historical source from proposed placement.</p><input id="search" aria-label="Filter every file" placeholder="Filter paths, features, reasons or seam sides"><p id="matches">${m.entries.length} files</p>${files}</section><section id="features"><h2>By feature</h2><div class="grid">${features}</div></section><section id="seams"><h2>By seam</h2><div class="seam-graph"><article><b>Upstream implementation</b><p>Historical custom logic still carries merge tax.</p></article><span>→</span><article><b>Retained mounts</b><p>Configuration and public composition only; proposed 17-path budget.</p></article><span>→</span><article><b>Fork namespace</b><p>Feature implementations, policy and regression tests should live here.</p></article></div><div class="grid seam-groups">${seams}</div></section><section id="customizations"><h2>Customizations and where each lives</h2><p>Current location is source, not a claim that an installed runtime consumed it. Proposed locations are not yet moved.</p>${custom}</section><section id="history"><h2>Count over time · toward ${target}</h2><p>The vertical amber marker is the target, not a measured historical count. No intervening points are invented.</p>${history}</section>`}
 ${plan}<footer><p>Manifest SHA-256: <code>${escape(digest)}</code></p><p>Regenerate both views through the existing seam-view projector. Do not hand-edit the HTML. Feature acceptance, approval identity authentication and installed behavior are separate proofs.</p></footer></main><script>const search=document.getElementById('search');if(search)search.addEventListener('input',()=>{let n=0;for(const row of document.querySelectorAll('#files tbody tr')){row.hidden=!row.textContent.toLowerCase().includes(search.value.toLowerCase());if(!row.hidden)n++;}document.getElementById('matches').textContent=n+' matching files';});</script></body></html>\n`;
  return wrapTaxMap(legacyHtml, m, digest, planOnly, context);
}

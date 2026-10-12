// @effect-diagnostics nodeBuiltinImport:off - pure deterministic repository projection.
type Anchor = { path: string; role?: string };
type Node = {
  id: string;
  label: string;
  kind: string;
  owner: string;
  lifecycle: string;
  proofStatus: string;
  summary: string;
  secret: string;
  publicContract: string;
  mustNotOwn: string[];
  editHere: string[];
  sourceAnchors: Anchor[];
  proofAnchors: Anchor[];
  x: number;
  y: number;
};
type Edge = { id: string; from: string; to: string; contract: string };
export type TaxMapFacts = {
  variant: string;
  nodes: Node[];
  edges: Edge[];
  primary_data: { path: string; sha256: string };
  deferrals?: { subject: string; detail: string }[];
  configuration?: Record<string, unknown>[];
  proof_limits?: string[];
  diagram?: string;
  impact?: Record<string, unknown>;
};
export type TaxMapContext = { facts: TaxMapFacts; factsPath: string; css?: string };
type Ledger = {
  entries: {
    path: string;
    class: string;
    reason: string;
    feature?: string;
    decision?: string;
    seam_side?: string;
    approval_state?: string;
  }[];
  tax_policy: { baseline_count: number; target_count: number };
  upstream?: { sha: string };
  fork?: { sha: string };
  upstream_changes?: { path: string; decision: string; reason: string; decision_basis?: string }[];
};
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const json = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
const link = (p: string) =>
  p.startsWith("/Users/Admin/core-root/vault/")
    ? `<a href="http://mbp21.tailec334b.ts.net:8129/v/vault/r/${p.slice(29).split("/").map(encodeURIComponent).join("/")}">${esc(p)}</a>`
    : `<code>${esc(p)}</code>`;
const anchors = (a: Anchor[]) =>
  a.map((x) => link(x.path)).join("<br>") ||
  '<span class="muted">No independent proof recorded</span>';
const list = (xs: string[]) => `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
const table = (h: string[], r: string[][]) =>
  `<div class="table-scroll"><table><thead><tr>${h.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${r.map((row) => `<tr>${row.map((x) => `<td>${x}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const css = `:root{--bg:#0a0d12;--card:#141b25;--line:#232d3c;--text:#e8eef7;--muted:#93a0b2;--upstream:#5b8def;--ours:#3fd28b;--boundary:#f2b34a;--patch:#c08bff;--danger:#ff5f6e;--unknown:#9aa5b1;--radius:14px;--shadow:0 10px 40px rgba(0,0,0,.45);--mono:ui-monospace,monospace;--font:system-ui}*{box-sizing:border-box}body{background:var(--bg);color:var(--text);font:15px/1.5 var(--font);margin:0}.wrap{max-width:1180px;margin:auto;padding:0 24px}.hero{padding:36px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}.state{border:1px solid;padding:3px 8px;border-radius:20px;font:11px var(--mono)}.tabs{position:sticky;top:0;background:var(--bg);z-index:20}.tabs .wrap{display:flex;gap:8px}.tabs a{padding:10px;color:var(--muted);text-decoration:none;white-space:nowrap}.deck{padding:30px 0;border-bottom:1px solid var(--line)}.heroGrid{display:grid;gap:12px;grid-template-columns:repeat(4,1fr)}.svgwrap{position:relative;background:#10151d;border:1px solid var(--line);border-radius:14px}.node{cursor:pointer}.node.dim,.edge.dim{opacity:.12}#inspector{position:absolute;right:14px;top:14px;width:312px;background:var(--card);padding:14px;display:none;box-shadow:var(--shadow)}.showInspector #inspector{display:block}a{color:var(--upstream)}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.copybtn,.fbtn{background:var(--card);color:var(--text);border:1px solid var(--line);padding:6px 10px;border-radius:12px;cursor:pointer}.filters{display:flex;gap:6px}.readout{border:1px dashed var(--line);padding:14px;margin-top:16px}pre{white-space:pre-wrap}.eyebrow{color:var(--boundary);font:11px var(--mono)}`;
/** Unbound views describe source contracts only. They never infer installation from file presence. */
export function defaultTaxMap(m: Ledger, digest: string): TaxMapFacts {
  const layout = [
    ["upstream", "Pinned Git comparison", "artifact", "upstream", 140, 325],
    ["approval", "Written approval", "artifact", "seam", 410, 125],
    ["ledger", "Authored decision registry", "module", "seam", 410, 325],
    ["policy", "Shared tax admission", "module", "ours", 700, 325],
    ["release", "Release boundary", "adapter", "ours", 1010, 130],
    ["commit", "Commit boundary", "adapter", "ours", 1010, 275],
    ["views", "Facts-to-HTML projector", "module", "ours", 1010, 420],
    ["plan", "Proposed open moves", "artifact", "ours", 1010, 565],
  ] as const;
  return {
    variant: "current-state-operating-map",
    primary_data: { path: "/Users/Admin/throughline/throughline-seam.json", sha256: digest },
    nodes: layout.map(([id, label, kind, owner, x, y]) => ({
      id,
      label,
      kind,
      owner,
      x,
      y,
      lifecycle: id === "plan" ? "planned" : "candidate",
      proofStatus: "proof-pending",
      summary:
        id === "ledger"
          ? `${m.entries.length} source choices; proposed decisions are not approvals.`
          : "Source contract only; installed consumption is unknown without named proof bindings.",
      secret:
        id === "ledger"
          ? "Which recorded file choices serve the fork"
          : id === "policy"
            ? "How physical upstream tax is admitted"
            : id === "views"
              ? "How recorded choices become queryable"
              : "This artifact/adapter owns no independent feature policy.",
      publicContract:
        id === "ledger"
          ? "One versioned file with authored reasons and scope"
          : id === "policy"
            ? "Actual path coverage, reasons and advance-approved growth"
            : "Consume the recorded contract; never grant authority.",
      mustNotOwn: ["No hidden inventory, feature moves or inferred approvals."],
      editHere: [],
      sourceAnchors: [],
      proofAnchors: [],
    })),
    edges: [
      ["upstream", "ledger", "real diff"],
      ["approval", "ledger", "written scope"],
      ["ledger", "policy", "admission input"],
      ["policy", "release", "release policy"],
      ["policy", "commit", "staged policy"],
      ["ledger", "views", "one source"],
      ["ledger", "plan", "proposed moves"],
    ].map(([from, to, contract]) => ({ id: from + "-" + to, from, to, contract })),
    proof_limits: ["Installed state is unknown without separate witnesses."],
  };
}
export function wrapTaxMap(
  old: string,
  m: Ledger,
  digest: string,
  planOnly = false,
  context?: TaxMapContext,
): string {
  const f = context?.facts ?? defaultTaxMap(m, digest);
  if (f.primary_data.sha256 !== digest) throw Error("TAX_MAP_STALE_FACTS");
  const index = new Map(f.nodes.map((n) => [n.id, n]));
  if (index.size !== f.nodes.length) throw Error("TAX_MAP_DUPLICATE_NODE");
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw Error("TAX_MAP_CYCLE");
    if (done.has(id)) return;
    visiting.add(id);
    for (const e of f.edges.filter((e) => e.from === id)) {
      if (!index.has(e.to)) throw Error("TAX_MAP_EDGE_TARGET");
      visit(e.to);
    }
    visiting.delete(id);
    done.add(id);
  }
  for (const e of f.edges) if (!index.has(e.from)) throw Error("TAX_MAP_EDGE_SOURCE");
  for (const id of index.keys()) visit(id);
  const color = (n: Node) =>
    n.owner === "upstream"
      ? "var(--upstream)"
      : n.owner === "seam"
        ? "var(--boundary)"
        : "var(--ours)";
  const graph =
    f.edges
      .map((e) => {
        const a = index.get(e.from)!,
          b = index.get(e.to)!,
          ax = a.x + 105,
          bx = b.x - 105,
          mx = (ax + bx) / 2;
        return `<path class="edge" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="M${ax} ${a.y} C${mx} ${a.y} ${mx} ${b.y} ${bx} ${b.y}" stroke="var(--boundary)" marker-end="url(#arrow)"/><text x="${mx}" y="${(a.y + b.y) / 2 - 9}" class="edgeLabel">${esc(e.contract)}</text>`;
      })
      .join("") +
    f.nodes
      .map(
        (n) =>
          `<g class="node" data-id="${esc(n.id)}" data-owner="${esc(n.owner)}" data-life="${esc(n.lifecycle)}" data-proof="${esc(n.proofStatus)}" tabindex="0" role="button" aria-label="Inspect ${esc(n.label)}"><rect x="${n.x - 105}" y="${n.y - 33}" width="210" height="66" rx="12" fill="var(--card)" stroke="${color(n)}" stroke-width="1.6" ${["planned", "candidate", "unknown"].includes(n.lifecycle) ? 'stroke-dasharray="6 4"' : ""}/><text x="${n.x - 91}" y="${n.y - 10}" style="fill:${color(n)}" class="nodeState">${esc(n.kind)} · ${esc(n.lifecycle)}</text><text x="${n.x - 91}" y="${n.y + 12}" class="nodeLabel">${esc(n.label)}</text></g>`,
      )
      .join("");
  const modules = table(
    ["Module / state", "Secret", "Contract", "Must-not-own", "Slice-proof"],
    f.nodes
      .filter((n) => n.kind === "module")
      .map((n) => [
        `${esc(n.label)}<small class="state ${esc(n.lifecycle)}">${esc(n.lifecycle)}</small>`,
        esc(n.secret),
        esc(n.publicContract),
        list(n.mustNotOwn),
        anchors(n.proofAnchors),
      ]),
  );
  const receipts = table(
    ["Control / scope", "Source anchors", "Independent proof"],
    f.nodes.map((n) => [
      `${esc(n.label)}<small>${esc(n.summary)}</small>`,
      anchors(n.sourceAnchors),
      anchors(n.proofAnchors),
    ]),
  );
  const configs = table(
    ["Module / setting names", "Status / health", "Last validation"],
    (f.configuration ?? []).map((c) => [
      `${esc(c.module)}<small>binary_path: ${esc(c.binary_path)}<br>config_path: ${esc(c.config_path)}<br>environment_names: ${esc(c.environment_names)}<br>sensitive: ${esc(c.sensitive)}<br>base_url: ${esc(c.base_url)}<br>first_class_commands: ${esc(c.first_class_commands)}</small>`,
      `${esc(c.status)}<small>${esc(c.health)}</small>`,
      typeof c.last_validation_receipt === "string" ? link(c.last_validation_receipt) : "Unknown",
    ]),
  );
  const body = old
    .slice(old.indexOf("<main>") + 6, old.indexOf("<footer>"))
    .replace(/<section /g, '<section class="deck" ')
    .replace(/<div class="grid">/g, '<div class="groups">');
  const factsPath = context?.factsPath ?? "docs/throughline/seam-facts.json";
  const count = m.entries.filter((e) => e.class.startsWith("upstream-")).length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="seam-manifest-sha256" content="${esc(digest)}"><meta name="format-choice" content="html — shows seam flow, file choices, tax history and proposed moves"><title>ThroughLine upstream tax${planOnly ? " — move plan" : ""}</title><style>${context?.css ?? css}
 .stat .v strong{font:30px var(--mono)}.muted,small{color:var(--muted)}small{display:block;font-size:11px;margin-top:6px;overflow-wrap:anywhere}code{font:12px var(--mono);overflow-wrap:anywhere}.gaps{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.table,.table-scroll{overflow:auto;max-height:540px}table{font-size:12px}th{position:sticky;top:0;background:var(--card);z-index:1}td{min-width:120px}td:first-child{max-width:360px}details dl{font-size:12px;max-width:600px}dt{color:var(--boundary);margin-top:12px}dd{margin:3px 0}summary{cursor:pointer}.groups{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.groups>.card{max-height:400px;overflow:auto}.seam-graph{display:none}.notice,.readout{color:var(--boundary)}input,select{font:inherit;background:var(--card);color:var(--text);border:1px solid var(--line);padding:9px 12px;border-radius:9px}input{width:100%;margin-bottom:12px}.edgeLabel{text-anchor:middle;fill:var(--muted);font:9px var(--mono)}.edge{fill:none;stroke-width:1.6;opacity:.65}.nodeState{font:9px var(--mono);text-transform:uppercase}.nodeLabel{font:12px var(--font);font-weight:650;fill:var(--text)}.graphZones text{font:11px var(--mono);letter-spacing:1px}.history{margin:12px 0}.history strong{font:28px var(--mono);margin-right:12px}.track{position:relative;height:12px;background:var(--line);border-radius:9px;margin:14px 0}.track span{display:block;height:100%;background:var(--upstream);border-radius:9px}.track i{position:absolute;top:-5px;height:22px;border-left:3px solid var(--boundary)}#inspector{max-height:570px;overflow:auto}.filters{flex-wrap:nowrap;overflow:auto}.tabs .wrap{flex-wrap:nowrap;overflow:auto}.state.decided{color:var(--upstream)}.state{display:inline-block}.svgwrap svg{width:100%;height:auto}#copyStatus{color:var(--boundary);font:11px var(--mono)}[hidden]{display:none!important}@media(max-width:820px){.gaps,.groups{grid-template-columns:1fr}.heroGrid{grid-template-columns:repeat(2,1fr)}#inspector{width:min(312px,85%)}.wrap{padding:0 16px}}
 </style></head><body data-source-facts="${esc(factsPath)}"><header class="hero"><div class="wrap"><div class="eyebrow">ThroughLine · upstream-tax operating map · ${esc(f.variant)}</div><h1><span class="grad">Keep the fork. Shrink the merge tax.</span></h1><p class="lede">One ledger connects every custom file to its feature, seam, written reason and proposed decision. One admission policy protects release and commit. The migration target remains a proposal, not a completed move.</p><div class="heroGrid"><div class="stat"><div class="k">Upstream files edited</div><div class="v"><strong>${count}</strong> measured paths</div></div><div class="stat"><div class="k">Effective starting ceiling</div><div class="v"><strong>${m.tax_policy.baseline_count}</strong> · approval before growth</div></div><div class="stat"><div class="k">Proposed physical target</div><div class="v"><strong>${m.tax_policy.target_count}</strong> · feasibility unproved</div></div><div class="stat"><div class="k">Custom catalogue</div><div class="v"><strong>${m.entries.length}</strong> paths</div></div></div></div></header>
 <nav class="tabs"><div class="wrap">${[
   ["graph", "Flow"],
   ["files", "Every file"],
   ["features", "Features"],
   ["seams", "Seams"],
   ["customizations", "Customizations"],
   ["history", "Count"],
   ["moves", "Open moves"],
   ["proof", "Proof / gaps"],
 ]
   .filter(([id]) => !planOnly || ["graph", "moves", "proof"].includes(id))
   .map(([id, label]) => `<a href="#${id}">${label}</a>`)
   .join(
     "",
   )}</div></nav><main class="wrap"><section class="deck" id="graph"><h2>Measure → record → admit → consume</h2><p class="sub">Bookkeeping altitude, not an application-wide architecture map. Hover to inspect; click to pin. States distinguish witnessed controls from candidate outputs and proposed work.</p><div class="filters">${[
   ["all", "All"],
   ["upstream", "Upstream"],
   ["seam", "Seam"],
   ["ours", "Ours"],
   ["current", "Current"],
   ["candidate", "Candidate"],
   ["planned", "Planned"],
   ["proved", "Proved"],
 ]
   .map(
     ([id, label]) =>
       `<button class="fbtn ${id === "all" ? "on" : ""}" data-filter="${id}">${label}</button>`,
   )
   .join(
     "",
   )}</div><div class="svgwrap" id="graphBox"><svg id="goalSvg" viewBox="0 0 1200 650" aria-label="Upstream-tax ownership flow"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6" fill="var(--boundary)"/></marker></defs><g class="graphZones"><rect x="18" y="48" width="235" height="565" rx="18" fill="none" stroke="var(--upstream)" stroke-opacity=".22"/><text x="140" y="30" text-anchor="middle" fill="var(--upstream)">UPSTREAM · PINNED SOURCE</text><rect x="288" y="48" width="245" height="565" rx="18" fill="none" stroke="var(--boundary)" stroke-opacity=".22"/><text x="410" y="30" text-anchor="middle" fill="var(--boundary)">SEAM · WRITTEN CHOICES</text><rect x="558" y="48" width="623" height="565" rx="18" fill="none" stroke="var(--ours)" stroke-opacity=".22"/><text x="870" y="30" text-anchor="middle" fill="var(--ours)">OURS · POLICY AND ADAPTERS</text></g>${graph}</svg><aside id="inspector" aria-label="Node inspector"></aside></div><div class="readout"><div class="k">One authority</div><div class="v">${link(f.primary_data.path)}<small>SHA-256 ${esc(digest)} · pinned upstream ${esc(m.upstream?.sha)} · source ${esc(m.fork?.sha)}</small>Generated facts: ${link(factsPath)}. Derived files never approve a decision.</div></div></section><section class="deck" id="modules"><h2>Three modules, separate responsibilities</h2><p class="sub">The registry owns recorded choices; admission owns refusal; projection owns human and agent comprehension. Adapters add no second policy.</p>${modules}</section>${body}<section class="deck" id="authorization"><h2>Frozen debt · not approved by a policy PASS</h2>${list(m.entries.filter((e) => e.approval_state === "unapproved-debt-frozen").map((e) => e.path))}<p>No further source edit or move is authorized for these paths. This count/metadata policy does not itself authenticate frozen-file edit permission.</p><h3>Two disposition axes</h3><p>Observed upstream retain/adopt/replace/defer describes today’s source; proposed keep/move/drop describes future tax. Neither implies approval.</p>${table(
   ["Path", "Observed upstream disposition", "Proposed tax disposition"],
   (m.upstream_changes ?? []).map((e) => [
     esc(e.path),
     esc(e.decision),
     esc(m.entries.find((x) => x.path === e.path)?.decision ?? "not catalogued"),
   ]),
 )}</section>
 <section class="deck" id="proof"><h2>Evidence, configuration and remaining gaps</h2><h3>On-disk receipt table</h3>${receipts}<h3>Configuration slice · names and status only</h3>${configs}<h3>Open / deferred · not erased by a policy PASS</h3><div class="gaps">${(f.deferrals ?? []).map((g) => `<article class="card"><h3>${esc(g.subject)}</h3><p>${esc(g.detail)}</p></article>`).join("")}</div><h3>Impact / staleness</h3><pre>${esc(JSON.stringify(f.impact ?? { stale_parent_maps: "not inspected", required_proof_gates: ["independent visual and canonical consumption"] }, null, 2))}</pre>${list(f.proof_limits ?? [])}<h3>Copyable Mermaid diagram</h3><pre id="diagram">${esc(f.diagram ?? "flowchart LR\n upstream --> ledger --> policy\n approval --> ledger\n policy --> release\n policy --> commit\n ledger --> views\n ledger --> plan")}</pre><button class="copybtn" id="copyDiagram">Copy diagram</button><p id="diagramStatus" role="status"></p></section><footer class="footer-note">Generated from one ledger; not hand-edited. No moves, debt clearance, full inspection or device acceptance claimed.</footer></main><script type="application/json" id="map-facts">${json({ ...f, ledger: m })}</script><script>
 const facts=JSON.parse(document.getElementById('map-facts').textContent),nodes=facts.nodes,edges=facts.edges,idx=Object.fromEntries(nodes.map(n=>[n.id,n]));const box=document.getElementById('graphBox'),inspector=document.getElementById('inspector'),nodeEls=[...document.querySelectorAll('.node[data-id]')],edgeEls=[...document.querySelectorAll('.edge[data-from]')];let pinned=null,filter='all';const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function hide(){box.classList.remove('showInspector');}function applyFilter(){nodeEls.forEach(g=>{const n=idx[g.dataset.id];g.classList.toggle('dim',filter!=='all'&&![n.owner,n.lifecycle,n.proofStatus].includes(filter));});edgeEls.forEach(g=>{const a=idx[g.dataset.from],b=idx[g.dataset.to];g.classList.toggle('dim',filter!=='all'&&![a.owner,b.owner,a.lifecycle,b.lifecycle,a.proofStatus,b.proofStatus].includes(filter));});}
 function highlight(id){const keep=new Set([id]);edges.forEach(e=>{if(e.from===id)keep.add(e.to);if(e.to===id)keep.add(e.from);});nodeEls.forEach(g=>g.classList.toggle('dim',!keep.has(g.dataset.id)));edgeEls.forEach(g=>g.classList.toggle('dim',g.dataset.from!==id&&g.dataset.to!==id));}
 async function copy(value,button,status){try{await navigator.clipboard.writeText(typeof value==='string'?value:JSON.stringify(value,null,2));button.textContent='Copied ✓';if(status)status.textContent='Copied';}catch{button.textContent='Copy failed';if(status)status.textContent='Clipboard unavailable; source packet remains in page facts.';}}
 function show(n){box.classList.add('showInspector');inspector.innerHTML='<div class="kind">'+escape(n.owner)+' · '+escape(n.kind)+'</div><div class="ititle">'+escape(n.label)+'</div><span class="state '+escape(n.lifecycle)+'">'+escape(n.lifecycle)+'</span><div class="why">'+escape(n.summary)+'</div><p><b>Contract</b> '+escape(n.publicContract)+'</p><p class="isrc">'+n.sourceAnchors.concat(n.proofAnchors).map(a=>escape(a.path)).join('<br>')+'</p><button class="copybtn" id="copyNode">Copy agent context packet</button> <button class="copybtn" id="unpinNode">Unpin</button><p id="copyStatus" role="status"></p>';document.getElementById('copyNode').onclick=()=>copy({source:facts.primary_data,node:n,neighbors:edges.filter(e=>e.from===n.id||e.to===n.id),limits:facts.proof_limits},document.getElementById('copyNode'),document.getElementById('copyStatus'));document.getElementById('unpinNode').onclick=()=>{pinned=null;hide();applyFilter();};}
 nodeEls.forEach(g=>{const n=idx[g.dataset.id];g.addEventListener('mouseenter',()=>{if(!pinned){highlight(n.id);show(n);}});g.addEventListener('mouseleave',()=>{if(!pinned){hide();applyFilter();}});g.addEventListener('click',()=>{pinned=n.id;highlight(n.id);show(n);});g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();g.dispatchEvent(new MouseEvent('click'));}});});document.querySelectorAll('[data-filter]').forEach(btn=>btn.addEventListener('click',()=>{filter=btn.dataset.filter;pinned=null;hide();document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('on',b===btn));applyFilter();}));document.getElementById('goalSvg').addEventListener('click',e=>{if(e.target.id==='goalSvg'){pinned=null;hide();applyFilter();}});
 document.querySelectorAll('[data-copy-entry]').forEach(btn=>btn.addEventListener('click',()=>copy({source:facts.primary_data,entry:facts.ledger.entries.find(e=>e.path===btn.dataset.copyEntry)},btn,null)));const search=document.getElementById('search');if(search)search.addEventListener('input',()=>{let n=0;for(const row of document.querySelectorAll('#files tbody tr')){row.hidden=!row.textContent.toLowerCase().includes(search.value.toLowerCase());if(!row.hidden)n++;}document.getElementById('matches').textContent=n+' matching files';});document.getElementById('copyDiagram').onclick=()=>copy(document.getElementById('diagram').textContent,document.getElementById('copyDiagram'),document.getElementById('diagramStatus'));
 </script></body></html>\n`;
}

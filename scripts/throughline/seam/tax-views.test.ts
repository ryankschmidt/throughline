import { test } from "node:test";
import assert from "node:assert/strict";
const api = await import("./tax-views.ts").catch(() => null);
function debtFacts() {
  return {
    counts: { upstream_edit: 180 },
    fork: { sha: "landed-source" },
    tax_policy: {
      baseline_count: 177,
      target_count: 17,
      approved_growth_files: [],
      acknowledged_debt: ["production.ts", "guard.test.ts", "fixture.test.ts"].map((path, i) => ({
        path,
        disposition: i ? "retain-minimized" : "move-to-fork-side",
        expires_when: i ? "upstream adopts the test" : "path leaves the edited set",
      })),
      count_history: [
        { label: "before", count: 180 },
        { label: "after", count: 180 },
      ],
      plan_note: "Stored proposal; physical target not admitted.",
    },
    approved_changes: [
      {
        id: "native-review-tokenization-move-2026-10-12",
        state: "approved-before-implementation",
        scope_paths: ["production.ts", "guard.test.ts"],
      },
    ],
    entries: Array.from({ length: 180 }, (_, i) => ({
      path: i < 3 ? ["production.ts", "guard.test.ts", "fixture.test.ts"][i]! : `stock-${i}.ts`,
      class: "upstream-edit",
      reason: "Measured source choice",
      decision: "keep",
      plan: { status: i === 0 ? "first-move-landed-minimal-mount-retained" : "retained" },
    })),
  };
}
test("R12 ceiling shows ledger baseline plus acknowledged debt, not a false refusal", () => {
  assert.ok(api);
  const html = api.renderTaxViews(debtFacts(), "bound");
  assert.match(
    html,
    /Policy baseline 177 \+ 3 acknowledged debts \+ 0 validated growth credit = effective ceiling 180/,
  );
  const hero = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.match(hero, /Effective ceiling[\s\S]*?<strong>180<\/strong>/);
  assert.match(html, /Count admission passes: 180 measured/);
  assert.ok(!html.includes("enforcement must refuse"));
  for (const path of ["production.ts", "guard.test.ts", "fixture.test.ts"])
    assert.ok(html.includes(`<code>${path}</code>`));
  assert.ok(html.includes("path leaves the edited set"));
  assert.ok(html.includes("upstream adopts the test"));
});
test("R12 seventeen is the stored spec proposal, never an admitted physical target", () => {
  assert.ok(api);
  const html = api.renderTaxViews(debtFacts(), "bound", true);
  assert.match(html, /Stored proposal[\s\S]*?<strong>17<\/strong>/);
  assert.match(html, /spec design population/);
  assert.match(html, /No physical target is admitted/);
  assert.ok(!html.includes("target physical paths"));
  assert.ok(!html.includes("Proposed physical target"));
  assert.ok(!html.includes("Stop at 17 only when 17 physical paths remain"));
});
test("R12 recorded move state and zero count delta do not invent landing custody", () => {
  assert.ok(api);
  const html = api.renderTaxViews(debtFacts(), "bound");
  assert.ok(!html.includes("No feature moves were performed"));
  assert.ok(html.includes("native-review-tokenization-move-2026-10-12"));
  assert.ok(html.includes("approved-before-implementation"));
  assert.match(html, /implementation location changed/);
  assert.match(html, /180 → 180; count delta 0/);
  assert.ok(html.includes("Landing commit not recorded"));
});
test("one facts file projects six views and every original move, with no authored HTML input", () => {
  assert.ok(api, "tax view projector is missing");
  const manifest = {
    counts: { upstream_edit: 2 },
    tax_policy: {
      target_count: 1,
      baseline_count: 2,
      count_history: [{ label: "measured", count: 2 }],
      plan_note: "A proposed target, not a performed move.",
    },
    entries: [
      {
        path: "one.ts",
        class: "upstream-edit",
        reason: "Keep the mount.",
        feature: "F",
        seam_side: "upstream-mount",
        decision: "keep",
        plan: { status: "retained-target-mount" },
      },
      {
        path: "two.ts",
        class: "upstream-edit",
        reason: "Move the implementation.",
        feature: "F",
        seam_side: "upstream-implementation",
        decision: "move-to-fork-side",
        plan: {
          status: "open-original-160",
          destination: "fork/two.ts",
          action: "Restore upstream after moving the behavior.",
          size: { changed_lines: 12, static_private_imports: 1, basis: "Measured diff" },
        },
      },
    ],
  };
  const html = api.renderTaxViews(manifest, "1234");
  for (const id of ["files", "features", "seams", "customizations", "history", "moves"])
    assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes("fork/two.ts"));
  assert.ok(html.includes("12 baseline changed lines"));
  assert.ok(html.includes("1234"));
  const firstEntry = manifest.entries[0];
  assert.ok(firstEntry);
  const escaped = api.renderTaxViews(
    {
      ...manifest,
      entries: [{ ...firstEntry, reason: "</script><script>alert(1)</script>" }],
    },
    "a",
  );
  assert.ok(!escaped.includes("<script>alert(1)</script>"));
  assert.ok(escaped.includes("&lt;/script&gt;"));
});
test("graph refuses cycles and stale lineage, and binary sizing is not zero", async () => {
  const { defaultTaxMap } = await import("./tax-map.ts");
  const manifest = {
    counts: { upstream_edit: 1 },
    tax_policy: {
      target_count: 1,
      baseline_count: 1,
      count_history: [{ label: "measured", count: 1 }],
      plan_note: "Proposal",
    },
    entries: [
      {
        path: "asset.png",
        class: "upstream-edit",
        reason: "Preserve product asset",
        decision: "keep",
        plan: {
          status: "retained-target-mount",
          size: {
            changed_lines: 0,
            static_private_imports: 0,
            binary: true,
            current_added_lines: null,
            current_deleted_lines: null,
            basis: "Git binary numstat",
          },
        },
      },
    ],
  };
  const facts = defaultTaxMap(manifest, "bound");
  assert.throws(
    () =>
      api!.renderTaxViews(manifest, "different", false, {
        facts,
        factsPath: "facts.json",
        css: "",
      }),
    /STALE_FACTS/,
  );
  assert.throws(
    () =>
      api!.renderTaxViews(manifest, "bound", false, {
        facts: {
          ...facts,
          edges: [...facts.edges, { id: "cycle", from: "plan", to: "ledger", contract: "invalid" }],
        },
        factsPath: "facts.json",
        css: "",
      }),
    /CYCLE/,
  );
  const html = api!.renderTaxViews(manifest, "bound");
  assert.ok(html.includes("N/A · binary"));
  assert.ok(!html.includes("0 baseline changed lines"));
  assert.equal((html.match(/class="node" data-id=/g) || []).length, 8);
  assert.ok(html.includes("data-source-facts="));
  assert.ok(html.includes("Copy agent context packet"));
  assert.ok(html.includes("current-state-operating-map"));
});

test("R13 hero requires derived admission values and labels seventeen only as a stored proposal", async () => {
  const { wrapTaxMap } = await import("./tax-map.ts");
  assert.throws(
    () => wrapTaxMap("<html><body></body></html>", debtFacts(), "bound"),
    /TAX_MAP_POLICY_HERO_REQUIRED/,
  );
  const html = api!.renderTaxViews(debtFacts(), "bound"),
    hero = html.match(/<header class="hero">[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.match(hero, /Effective ceiling[\s\S]*?<strong>180<\/strong>/);
  assert.match(hero, /baseline 177 \+ 3 acknowledged debts \+ 0 validated credit/);
  assert.match(hero, /Stored proposal[\s\S]*?<strong>17<\/strong>/);
  assert.match(hero, /no physical target admitted/);
});
test("R13 retain-minimized destinations stay on the stock path", () => {
  const facts = debtFacts(),
    manifest = {
      ...facts,
      entries: facts.entries.map((e) => ({
        ...e,
        plan: { ...e.plan, destination: "fork/" + e.path },
      })),
    };
  const html = api!.renderTaxViews(manifest, "bound", true);
  assert.match(html, /stays on the stock path, retained-minimized/);
  const row = [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)]
    .map((x) => x[0])
    .find((x) => x.includes("guard.test.ts") && x.includes("baseline changed lines"));
  assert.ok(row);
  assert.ok(!row.includes("fork/guard.test.ts"));
});
test("R13 recorded moves table consumes landed state and landing commit without promoting other rows", () => {
  const facts = debtFacts(),
    commit = "3094671b25d28be5ff704c6d419e98ffcb283bf7";
  const manifest = {
    ...facts,
    approved_changes: facts.approved_changes.map((row) => ({
      ...row,
      state: "landed",
      landing_commit: commit,
    })),
  };
  const html = api!.renderTaxViews(manifest, "bound", true);
  const section = html.match(/<section[^>]*id="recorded-moves">[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(section, /<td>landed<\/td>/);
  assert.ok(section.includes(commit));
});

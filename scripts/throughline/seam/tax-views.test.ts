import { test } from "node:test";
import assert from "node:assert/strict";
const api = await import("./tax-views.ts").catch(() => null);
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
  const escaped = api.renderTaxViews(
    {
      ...manifest,
      entries: [{ ...manifest.entries[0], reason: "</script><script>alert(1)</script>" }],
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

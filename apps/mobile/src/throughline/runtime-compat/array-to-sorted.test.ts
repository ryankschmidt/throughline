// @effect-diagnostics nodeBuiltinImport:off - cold, isolated compatibility controls.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const registrationUrl = new URL("./array-to-sorted.ts", import.meta.url).href;
const mobileRoot = NodeURL.fileURLToPath(new URL("../../../..", import.meta.url));

function cold(missing: boolean, expression: string): unknown {
  const program = `
    const originalAt = Array.prototype.at;
    const originalToSorted = Array.prototype.toSorted;
    ${missing ? "delete Array.prototype.toSorted;" : ""}
    await import(${JSON.stringify(registrationUrl)});
    try {
      process.stdout.write(JSON.stringify(${expression}));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.name }));
    }
  `;
  const result = NodeChildProcess.execFileSync(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "--eval", program],
    {
      cwd: mobileRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: NodeOS.tmpdir(),
        TMPDIR: NodeOS.tmpdir(),
        LANG: "C",
        NODE_ENV: "test",
      },
      encoding: "utf8",
    },
  );
  return JSON.parse(result);
}

describe("fork native Array compatibility", () => {
  it("restores missing toSorted for the unchanged latest-usage chain without mutating input or at", () => {
    expect(
      cold(
        true,
        `(() => {
        const turns = [
          { providerThreadId: 'owned', ordinal: 9, tokenUsage: 'latest' },
          { providerThreadId: 'owned', ordinal: 3, tokenUsage: 'earlier' },
          { providerThreadId: 'other', ordinal: 99, tokenUsage: 'other' },
        ];
        const latest = turns.filter(turn => turn.providerThreadId === 'owned' && turn.tokenUsage !== undefined)
          .toSorted((a, b) => a.ordinal - b.ordinal).at(-1)?.tokenUsage;
        return { latest, ordinals: turns.map(turn => turn.ordinal), atUnchanged: Array.prototype.at === originalAt };
      })()`,
      ),
    ).toEqual({ latest: "latest", ordinals: [9, 3, 99], atUnchanged: true });
  });

  it("preserves a working native toSorted and at", () => {
    expect(
      cold(
        false,
        `({
        toSortedUnchanged: Array.prototype.toSorted === originalToSorted,
        atUnchanged: Array.prototype.at === originalAt,
        sorted: [3, 1, 2].toSorted((a, b) => a - b),
      })`,
      ),
    ).toEqual({ toSortedUnchanged: true, atUnchanged: true, sorted: [1, 2, 3] });
  });

  it("copies and densifies sparse arrays without filling the source hole", () => {
    expect(
      cold(
        true,
        `(() => {
        const source = [, 2, 1];
        const result = source.toSorted((a, b) => a - b);
        return { values: result, sourceHasHole: !(0 in source), dense: 2 in result, separate: result !== source };
      })()`,
      ),
    ).toEqual({ values: [1, 2, null], sourceHasHole: true, dense: true, separate: true });
  });

  it("supports generic array-like receivers and default lexical comparison", () => {
    expect(cold(true, `Array.prototype.toSorted.call({ 0: 2, 1: 10, length: 2 })`)).toEqual([
      10, 2,
    ]);
  });

  it("keeps equal-key order and accepts a frozen input", () => {
    expect(
      cold(
        true,
        `(() => {
        const source = Object.freeze([{ ordinal: 1, id: 'a' }, { ordinal: 1, id: 'b' }, { ordinal: 0, id: 'c' }]);
        return { sorted: source.toSorted((a, b) => a.ordinal - b.ordinal).map(x => x.id), original: source.map(x => x.id) };
      })()`,
      ),
    ).toEqual({ sorted: ["c", "a", "b"], original: ["a", "b", "c"] });
  });

  it("rejects a non-callable comparator", () => {
    expect(cold(true, `[3, 1, 2].toSorted(null)`)).toEqual({ error: "TypeError" });
  });
});

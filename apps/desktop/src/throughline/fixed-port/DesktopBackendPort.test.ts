import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NetService from "@t3tools/shared/Net";
import { resolveDesktopBackendPort } from "../../app/DesktopApp.ts";
import { parsePortHolders, portConflictMessage } from "./DesktopPortHolder.ts";

const network = (probes: number[], occupied?: number) =>
  Layer.succeed(NetService.NetService, {
    ...NetService.make(),
    canListenOnHost: (port: number) => {
      probes.push(port);
      return Effect.succeed(port !== occupied);
    },
  });

describe("desktop fixed backend port", () => {
  it("names and deduplicates the actual listening programs and PIDs", () => {
    const holders = parsePortHolders(
      "p123\ncThroughLine\np123\ncThroughLine\np456\ncT3 Code (Nightly)\n",
    );
    assert.deepEqual(holders, [
      { pid: 123, program: "ThroughLine" },
      { pid: 456, program: "T3 Code (Nightly)" },
    ]);
    const message = portConflictMessage(3773, holders);
    assert.include(message, "ThroughLine (PID 123)");
    assert.include(message, "T3 Code (Nightly) (PID 456)");
    assert.include(message, "Quit");
    assert.include(message, "3773");
  });

  it("does not invent an owner when discovery is unavailable", () => {
    assert.deepEqual(parsePortHolders("pnope\ncunknown\np0\ncroot\n"), []);
    assert.include(portConflictMessage(3773, []), "could not identify");
  });

  it.effect("uses only 3773 by default without selecting a scanned port", () =>
    Effect.gen(function* () {
      const probes: number[] = [];
      const result = yield* resolveDesktopBackendPort(Option.none()).pipe(
        Effect.provide(network(probes)),
      );
      assert.equal(result.port, 3773);
      assert.equal(result.selectedByScan, false);
      assert.ok(probes.every((port) => port === 3773));
    }),
  );

  it.effect("refuses occupied 3773 instead of moving to 3774", () =>
    Effect.gen(function* () {
      const probes: number[] = [];
      const result = yield* Effect.exit(
        resolveDesktopBackendPort(Option.none()).pipe(Effect.provide(network(probes, 3773))),
      );
      assert.ok(Exit.isFailure(result));
      assert.ok(probes.length > 0);
      assert.ok(probes.every((port) => port === 3773));
    }),
  );

  it.effect("preserves an explicit port without scanning", () =>
    Effect.gen(function* () {
      const probes: number[] = [];
      const result = yield* resolveDesktopBackendPort(Option.some(3790)).pipe(
        Effect.provide(network(probes)),
      );
      assert.equal(result.port, 3790);
      assert.equal(result.selectedByScan, false);
      assert.deepEqual(probes, []);
    }),
  );
});

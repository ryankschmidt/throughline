import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NetService from "@t3tools/shared/Net";
import { resolveDesktopBackendPort } from "../../app/DesktopApp.ts";
import { findPortHolders, parsePortHolders, portConflictMessage } from "./DesktopPortHolder.ts";

const network = (probes: number[], occupied?: number) =>
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(NetService.NetService, {
      ...NetService.make(),
      canListenOnHost: (port: number) => {
        probes.push(port);
        return Effect.succeed(port !== occupied);
      },
    }),
  );

describe("desktop fixed backend port", () => {
  it.effect("identifies an owned real listener without stopping it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [
              "-e",
              "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
            ],
            { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
          ),
        );
        const output = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.take(1),
          Stream.mkString,
        );
        const port = Number(output.trim());
        assert.ok(port > 0);
        const holders = yield* findPortHolders(port);
        assert.ok(holders.some((holder) => holder.pid === Number(child.pid)));
        const again = yield* findPortHolders(port);
        assert.ok(again.some((holder) => holder.pid === Number(child.pid)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

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

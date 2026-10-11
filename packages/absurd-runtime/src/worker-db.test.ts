import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AbsurdOptions } from "absurd-sdk";
import type { ThreadTransport } from "./thread-driver.ts";

const captured = vi.hoisted(() => ({
  options: [] as Array<AbsurdOptions>,
  gates: new Map<string, { promise: Promise<void>; resolve: () => void }>(),
  started: new Map<string, { promise: Promise<void>; resolve: () => void }>(),
}));
vi.mock("absurd-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("absurd-sdk")>();
  return {
    ...actual,
    Absurd: class {
      readonly queueName: string;
      constructor(options: AbsurdOptions) {
        this.queueName = options.queueName ?? "default";
        captured.options.push(options);
      }
      registerTask() {}
      async createQueue() {
        await captured.gates.get(this.queueName)?.promise;
      }
      async startWorker() {
        captured.started.get(this.queueName)?.resolve();
        return { close: async () => {} };
      }
      async close() {}
    },
  };
});
import { startAbsurdRuntime } from "./worker.ts";
import { AGENT_QUEUE } from "./agent-queue.ts";
import { SYMPHONY_QUEUE } from "./symphony-queue.ts";

const transport: ThreadTransport = {
  resolveThread: async () => ({ threadId: "fixture", created: false }),
  dispatchTurn: async () => ({ turnId: "fixture", dispatchedAt: "2026-10-11T00:00:00Z" }),
  awaitTurnComplete: async () => ({ state: "completed", summary: "fixture" }),
};
let runtime: ReturnType<typeof startAbsurdRuntime> | undefined;
beforeEach(() => {
  captured.options.length = 0;
  captured.gates.clear();
  captured.started.clear();
});
afterEach(async () => {
  for (const gate of captured.gates.values()) gate.resolve();
  await runtime?.close();
  runtime = undefined;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["fixture-main", AGENT_QUEUE, SYMPHONY_QUEUE])(
  "runtime readiness waits for the %s queue as well as its siblings",
  async (blocked) => {
    const queues = ["fixture-main", AGENT_QUEUE, SYMPHONY_QUEUE];
    for (const queue of queues) {
      captured.gates.set(queue, deferred());
      captured.started.set(queue, deferred());
    }
    runtime = startAbsurdRuntime({ queueName: "fixture-main", transport });
    expect(runtime.ready).toBeInstanceOf(Promise);
    let ready = false;
    void runtime.ready.then(() => {
      ready = true;
    });
    for (const queue of queues) if (queue !== blocked) captured.gates.get(queue)!.resolve();
    await Promise.all(
      queues
        .filter((queue) => queue !== blocked)
        .map((queue) => captured.started.get(queue)!.promise),
    );
    expect(ready).toBe(false);
    captured.gates.get(blocked)!.resolve();
    await runtime.ready;
    expect(ready).toBe(true);
  },
);

describe("fixture-owned Absurd connection forwarding (controlled SDK constructor)", () => {
  it("forwards the same explicit database to interactive, fanout and symphony apps", () => {
    const db = "postgresql://fixture.invalid/isolated-not-connected";
    runtime = startAbsurdRuntime({ queueName: "fixture-main", transport, db });
    expect(captured.options).toHaveLength(3);
    expect(captured.options.map((row) => row.queueName)).toEqual([
      "fixture-main",
      AGENT_QUEUE,
      SYMPHONY_QUEUE,
    ]);
    for (const row of captured.options) expect(row.db).toBe(db);
  });
  it("keeps the three original SDK constructor inputs when the connection is unset", () => {
    runtime = startAbsurdRuntime({ queueName: "fixture-main", transport });
    expect(captured.options).toHaveLength(3);
    for (const row of captured.options) expect(Object.hasOwn(row, "db")).toBe(false);
  });
});

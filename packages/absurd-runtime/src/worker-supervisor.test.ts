import { describe, expect, it } from "vite-plus/test";
import { startSupervisedWorker } from "./worker-supervisor.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("worker/pool shutdown ordering", () => {
  it("closes the actual worker handle before its pool", async () => {
    const started = deferred();
    const calls: Array<string> = [];
    const handle = startSupervisedWorker({
      label: "fixture",
      concurrency: 1,
      log: () => {},
      sleep: async () => {},
      createApp: () => ({
        startWorker: async () => {
          calls.push("worker.start");
          started.resolve();
          return {
            close: async () => {
              calls.push("worker.close");
            },
          };
        },
        close: async () => {
          calls.push("pool.close");
        },
      }),
      registerTasks: () => {},
    });
    await started.promise;
    await handle.close();
    expect(calls).toEqual(["worker.start", "worker.close", "pool.close"]);
  });
  it("cannot begin polling after close while queue preparation is in flight", async () => {
    const prepared = deferred();
    const calls: Array<string> = [];
    const handle = startSupervisedWorker({
      label: "fixture",
      concurrency: 1,
      log: () => {},
      createApp: () => ({
        startWorker: async () => {
          calls.push("worker.start");
          return {
            close: async () => {
              calls.push("worker.close");
            },
          };
        },
        close: async () => {
          await prepared.promise;
          calls.push("pool.close");
        },
      }),
      registerTasks: () => {},
      prepareQueue: () => prepared.promise,
    });
    const closing = handle.close();
    prepared.resolve();
    await closing;
    expect(calls).toEqual(["pool.close"]);
  });
});

describe("explicit worker readiness", () => {
  it("does not resolve before queue preparation and worker startup both finish", async () => {
    const prepared = deferred(),
      started = deferred(),
      reachedStart = deferred();
    let ready = false;
    const handle = startSupervisedWorker({
      label: "fixture",
      concurrency: 1,
      log: () => {},
      createApp: () => ({
        startWorker: async () => {
          reachedStart.resolve();
          await started.promise;
          return { close: async () => {} };
        },
        close: async () => {},
      }),
      registerTasks: () => {},
      prepareQueue: () => prepared.promise,
    });
    try {
      expect(handle.ready).toBeInstanceOf(Promise);
      void handle.ready.then(() => {
        ready = true;
      });
      expect(ready).toBe(false);
      prepared.resolve();
      await reachedStart.promise;
      expect(ready).toBe(false);
      started.resolve();
      await handle.ready;
      expect(ready).toBe(true);
    } finally {
      prepared.resolve();
      started.resolve();
      await handle.close();
    }
  });
  it("refuses readiness when preparation fails instead of claiming a worker exists", async () => {
    const failure = new Error("fixture preparation refused");
    const handle = startSupervisedWorker({
      label: "fixture",
      concurrency: 1,
      log: () => {},
      createApp: () => ({
        startWorker: async () => {
          throw new Error("must not start");
        },
        close: async () => {},
      }),
      registerTasks: () => {},
      prepareQueue: async () => {
        throw failure;
      },
    });
    try {
      expect(handle.ready).toBeInstanceOf(Promise);
      await expect(handle.ready).rejects.toBe(failure);
    } finally {
      await handle.close();
    }
  });
  it("cannot resolve readiness after close cancels pending startup", async () => {
    const prepared = deferred();
    const handle = startSupervisedWorker({
      label: "fixture",
      concurrency: 1,
      log: () => {},
      createApp: () => ({
        startWorker: async () => {
          throw new Error("must not start");
        },
        close: async () => {},
      }),
      registerTasks: () => {},
      prepareQueue: () => prepared.promise,
    });
    try {
      expect(handle.ready).toBeInstanceOf(Promise);
      const readiness = expect(handle.ready).rejects.toThrow("closed before readiness");
      const closing = handle.close();
      prepared.resolve();
      await readiness;
      await closing;
    } finally {
      prepared.resolve();
      await handle.close();
    }
  });
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { PrepareGate } from "./AcknowledgedWatch.ts";

// Original public assertion/fixture inputs relocated from custody source; only the
// interception moves to the qualified pre-open gate. No second platform watcher.
it.effect("server settings waits for linked watcher attachment before announcing ready", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const returned = yield* Ref.make(false);
      let targetDirectory: string | undefined;
      const layerConfig = Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-settings-registration-gate-",
        }),
      );
      const preparation = Layer.succeed(PrepareGate, (directory) =>
        Effect.gen(function* () {
          const actualDirectory = yield* fs.realPath(directory).pipe(Effect.orDie);
          if (actualDirectory === targetDirectory) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
        }),
      );
      const layer = ServerSettingsModule.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provide(preparation),
        Layer.provideMerge(layerConfig),
      );
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-gated-target-" });
        targetDirectory = yield* fs.realPath(dotfiles);
        const destination = path.join(dotfiles, "settings.json");
        yield* fs.writeFileString(destination, '{"responseStreamingMode":"turn"}');
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(destination, config.settingsPath);
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const startup = yield* service.start.pipe(
          Effect.tap(() => Ref.set(returned, true)),
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        // The public cache load is an explicit barrier, not a timer or polling loop.
        assert.equal((yield* service.getSettings).responseStreamingMode, "turn");
        const announcedBeforeAttachment = yield* Ref.get(returned);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(startup);
        assert.isFalse(
          announcedBeforeAttachment,
          "ready returned while target watch registration was held closed",
        );
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

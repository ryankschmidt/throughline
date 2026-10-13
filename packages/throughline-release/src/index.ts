import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

const platformNames = [
  "mac",
  "tower-desktop",
  "tower-headless",
  "iphone",
  "android",
  "rpi",
] as const;
const Platform = Schema.Literals(platformNames);
const Nonempty = Schema.String.check(Schema.isNonEmpty());
const Version = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/));
const StampSchema = Schema.Struct({
  schema: Schema.Literal("throughline.release-stamp.v2"),
  version: Version,
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  upstream_base_commit: Schema.String.check(Schema.isPattern(/^(?!0{40}$)[a-f0-9]{40}$/)),
  cut_from: Schema.Literal("main"),
  stamped_at: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  ),
  stamped_by: Nonempty,
  platforms: Schema.Array(Platform),
  deferred: Schema.Array(Schema.Struct({ platform: Platform, ruling: Nonempty, source: Nonempty })),
});
const decodeStamp = Schema.decodeUnknownSync(Schema.fromJsonString(StampSchema), {
  onExcessProperty: "error",
});
export type ReleaseStamp = typeof StampSchema.Type;
export type ReadStampText = (file: URL) => string;
export type StampPurpose = "development" | "release";
export const RELEASE_STAMP_FILE = new URL("../ThroughLine-Release-Stamp.json", import.meta.url);

/** Format/validation is owned here; callers supply synchronous filesystem capability for build bootstrap. */
export function readReleaseStamp(
  readText: ReadStampText,
  file = RELEASE_STAMP_FILE,
  purpose: StampPurpose = "release",
): ReleaseStamp {
  let stamp: ReleaseStamp;
  try {
    stamp = decodeStamp(readText(file));
    const normalizedTimestamp = stamp.stamped_at.includes(".")
      ? stamp.stamped_at.replace(
          /\.(\d+)Z$/,
          (_, digits: string) => `.${digits.padEnd(3, "0").slice(0, 3)}Z`,
        )
      : stamp.stamped_at.replace(/Z$/, ".000Z");
    if (DateTime.formatIso(DateTime.makeUnsafe(stamp.stamped_at)) !== normalizedTimestamp) {
      throw new Error("RELEASE_STAMP_TIMESTAMP_INVALID");
    }
  } catch {
    // Do not copy raw file contents or errors into build output.
    throw new Error("RELEASE_STAMP_MISSING_OR_MALFORMED");
  }
  const selected = new Set(stamp.platforms);
  const deferred = new Set(stamp.deferred.map((entry) => entry.platform));
  if (
    selected.size !== stamp.platforms.length ||
    deferred.size !== stamp.deferred.length ||
    stamp.commit === "0".repeat(40) ||
    stamp.version === "0.0.0" ||
    platformNames.some((platform) => selected.has(platform) === deferred.has(platform))
  ) {
    throw new Error("RELEASE_STAMP_PLATFORM_OR_IDENTITY_INVALID");
  }
  releaseBuildIdentity(stamp);
  if (purpose !== "development" && purpose !== "release") {
    throw new Error("RELEASE_STAMP_PURPOSE_INVALID");
  }
  if (purpose === "release") {
    if (stamp.stamped_by.startsWith("development:")) {
      throw new Error("RELEASE_STAMP_DEVELOPMENT_NOT_RELEASE");
    }
    if (!/^throughline-ship@\d+\.\d+\.\d+$/.test(stamp.stamped_by)) {
      throw new Error("RELEASE_STAMP_WRITER_NOT_RELEASE_TOOL");
    }
  }
  // Writer-label classification is not custody or readiness proof. The ship tool
  // additionally binds its stage-time bytes and main commit to the run ledger.
  return stamp;
}

/** Same release always yields the same native counter: major*1_000_000 + minor*1_000 + patch. */
export function releaseBuildIdentity(stamp: Pick<ReleaseStamp, "version">) {
  const parts = stamp.version.split(".").map(Number);
  const major = parts[0],
    minor = parts[1],
    patch = parts[2];
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !parts.every(Number.isSafeInteger) ||
    minor > 999 ||
    patch > 999
  ) {
    throw new Error("RELEASE_STAMP_BUILD_COUNTER_INVALID");
  }
  const counter = major * 1_000_000 + minor * 1_000 + patch;
  if (counter < 1 || counter > 2_100_000_000)
    throw new Error("RELEASE_STAMP_BUILD_COUNTER_INVALID");
  return { iosBuildNumber: String(counter), androidVersionCode: counter };
}

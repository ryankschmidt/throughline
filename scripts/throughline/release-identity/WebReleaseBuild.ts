import {
  readReleaseStamp,
  type ReadStampText,
  type ReleaseStamp,
  type StampPurpose,
} from "../../../packages/throughline-release/src/index.ts";

let building = false;
/** The stock Vite config already embeds APP_VERSION; this wrapper owns its stamped input and refuses before build. */
export async function withWebReleaseStamp<T>(
  readText: ReadStampText,
  build: (stamp: ReleaseStamp) => Promise<T>,
  purpose: StampPurpose = "release",
): Promise<T> {
  if (building) throw new Error("RELEASE_BUILD_ALREADY_ACTIVE");
  const stamp = readReleaseStamp(readText, undefined, purpose);
  const previousVersion = process.env.APP_VERSION;
  const previousCommit = process.env.APP_COMMIT;
  building = true;
  process.env.APP_VERSION = stamp.version;
  process.env.APP_COMMIT = stamp.commit;
  try {
    return await build(stamp);
  } finally {
    if (previousVersion === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = previousVersion;
    if (previousCommit === undefined) delete process.env.APP_COMMIT;
    else process.env.APP_COMMIT = previousCommit;
    building = false;
  }
}

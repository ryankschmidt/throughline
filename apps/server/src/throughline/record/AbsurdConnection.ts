import type { StartAbsurdRuntimeOptions } from "@t3tools/absurd-runtime";
import * as Context from "effect/Context";

/** Default leaves SDK environment resolution unchanged. Fixture values stay fiber-local. */
export const AbsurdConnection = Context.Reference<StartAbsurdRuntimeOptions["db"]>(
  "t3/throughline/record/AbsurdConnection",
  { defaultValue: () => undefined },
);

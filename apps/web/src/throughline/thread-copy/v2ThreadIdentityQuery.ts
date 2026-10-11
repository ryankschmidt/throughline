import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
import type { ThreadCopyIdentity } from "./threadCopy";
import { identityFromV2Projection } from "./v2ThreadIdentity";

/** The environment-bound state owns the read; the identity adapter stays pure. */
export function readV2ThreadIdentity(ref: ScopedThreadRef): ThreadCopyIdentity | null {
  const projection = Option.getOrNull(
    appAtomRegistry.get(environmentThreadDetails.stateAtom(ref)).data,
  );
  return identityFromV2Projection(ref, projection);
}

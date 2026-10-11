// Specification intake only; no product messaging implementation.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
const BASE =
  "/Users/Admin/core-root/vault/01_Projects/workbench/infra/throughline/plans/next-gen-spec-2026-10-07";
const CORPUS =
  "/Users/Admin/core-root/vault/00_Core/Architecture/Intent-Layer/foundation/shape-adapter/corpus";
export const MESSAGING_SOURCES = {
  order: BASE + "/execution/phase-04/Order-Phase-4-Delivery-Lead.txt",
  oct10:
    CORPUS +
    "/SHAPE-2026-10-10-ryan-comsnet-is-the-original-socket-design-and-absurd-owns-the-message-record.yaml",
  oct11:
    CORPUS +
    "/SHAPE-2026-10-11-ryan-messages-are-steps-tasks-or-events-other-paths-retired-and-routed-ryan-carries-his-device.yaml",
  inventory: BASE + "/execution/phase-04/substrate-design-check/Design-vs-Installed.json",
  rubric: BASE + "/execution/lead-transfer/Process-Vs-Delivery-Rubric-20261011.txt",
};
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export function readMessagingSources() {
  const order = readFileSync(MESSAGING_SOURCES.order, "utf8");
  const start = order.indexOf('"## The 4-Part ThroughLine Messaging Target:');
  const end = order.indexOf('"\nWHAT EXISTS TODAY', start);
  if (start < 0 || end < 0) throw Error("four-part target quotation boundaries missing");
  const target = order.slice(start + 1, end);
  const shape = (path: string) => (yaml.load(readFileSync(path, "utf8")) as any).shapes[0];
  const oct10 = shape(MESSAGING_SOURCES.oct10),
    oct11 = shape(MESSAGING_SOURCES.oct11);
  const device = oct11.operator_statement
    .split("\n\n")
    .find((p: string) => p.startsWith("And also, in your descriptions"));
  if (!device) throw Error("complete Ryan/device paragraph missing");
  const quote = (text: string, path: string, source?: any) => ({
    quote: text,
    source_path: path,
    source_sha256: digest(readFileSync(path)),
    quote_sha256: digest(text),
    ...(source ?? {}),
  });
  const inventory = JSON.parse(readFileSync(MESSAGING_SOURCES.inventory, "utf8"));
  const paths = inventory.rows.find((r: any) => r.id === "P4")?.paths_to_retire;
  if (!Array.isArray(paths) || paths.length !== 10)
    throw Error("P4 requires nine paths and its admission-only exclusion");
  return {
    quotes: {
      D07: quote(oct10.operator_statement, MESSAGING_SOURCES.oct10, oct10.source),
      D26: quote(target, MESSAGING_SOURCES.order),
      D27: quote(oct11.operator_statement, MESSAGING_SOURCES.oct11, oct11.source),
      D28: quote(device, MESSAGING_SOURCES.oct11, oct11.source),
    },
    inventory: {
      source_path: MESSAGING_SOURCES.inventory,
      source_sha256: digest(readFileSync(MESSAGING_SOURCES.inventory)),
      row: "P4",
      paths_to_retire: paths.slice(0, 9),
      admission_only_exclusion: paths[9],
    },
  };
}
export const RECORD_RULE = {
  step: "A message inside one conversation, including Ryan's typed message, its reply and tool calls, is a step of that conversation's task.",
  task: "A request asking another agent for work and expecting a reply is a task on the receiver's queue, keyed by its request id, with the reply as its result; peers and parent/child use the same rule.",
  event:
    "A signal with no reply is an event; no relationship-based classification and no carve-out for Ryan.",
};
export const CUTOVER_WINDOW = {
  release:
    "The next ThroughLine release after 0.0.60 carrying the reconciled upstream merge is the cutover release.",
  before_cut:
    "Retire every P4 alternative in the candidate: neither advertised nor independently usable. Route attempted retired/unapproved avenues into ComsNet and Absurd. Preserve upstream code; a Fable design pass on the merged code decides routing without upstream tax. Fork-only relay code may be removed. The old JSON store is retained read-only, never a live message record.",
  before_install:
    "The release refuses if any P4 path is advertised or independently usable in the release or its accepted agent environments, if any path lacks a measured probe, or if the checks lack known-good passing and known-bad failing fixtures. Existing build-only tools may remain in the old build environment until installed coverage succeeds; they are not allowed in the accepted candidate environment.",
  install_day:
    "On Mac, tower, iPhone and Android, a non-builder measures every actual agent-to-agent request against Absurd: exactly one task, idempotency key equal to request id, reply equal to task result, no completed dispatched-only tasks and zero unmatched requests/replies. Repeat a request id and prove one task and one reply; a real request/reply is required on each device, so zero rows never pass.",
  after_coverage:
    "Immediately after installed parts 1-3 pass, retire agent-instruments send/thread-create and dependent wakes/relays from active runtimes through Ship Warden in the same install window. Any retained command compatibility routes only into ComsNet/Absurd and is never an alternative channel. Post-retirement non-builder probes are required before release closure; rollback is automatic and agent-run.",
  proof_limit:
    "These are spec requirements and planned installed-product checks, not evidence that messaging has shipped or that any installed path is retired.",
};
const planned = {
  kind: "real-disk",
  expected_today: "measure on first run",
  file_ready: false,
  note: "Planned product check; add to spec.checks only after its executable exists (X05). Calibrate both fixture polarities before gating an install.",
};
export const RETIREMENT_CHECK = {
  id: "T7.04-cutover",
  kind: "contract-test",
  command:
    "Before cut/install and after runtime retirement, inventory advertised tools, candidate code routing and active agent runtimes; probe each of the nine P4 paths for advertisement, direct delivery and routed delivery; bind outcomes to the pinned release source and environment.",
  expect:
    "Every P4 alternative is absent from advertisement and cannot deliver off-rail. Attempts through retained compatibility code arrive only through authenticated ComsNet and Absurd. Missing/unprobed paths refuse; admission-only exclusions remain covered by T3.01. Upstream code need not be deleted.",
  fixtures: {
    pass: "All nine paths measured, no alternatives advertised/usable; retained upstream HTTP code routes the attempt onto the rail and the read-only old store cannot accept writes.",
    fail: "For each P4 path separately, advertise it or allow off-rail delivery: release refuses. Omit a path's probe: release refuses. Keep a build-only relay in an accepted agent runtime: release refuses.",
  },
  spec_projection: planned,
};
export const COVERAGE_CHECK = {
  id: "T7.03-request-record",
  kind: "contract-test",
  command:
    "On install day a non-builder sends and awaits replies on each active device, compares the complete observed request/reply census with Absurd tasks through the record read API, and repeats a request id; include peers and parent/child, plus a conversation step and a no-reply signal event from Ryan and an agent.",
  expect:
    "Mac, tower, iPhone and Android each have a nonzero actual sample; every reply-expecting request has exactly one receiver task keyed by request id whose result is the reply. Retry creates no second task/reply. Conversation messages are steps and signals events for Ryan and agents alike. No dispatched-only completion and no unmatched request or reply.",
  fixtures: {
    pass: "Each of four devices sends one request with a terminal reply result; peers and parent/child have matching request-id keys; duplicate reuses its task; Ryan/agent conversation steps and signal events are recorded.",
    fail: "Missing task, wrong request-id key, reply missing/different, dispatched-only completion, duplicate task/reply, missing device, empty census, builder witness, peer request stored only as a step, or Ryan message outside the record: each refuses.",
  },
  spec_projection: planned,
};
export const DEVICE_IDENTITY = {
  owner: ["T5.01", "T5.02"],
  devices: ["iPhone", "Android", "Mac", "tower"],
  rule: "Each of Ryan's four devices has its own durable unique public identity on the same identity/alias rails as agents, bound to Ryan as sender. Every message records the authenticated sender and device, retains both across replay, relay and dictation/optimization, and exposes them as context to receiving agents. Same thread, consecutive iPhone and Mac messages: same Ryan sender, different device identities. Payload fields cannot spoof sender or device.",
};
export const DEVICE_CHECK = {
  id: "T5.02-device",
  kind: "contract-test",
  command:
    "A non-builder sends from each of Ryan's four devices and an agent, then sends consecutively from iPhone and Mac into one thread; read the admitted record and recipient context; forge a sender/device, replay and relay a message, dictate and optimize one.",
  expect:
    "Four distinct stable device public identities using T5.01 rails; every record/context carries actual sender and source device. Ryan remains Ryan when changing device; a relay never becomes Ryan. Forged sender/device refuses; replay and optimization preserve authenticated origin.",
  fixtures: {
    pass: "Four devices with distinct ids, same Ryan sender, and an agent sender; iPhone-to-Mac switch in one thread, replay, relay and optimized message preserve origin and recipient context.",
    fail: "Missing/shared device id, spoofed sender/device accepted, relay stamped as Ryan, phone stamped as desktop, or record correct but recipient context missing device: each refuses.",
  },
  spec_projection: planned,
};

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";

export interface PortHolder {
  readonly pid: number;
  readonly program: string;
}

/** lsof's field protocol avoids whitespace-dependent process-name parsing. */
export function parsePortHolders(output: string): PortHolder[] {
  const holders = new Map<number, PortHolder>();
  let pid: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const value = Number(line.slice(1));
      pid = Number.isSafeInteger(value) && value > 0 ? value : undefined;
    } else if (line.startsWith("c") && pid !== undefined) {
      const program = line.slice(1).trim();
      if (program) holders.set(pid, { pid, program });
    }
  }
  return [...holders.values()];
}

const run = promisify(execFile);

/** Discovery is read-only. Failure must never become permission to kill a guessed owner. */
export const findPortHolders = (port: number) =>
  Effect.tryPromise(async () => {
    const { stdout } = await run(
      process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    return parsePortHolders(stdout);
  }).pipe(Effect.orElseSucceed((): PortHolder[] => []));

export function portConflictMessage(port: number, holders: readonly PortHolder[]): string {
  const owner = holders.length
    ? holders.map(({ program, pid }) => `${program} (PID ${pid})`).join(", ")
    : "another program (ThroughLine could not identify its name or PID)";
  return `ThroughLine cannot start because TCP port ${port} is unavailable. It is held by ${owner}. Quit the program holding this port, then open ThroughLine again. ThroughLine will not switch to another port.`;
}

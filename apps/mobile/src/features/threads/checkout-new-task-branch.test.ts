import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { EnvironmentId } from "@t3tools/contracts";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { checkoutNewTaskBranch } from "./checkout-new-task-branch";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
let directory: string;
let cwd: string;
let gitEnvironment: NodeJS.ProcessEnv;
const exec = (file: string, args: string[]) => execFile(file, args, { env: gitEnvironment });
const git = (...args: string[]) => exec("git", ["-C", cwd, ...args]);
const branch = { name: "feature/a", current: false, isDefault: false, worktreePath: null };
const environmentId = EnvironmentId.make("branch-test-environment");

beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-branch-selection-"));
  const home = NodePath.join(directory, "home");
  const emptyHooks = NodePath.join(directory, "empty-hooks");
  const emptyTemplate = NodePath.join(directory, "empty-template");
  const emptyConfig = NodePath.join(directory, "empty.gitconfig");
  await Promise.all([home, emptyHooks, emptyTemplate].map((path) => NodeFSP.mkdir(path)));
  await NodeFSP.writeFile(emptyConfig, "");
  // A fixture commit must never invoke the user's signer, hooks or credential helpers.
  gitEnvironment = {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TEMPLATE_DIR: emptyTemplate,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: emptyHooks,
  };
  cwd = NodePath.join(directory, "project");
  await exec("git", ["init", "-b", "main", cwd]);
  await git("config", "user.name", "Branch test");
  await git("config", "user.email", "branch-test@example.com");
  await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "main\n");
  await git("add", ".");
  await git("commit", "-m", "main");
  await git("checkout", "-b", branch.name);
  await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "feature\n");
  await git("commit", "-am", "feature");
  await git("checkout", "main");
});

afterEach(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

function selectBranch(switchRef: Parameters<typeof checkoutNewTaskBranch>[0]["switchRef"]) {
  return checkoutNewTaskBranch({
    branch,
    project: { environmentId, workspaceRoot: cwd },
    workspaceMode: "local",
    switchRef,
  });
}

const switchRef: Parameters<typeof checkoutNewTaskBranch>[0]["switchRef"] = (request) =>
  settlePromise(async () => {
    expect(request.environmentId).toBe(environmentId);
    await exec("git", ["-C", request.input.cwd, "checkout", request.input.refName]);
    const { stdout } = await exec("git", ["-C", request.input.cwd, "branch", "--show-current"]);
    return { refName: stdout.trim() };
  });

describe("new-task branch checkout", () => {
  it("keeps fixture Git signing and hooks independent of the user's configuration", async () => {
    expect((await git("config", "--get", "commit.gpgsign")).stdout.trim()).toBe("false");
    expect((await git("config", "--get", "core.hooksPath")).stdout.trim()).toBe(
      NodePath.join(directory, "empty-hooks"),
    );
    expect((await git("config", "--global", "--list")).stdout).toBe("");
  });
  it("switches main to the older thread's feature branch before returning a selection", async () => {
    const result = await selectBranch(switchRef);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Checkout failed");
    expect(result.value.name).toBe("feature/a");
    expect(result.value.current).toBe(true);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("feature/a");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe("feature\n");
  });

  it("does not release the selection while checkout is still pending", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let completed = false;
    const selection = selectBranch(async (request) => {
      entered.resolve();
      await release.promise;
      return switchRef(request);
    }).then((result) => {
      completed = true;
      return result;
    });
    await entered.promise;
    expect(completed).toBe(false);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    release.resolve();
    expect((await selection)._tag).toBe("Success");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("feature/a");
  });

  it("returns checkout failure without selecting the branch or losing dirty files", async () => {
    await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "unsaved local changes\n");
    const result = await selectBranch(switchRef);
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected checkout to fail");
    expect(String(squashAtomCommandFailure(result))).toContain("would be overwritten");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "file.txt"), "utf8")).toBe(
      "unsaved local changes\n",
    );
  });

  it("fails when the source project is unavailable instead of releasing a composer selection", async () => {
    const result = await checkoutNewTaskBranch({
      branch,
      project: null,
      workspaceMode: "local",
      switchRef: () => {
        throw new Error("An unavailable project must not run checkout");
      },
    });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected an unavailable-project failure");
    expect(String(squashAtomCommandFailure(result))).toContain("selected project is unavailable");
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
  });

  it("reuses an existing worktree without switching the project checkout", async () => {
    const worktreePath = NodePath.join(directory, "worktree");
    await git("worktree", "add", worktreePath, "feature/a");
    const result = await checkoutNewTaskBranch({
      branch: { ...branch, worktreePath },
      project: { environmentId, workspaceRoot: cwd },
      workspaceMode: "local",
      switchRef: () => {
        throw new Error("Existing worktrees must not switch the project checkout");
      },
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") throw new Error("Worktree selection failed");
    expect(result.value.worktreePath).toBe(worktreePath);
    expect((await git("branch", "--show-current")).stdout.trim()).toBe("main");
    expect(await NodeFSP.readFile(NodePath.join(worktreePath, "file.txt"), "utf8")).toBe(
      "feature\n",
    );
  });
});

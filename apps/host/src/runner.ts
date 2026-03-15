import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import type {
  DumplErrorEvent,
  DumplEvent,
  PermissionMode,
} from "../../../packages/core/src";
import type { HostSandboxConfig } from "./runtime-config";

export type RunnerPolicy = {
  workspace: string;
  skill: string;
  toolAllowlist: string[];
  bashCommandPrefixAllowlist: string[];
  permissionMode: PermissionMode;
};

export type RunnerInput = {
  prompt: string;
  workspace?: string;
  skill?: string;
  toolAllowlist: string[];
  policy: RunnerPolicy;
};

export type RunnerLaunchOptions = {
  sandbox: HostSandboxConfig;
  workspacePath: string;
  attachedRepoPaths?: string[];
};

export type RunnerControlHooks = {
  onCancelReady?: (cancel: () => void) => void;
  onSettled?: () => void;
};

const DEFAULT_MAX_RUN_SECONDS = 180;

const KNOWN_EVENT_TYPES = new Set([
  "status",
  "stt",
  "token",
  "tool",
  "done",
  "error",
]);

const runnerEntryPoint = (): string => {
  const overriddenEntryPoint = process.env.DUMPLBOT_RUNNER_ENTRYPOINT?.trim();

  if (overriddenEntryPoint) {
    return resolve(overriddenEntryPoint);
  }

  return resolve(__dirname, "../../agent-runner/src/main.js");
};

const buildDirectRunnerCommand = (): string[] => [
  process.execPath,
  runnerEntryPoint(),
];

const OPTIONAL_BWRAP_READONLY_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
const OPTIONAL_BWRAP_READONLY_FILES = ["/etc/ld.so.cache"];

const pathHasPrefix = (candidatePath: string, prefixPath: string): boolean =>
  candidatePath === prefixPath || candidatePath.startsWith(`${prefixPath}/`);

const appendReadonlyBind = (
  args: string[],
  hostPath: string,
  optional = false,
): void => {
  args.push(optional ? "--ro-bind-try" : "--ro-bind", hostPath, hostPath);
};

const buildBwrapRunnerCommand = (
  workspacePath: string,
  attachedRepoPaths: string[],
): string[] => {
  const resolvedNodeBinaryPath = realpathSync(process.execPath);
  const resolvedRunnerEntryPoint = realpathSync(runnerEntryPoint());
  const resolvedAttachedRepoPaths = Array.from(new Set(attachedRepoPaths.map((repoPath) =>
    realpathSync(repoPath),
  )));
  const args = [
    "bwrap",
    "--die-with-parent",
    "--unshare-net",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];

  for (const readonlyPath of OPTIONAL_BWRAP_READONLY_PATHS) {
    appendReadonlyBind(args, readonlyPath, true);
  }

  for (const readonlyFile of OPTIONAL_BWRAP_READONLY_FILES) {
    appendReadonlyBind(args, readonlyFile, true);
  }

  if (!OPTIONAL_BWRAP_READONLY_PATHS.some((readonlyPath) =>
    pathHasPrefix(resolvedNodeBinaryPath, readonlyPath))) {
    appendReadonlyBind(args, resolvedNodeBinaryPath);
  }

  appendReadonlyBind(args, resolvedRunnerEntryPoint);
  args.push("--bind", workspacePath, workspacePath);

  for (const attachedRepoPath of resolvedAttachedRepoPaths) {
    args.push("--bind", attachedRepoPath, attachedRepoPath);
  }

  args.push(resolvedNodeBinaryPath, resolvedRunnerEntryPoint);

  return args;
};

export const buildRunnerLaunchCommand = (
  options: RunnerLaunchOptions,
): string[] => {
  if (!options.sandbox.enabled) {
    return buildDirectRunnerCommand();
  }

  if (options.sandbox.backend !== "bwrap") {
    throw new Error("sandbox backend is unsupported");
  }

  return buildBwrapRunnerCommand(options.workspacePath, options.attachedRepoPaths ?? []);
};

const toErrorEvent = (message: string): DumplErrorEvent => ({
  type: "error",
  message,
});

const parseRunnerEvent = (line: string): DumplEvent => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("runner emitted invalid JSON");
  }

  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    throw new Error("runner event missing type");
  }

  const event = parsed as DumplEvent;

  if (!KNOWN_EVENT_TYPES.has(event.type)) {
    throw new Error(`runner event type is unsupported: ${event.type}`);
  }

  return event;
};

export async function* streamRunnerEvents(
  input: RunnerInput,
  launchOptions?: RunnerLaunchOptions,
  maxRunSeconds = DEFAULT_MAX_RUN_SECONDS,
  controlHooks?: RunnerControlHooks,
): AsyncGenerator<DumplEvent> {
  const resolvedLaunchOptions = launchOptions ?? {
    sandbox: { enabled: false, backend: "bwrap" as const },
    workspacePath: process.cwd(),
    attachedRepoPaths: [],
  };
  const resolvedMaxRunSeconds = Number.isFinite(maxRunSeconds) && maxRunSeconds > 0
    ? Math.floor(maxRunSeconds)
    : DEFAULT_MAX_RUN_SECONDS;
  const [runnerCommand, ...runnerArgs] = buildRunnerLaunchCommand(resolvedLaunchOptions);
  const child = spawn(runnerCommand, runnerArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: resolvedLaunchOptions.workspacePath,
  });
  const stdout = createInterface({
    input: child.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const stderr = createInterface({
    input: child.stderr,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let childErrorMessage: string | null = null;
  const stderrLines: string[] = [];
  let sawRunnerErrorEvent = false;
  let timedOut = false;
  let cancelRequested = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let settled = false;
  const settle = (): void => {
    if (settled) {
      return;
    }

    settled = true;
    controlHooks?.onSettled?.();
  };
  const requestChildStop = (reason: "cancel" | "timeout"): void => {
    if (child.exitCode !== null) {
      return;
    }

    if (reason === "cancel") {
      cancelRequested = true;
    } else {
      timedOut = true;
    }

    child.kill("SIGTERM");

    if (!forceKillTimer) {
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1000);
      forceKillTimer.unref();
    }
  };
  const runTimeout = setTimeout(() => {
    requestChildStop("timeout");
  }, resolvedMaxRunSeconds * 1000);
  runTimeout.unref();
  child.once("close", settle);
  controlHooks?.onCancelReady?.(() => {
    requestChildStop("cancel");
  });

  child.on("error", (error) => {
    childErrorMessage = error.message;
  });

  stderr.on("line", (line) => {
    const trimmed = line.trim();

    if (trimmed.length > 0) {
      stderrLines.push(trimmed);
    }
  });

  child.stdin.end(JSON.stringify(input));

  try {
    for await (const line of stdout) {
      const trimmed = line.trim();

      if (trimmed.length === 0) {
        continue;
      }

      try {
        const event = parseRunnerEvent(trimmed);

        if (event.type === "error") {
          sawRunnerErrorEvent = true;
        }

        yield event;
      } catch (error) {
        child.kill();
        clearTimeout(runTimeout);

        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }

        if (cancelRequested) {
          yield toErrorEvent("run canceled");
          return;
        }

        const message = error instanceof Error ? error.message : "runner stream failed";
        yield toErrorEvent(message);
        return;
      }
    }
  } finally {
    stdout.close();
    stderr.close();
  }

  const [exitCode, signal] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  clearTimeout(runTimeout);

  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
  }

  if (childErrorMessage) {
    yield toErrorEvent(childErrorMessage);
    return;
  }

  if (timedOut) {
    yield toErrorEvent(`runner timed out after ${resolvedMaxRunSeconds}s`);
    return;
  }

  if (cancelRequested) {
    yield toErrorEvent("run canceled");
    return;
  }

  if (signal) {
    yield toErrorEvent(`runner exited from signal ${signal}`);
    return;
  }

  if (exitCode && exitCode !== 0) {
    if (sawRunnerErrorEvent) {
      return;
    }

    const detail =
      stderrLines.length > 0 ? `: ${stderrLines.join(" | ")}` : "";
    yield toErrorEvent(`runner exited with code ${exitCode}${detail}`);
  }
}

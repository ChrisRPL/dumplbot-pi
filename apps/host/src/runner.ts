import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import type {
  DumplErrorEvent,
  DumplEvent,
  PermissionMode,
} from "../../../packages/core/src";

export type RunnerPolicy = {
  workspace: string;
  skill: string;
  toolAllowlist: string[];
  permissionMode: PermissionMode;
};

export type RunnerInput = {
  prompt: string;
  workspace?: string;
  skill?: string;
  toolAllowlist: string[];
  policy: RunnerPolicy;
};

const KNOWN_EVENT_TYPES = new Set([
  "status",
  "stt",
  "token",
  "tool",
  "done",
  "error",
]);

const runnerEntryPoint = (): string =>
  resolve(__dirname, "../../agent-runner/src/main.js");

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
): AsyncGenerator<DumplEvent> {
  const child = spawn(process.execPath, [runnerEntryPoint()], {
    stdio: ["pipe", "pipe", "pipe"],
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
        yield parseRunnerEvent(trimmed);
      } catch (error) {
        child.kill();
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

  if (childErrorMessage) {
    yield toErrorEvent(childErrorMessage);
    return;
  }

  if (signal) {
    yield toErrorEvent(`runner exited from signal ${signal}`);
    return;
  }

  if (exitCode && exitCode !== 0) {
    const detail =
      stderrLines.length > 0 ? `: ${stderrLines.join(" | ")}` : "";
    yield toErrorEvent(`runner exited with code ${exitCode}${detail}`);
  }
}

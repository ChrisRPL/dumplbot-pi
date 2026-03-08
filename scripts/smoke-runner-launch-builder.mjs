#!/usr/bin/env node

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRunnerLaunchCommand } from "../dist/apps/host/src/runner.js";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const hasArgumentSequence = (command, expectedSequence) =>
  command.some((_, index) =>
    expectedSequence.every((expectedValue, sequenceIndex) =>
      command[index + sequenceIndex] === expectedValue),
  );

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-runner-launch-builder-"));
  const workspacePath = join(tmpRoot, "workspace");
  const attachedRepoPath = join(tmpRoot, "attached-repo");

  await mkdir(workspacePath, { recursive: true });
  await mkdir(attachedRepoPath, { recursive: true });
  const resolvedAttachedRepoPath = await realpath(attachedRepoPath);

  try {
    const directCommand = buildRunnerLaunchCommand({
      sandbox: { enabled: false, backend: "bwrap" },
      workspacePath,
    });

    assert(directCommand.length === 2, "expected direct command with node and runner entrypoint");
    assert(
      directCommand[0].includes("node"),
      "expected direct command to start with node binary",
    );
    assert(
      directCommand[1].endsWith("/dist/apps/agent-runner/src/main.js"),
      "expected direct command to include runner entrypoint",
    );

    const sandboxedCommand = buildRunnerLaunchCommand({
      sandbox: { enabled: true, backend: "bwrap" },
      workspacePath,
      attachedRepoPaths: [attachedRepoPath],
    });

    assert(sandboxedCommand[0] === "bwrap", "expected sandboxed command to start with bwrap");
    assert(
      sandboxedCommand.includes("--unshare-net"),
      "expected sandboxed command to disable network access",
    );
    assert(
      hasArgumentSequence(sandboxedCommand, ["--tmpfs", "/tmp"]),
      "expected sandboxed command to isolate /tmp",
    );
    assert(
      sandboxedCommand.includes("--bind"),
      "expected sandboxed command to include writable workspace bind",
    );
    assert(
      !hasArgumentSequence(sandboxedCommand, ["--ro-bind", "/", "/"]),
      "expected sandboxed command to avoid binding the whole host root",
    );
    assert(
      sandboxedCommand.includes(workspacePath),
      "expected sandboxed command to include workspace path",
    );
    assert(
      hasArgumentSequence(sandboxedCommand, ["--bind", resolvedAttachedRepoPath, resolvedAttachedRepoPath]),
      "expected sandboxed command to include attached repo bind",
    );
    assert(
      sandboxedCommand.at(-1)?.endsWith("/dist/apps/agent-runner/src/main.js"),
      "expected sandboxed command to include runner entrypoint",
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  console.log("runner launch builder smoke ok");
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

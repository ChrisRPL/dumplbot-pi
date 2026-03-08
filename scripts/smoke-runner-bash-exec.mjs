#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const runSmoke = async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dumplbot-runner-bash-exec-"));
  const fixturePath = join(workspaceRoot, "note.txt");
  const runnerEntryPoint = resolve("dist/apps/agent-runner/src/main.js");

  await writeFile(fixturePath, "hello from bash tool\n", "utf8");

  const child = spawn(
    process.execPath,
    [runnerEntryPoint],
    {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
  });

  const runnerInput = {
    prompt: "bash: cat note.txt",
    workspace: "default",
    skill: "coding",
    toolAllowlist: ["bash"],
    policy: {
      workspace: "default",
      skill: "coding",
      toolAllowlist: ["bash"],
      bashCommandPrefixAllowlist: ["cat"],
      permissionMode: "balanced",
    },
  };

  child.stdin.end(JSON.stringify(runnerInput));

  const exitCode = await new Promise((resolve) => {
    child.once("exit", resolve);
  });

  const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
  const stderrText = Buffer.concat(stderrChunks).toString("utf8");
  const events = stdoutText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  const statusEvent = events.find((event) => event.type === "status");
  const toolEvent = events.find((event) => event.type === "tool");
  const tokenEvent = events.find((event) => event.type === "token");
  const doneEvent = events.find((event) => event.type === "done");
  const errorEvent = events.find((event) => event.type === "error");

  assert(exitCode === 0, "expected runner process to exit with code 0");
  assert(
    statusEvent?.message === "Runner started for default",
    "expected runner started status event",
  );
  assert(toolEvent?.name === "bash", "expected bash tool event");
  assert(toolEvent?.detail === "cat note.txt", "expected bash tool detail");
  assert(
    tokenEvent?.text === "hello from bash tool",
    "expected token event to contain command output",
  );
  assert(doneEvent?.summary === "Bash tool completed.", "expected bash tool done summary");
  assert(!errorEvent, "unexpected error event for bash execution success");
  assert(stderrText.trim().length === 0, "unexpected stderr output for bash execution success");

  await rm(workspaceRoot, { recursive: true, force: true });
  console.log("runner bash exec smoke ok");
};

runSmoke().catch(async (error) => {
  console.error(error.message);
  process.exit(1);
});

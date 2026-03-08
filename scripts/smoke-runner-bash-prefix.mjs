#!/usr/bin/env node

import { spawn } from "node:child_process";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const runSmoke = async () => {
  const child = spawn(
    process.execPath,
    ["dist/apps/agent-runner/src/main.js"],
    { stdio: ["pipe", "pipe", "pipe"] },
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
    prompt: "ping",
    workspace: "default",
    skill: "coding",
    toolAllowlist: ["bash"],
    policy: {
      workspace: "default",
      skill: "coding",
      toolAllowlist: ["bash"],
      bashCommandPrefixAllowlist: [],
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
  const errorEvents = events.filter((event) => event.type === "error");
  const doneEvents = events.filter((event) => event.type === "done");

  assert(exitCode === 1, "expected runner process to exit with code 1");
  assert(errorEvents.length === 1, "expected one runner error event");
  assert(doneEvents.length === 0, "unexpected done event for invalid bash prefix policy");
  assert(
    errorEvents[0].message === "runner bash tool requires command prefix allowlist",
    "unexpected runner error message for missing bash prefix allowlist",
  );
  assert(
    stderrText.includes("runner bash tool requires command prefix allowlist"),
    "expected stderr to include missing bash prefix allowlist message",
  );

  console.log("runner bash prefix smoke ok");
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

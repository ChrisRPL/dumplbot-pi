#!/usr/bin/env node

import { buildRunnerLaunchCommand } from "../dist/apps/host/src/runner.js";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const runSmoke = async () => {
  const workspacePath = "/tmp/dumplbot-smoke-workspace";

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
  });

  assert(sandboxedCommand[0] === "bwrap", "expected sandboxed command to start with bwrap");
  assert(
    sandboxedCommand.includes("--bind"),
    "expected sandboxed command to include writable workspace bind",
  );
  assert(
    sandboxedCommand.includes(workspacePath),
    "expected sandboxed command to include workspace path",
  );
  assert(
    sandboxedCommand.at(-1)?.endsWith("/dist/apps/agent-runner/src/main.js"),
    "expected sandboxed command to include runner entrypoint",
  );

  console.log("runner launch builder smoke ok");
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

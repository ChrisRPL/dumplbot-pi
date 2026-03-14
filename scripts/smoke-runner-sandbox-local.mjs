#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const runScript = (scriptPath) => {
  const result = spawnSync(
    process.execPath,
    [scriptPath],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  assert(result.status === 0, `${scriptPath} failed`);
};

const runSmoke = async () => {
  for (const scriptPath of [
    "scripts/smoke-runner-launch-builder.mjs",
    "scripts/smoke-runner-sandbox-launch.mjs",
    "scripts/smoke-runner-sandbox-fs.mjs",
    "scripts/smoke-runner-sandbox-net.mjs",
  ]) {
    runScript(scriptPath);
  }

  console.log("runner sandbox local smoke ok");
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

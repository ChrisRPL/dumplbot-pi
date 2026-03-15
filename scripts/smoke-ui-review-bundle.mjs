#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const readPngDimensions = async (filePath) => {
  const pngBytes = await readFile(filePath);
  assert(pngBytes.length >= 24, "expected png file to contain header");
  assert(
    pngBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "expected png signature",
  );
  return {
    width: pngBytes.readUInt32BE(16),
    height: pngBytes.readUInt32BE(20),
  };
};

const runSmoke = async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "dumplbot-ui-review-bundle-"));

  try {
    const result = spawnSync(
      "node",
      ["scripts/ui-review-bundle.mjs", "--output-dir", outputDir],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
      },
    );

    if (result.error) {
      throw result.error;
    }

    assert(result.status === 0, "expected ui review bundle to return 0");
    assert(result.stdout.includes("bundle:"), "expected review bundle success output");

    for (const [subdir, fileName] of [
      ["core", "home.png"],
      ["scheduler", "scheduler-summary.png"],
      ["skills", "skill-summary.png"],
      ["workspaces", "workspace-summary.png"],
    ]) {
      const dimensions = await readPngDimensions(join(outputDir, subdir, fileName));
      assert(dimensions.width === 510, `expected ${subdir}/${fileName} width`);
      assert(dimensions.height === 960, `expected ${subdir}/${fileName} height`);
    }

    console.log("ui review bundle smoke ok");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

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
  const outputDir = await mkdtemp(join(tmpdir(), "dumplbot-ui-debug-gallery-"));

  try {
    const result = spawnSync(
      "python3",
      ["apps/ui/dumpl_ui.py", "--preview-debug-gallery", outputDir],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
      },
    );

    if (result.error) {
      throw result.error;
    }

    assert(result.status === 0, "expected preview debug gallery command to return 0");
    assert(result.stdout.includes("Debug gallery saved"), "expected debug gallery success output");

    for (const fileName of [
      "transcript.png",
      "audio.png",
      "error.png",
      "voice-debug.png",
    ]) {
      const dimensions = await readPngDimensions(join(outputDir, fileName));
      assert(dimensions.width === 510, `expected ${fileName} width`);
      assert(dimensions.height === 960, `expected ${fileName} height`);
    }

    console.log("ui debug gallery smoke ok");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

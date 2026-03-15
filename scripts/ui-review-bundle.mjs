#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const DEFAULT_OUTPUT_DIR = "/tmp/dumplbot-ui-review";
const DEFAULT_PREVIEW_SCALE = 3;

const usage = () => {
  console.log(
    [
      "Usage: node scripts/ui-review-bundle.mjs [options]",
      "",
      "Options:",
      `  --output-dir <dir>     Bundle output root (default: ${DEFAULT_OUTPUT_DIR})`,
      `  --preview-scale <n>    Snapshot scale (default: ${DEFAULT_PREVIEW_SCALE})`,
      "  --help                 Show this message",
    ].join("\n"),
  );
};

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const parseArgs = (argv) => {
  const options = {
    outputDir: DEFAULT_OUTPUT_DIR,
    previewScale: DEFAULT_PREVIEW_SCALE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help") {
      usage();
      process.exit(0);
    }

    if (value === "--output-dir") {
      options.outputDir = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (value === "--preview-scale") {
      options.previewScale = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }

    throw new Error(`unknown option: ${value}`);
  }

  if (!options.outputDir) {
    throw new Error("--output-dir is required");
  }

  if (!Number.isInteger(options.previewScale) || options.previewScale < 1) {
    throw new Error("--preview-scale must be an integer >= 1");
  }

  return options;
};

const runPythonUi = (args) => {
  const result = spawnSync(
    "python3",
    ["apps/ui/dumpl_ui.py", ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    },
  );

  if (result.error) {
    throw result.error;
  }

  assert(result.status === 0, `python ui command failed: ${args.join(" ")}`);
  return result.stdout;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const outputRoot = options.outputDir;

  await mkdir(outputRoot, { recursive: true });

  const galleryRuns = [
    ["core", "--preview-core-gallery"],
    ["scheduler", "--preview-scheduler-gallery"],
    ["skills", "--preview-skill-gallery"],
    ["workspaces", "--preview-workspace-gallery"],
  ];

  for (const [subdir, flag] of galleryRuns) {
    const destination = `${outputRoot}/${subdir}`;
    const output = runPythonUi([flag, destination, "--preview-scale", String(options.previewScale)]);
    process.stdout.write(output);
  }

  console.log(`bundle: ${outputRoot}`);
  console.log("folders:");
  console.log(`- ${outputRoot}/core`);
  console.log(`- ${outputRoot}/scheduler`);
  console.log(`- ${outputRoot}/skills`);
  console.log(`- ${outputRoot}/workspaces`);
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

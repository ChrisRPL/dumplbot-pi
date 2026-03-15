#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const DEFAULT_HOST_URL = "http://127.0.0.1:4123";
const DEFAULT_OUTPUT_DIR = "/tmp/dumplbot-mac-preview";
const DEFAULT_PRESET = "error";
const DEFAULT_PREVIEW_SCALE = 3;

const usage = () => {
  console.log(
    [
      "Usage: node scripts/mac-preview-walkthrough.mjs [options]",
      "",
      "Options:",
      `  --host-url <url>         Host base URL (default: ${DEFAULT_HOST_URL})`,
      `  --output-dir <dir>       Gallery output directory (default: ${DEFAULT_OUTPUT_DIR})`,
      `  --seed <success|error>   Debug seed preset (default: ${DEFAULT_PRESET})`,
      `  --preview-scale <n>      Live preview scale (default: ${DEFAULT_PREVIEW_SCALE})`,
      "  --live                   Launch the live desktop preview after the gallery pass",
      "  --help                   Show this message",
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
    hostUrl: DEFAULT_HOST_URL,
    outputDir: DEFAULT_OUTPUT_DIR,
    seed: DEFAULT_PRESET,
    previewScale: DEFAULT_PREVIEW_SCALE,
    live: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help") {
      usage();
      process.exit(0);
    }

    if (value === "--live") {
      options.live = true;
      continue;
    }

    if (value === "--host-url") {
      options.hostUrl = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (value === "--output-dir") {
      options.outputDir = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (value === "--seed") {
      options.seed = argv[index + 1] ?? "";
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

  if (!["success", "error"].includes(options.seed)) {
    throw new Error("--seed must be success or error");
  }

  if (!Number.isInteger(options.previewScale) || options.previewScale < 1) {
    throw new Error("--preview-scale must be an integer >= 1");
  }

  if (!options.hostUrl) {
    throw new Error("--host-url is required");
  }

  if (!options.outputDir) {
    throw new Error("--output-dir is required");
  }

  return options;
};

const ensureHostReady = async (hostUrl) => {
  const response = await fetch(`${hostUrl}/health`);
  assert(response.status === 200, `expected ${hostUrl}/health to return 200`);
};

const runPythonUi = (args) => {
  const result = spawnSync(
    "python3",
    ["apps/ui/dumpl_ui.py", ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  assert(result.status === 0, `python ui command failed: ${args.join(" ")}`);
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  await ensureHostReady(options.hostUrl);

  runPythonUi([
    "--host-url",
    options.hostUrl,
    "--preview-gallery",
    options.outputDir,
    "--seed-debug-state",
    options.seed,
  ]);

  console.log(`gallery: ${options.outputDir}`);
  console.log(
    `live: python3 apps/ui/dumpl_ui.py --host-url ${options.hostUrl} --preview --preview-scale ${options.previewScale} --home-button-mode`,
  );

  if (!options.live) {
    return;
  }

  runPythonUi([
    "--host-url",
    options.hostUrl,
    "--preview",
    "--preview-scale",
    String(options.previewScale),
    "--home-button-mode",
  ]);
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadSttRuntimeConfig } = require("../dist/apps/host/src/stt-config.js");

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-setup-secrets-runtime-"));
  const configPath = join(tmpRoot, "config.yaml");
  const secretsPath = join(tmpRoot, "secrets.env");

  await writeFile(
    configPath,
    [
      "stt:",
      "  model: whisper-1",
      "  language: auto",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    secretsPath,
    [
      "OPENAI_API_KEY=runtime-openai-key",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousSecretsPath = process.env.DUMPLBOT_SECRETS_PATH;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.DUMPLBOT_SECRETS_PATH = secretsPath;
  process.env.OPENAI_API_KEY = "stale-env-openai-key";

  try {
    const config = await loadSttRuntimeConfig(configPath);
    assert(config.apiKey === "runtime-openai-key", "expected STT config to prefer current secrets file");
    console.log("setup secrets runtime smoke ok");
  } finally {
    if (typeof previousSecretsPath === "string") {
      process.env.DUMPLBOT_SECRETS_PATH = previousSecretsPath;
    } else {
      delete process.env.DUMPLBOT_SECRETS_PATH;
    }

    if (typeof previousOpenAiKey === "string") {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

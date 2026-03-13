#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4138;

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const waitForServerReady = (childProcess) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("host server did not start in time"));
    }, 8000);

    const onData = (chunk) => {
      const text = chunk.toString("utf8");

      if (text.includes("dumplbotd listening")) {
        clearTimeout(timeout);
        childProcess.stdout.off("data", onData);
        resolve();
      }
    };

    childProcess.stdout.on("data", onData);
    childProcess.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`host server exited early: ${code ?? "unknown"}`));
    });
  });

const startHostServer = async (tmpRoot, workspaceRoot, configPath, secretsPath) => {
  const childProcess = spawn(
    process.execPath,
    ["dist/apps/host/src/main.js"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DUMPLBOT_HOST: HOST,
        DUMPLBOT_PORT: String(HOST_PORT),
        DUMPLBOT_TMP_ROOT: tmpRoot,
        DUMPLBOT_WORKSPACES_ROOT: workspaceRoot,
        DUMPLBOT_CONFIG_PATH: configPath,
        DUMPLBOT_SECRETS_PATH: secretsPath,
        DUMPLBOT_SANDBOX_ENABLED: "false",
      },
    },
  );

  await waitForServerReady(childProcess);
  return childProcess;
};

const stopHostServer = async (childProcess) => {
  if (childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill("SIGINT");
  await new Promise((resolve) => {
    childProcess.once("exit", resolve);
    setTimeout(() => resolve(), 3000);
  });
};

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-setup-page-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const configPath = join(tmpRoot, "config.yaml");
  const secretsPath = join(tmpRoot, "secrets.env");
  const defaultWorkspacePath = join(workspaceRoot, "default");
  const alphaWorkspacePath = join(workspaceRoot, "alpha");

  await mkdir(defaultWorkspacePath, { recursive: true });
  await mkdir(alphaWorkspacePath, { recursive: true });
  await writeFile(join(defaultWorkspacePath, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(join(alphaWorkspacePath, "CLAUDE.md"), "# alpha\n", "utf8");
  await writeFile(
    configPath,
    [
      "runtime:",
      "  default_workspace: default",
      "  default_skill: coding",
      "  permission_mode: balanced",
      "",
      "sandbox:",
      "  enabled: true",
      "  backend: bwrap",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    secretsPath,
    [
      "OPENAI_API_KEY=test-openai-key",
      "",
    ].join("\n"),
    "utf8",
  );

  const hostServer = await startHostServer(tmpRoot, workspaceRoot, configPath, secretsPath);
  const baseUrl = `http://${HOST}:${HOST_PORT}`;

  try {
    const setupPageResponse = await fetch(`${baseUrl}/setup`);
    assert(setupPageResponse.status === 200, "expected GET /setup to return 200");
    assert(
      (setupPageResponse.headers.get("content-type") || "").includes("text/html"),
      "expected GET /setup to return html",
    );
    const setupPageHtml = await setupPageResponse.text();
    assert(setupPageHtml.includes("DumplBot Setup"), "expected setup page title");
    assert(setupPageHtml.includes("default-workspace"), "expected setup workspace field");
    assert(setupPageHtml.includes("default-skill"), "expected setup skill field");
    assert(setupPageHtml.includes("safety-mode"), "expected setup safety field");
    assert(setupPageHtml.includes("/api/config"), "expected setup page to use config api");
    assert(setupPageHtml.includes("/api/setup/status"), "expected setup page to use setup status api");
    assert(setupPageHtml.includes("OpenAI key"), "expected setup page to show OpenAI key status");

    const setupStatusResponse = await fetch(`${baseUrl}/api/setup/status`);
    assert(setupStatusResponse.status === 200, "expected GET /api/setup/status to return 200");
    const setupStatusPayload = await setupStatusResponse.json();
    assert(setupStatusPayload.secrets.secrets_file_present === true, "expected setup secrets file presence");
    assert(setupStatusPayload.secrets.openai_api_key_configured === true, "expected OpenAI key presence");
    assert(setupStatusPayload.secrets.anthropic_api_key_configured === false, "expected Anthropic key absence");

    const setupSecretsUpdateResponse = await fetch(`${baseUrl}/api/setup/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic_api_key: "test-anthropic-key",
      }),
    });
    assert(setupSecretsUpdateResponse.status === 200, "expected setup secret update to return 200");
    const setupSecretsUpdatePayload = await setupSecretsUpdateResponse.json();
    assert(setupSecretsUpdatePayload.secrets.openai_api_key_configured === true, "expected OpenAI key status to remain configured");
    assert(setupSecretsUpdatePayload.secrets.anthropic_api_key_configured === true, "expected Anthropic key status to become configured");

    const writtenSecrets = await readFile(secretsPath, "utf8");
    assert(writtenSecrets.includes("OPENAI_API_KEY=test-openai-key"), "expected written OpenAI key");
    assert(writtenSecrets.includes("ANTHROPIC_API_KEY=test-anthropic-key"), "expected written Anthropic key");

    const invalidSecretsUpdateResponse = await fetch(`${baseUrl}/api/setup/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert(invalidSecretsUpdateResponse.status === 400, "expected empty setup secret update to return 400");

    const initialConfigResponse = await fetch(`${baseUrl}/api/config`);
    assert(initialConfigResponse.status === 200, "expected GET /api/config to return 200");
    const initialConfigPayload = await initialConfigResponse.json();
    assert(initialConfigPayload.runtime.default_workspace === "default", "unexpected initial default workspace");
    assert(initialConfigPayload.runtime.default_skill === "coding", "unexpected initial default skill");
    assert(initialConfigPayload.runtime.safety_mode === "balanced", "unexpected initial safety mode");

    const configExportResponse = await fetch(`${baseUrl}/api/config/export`);
    assert(configExportResponse.status === 200, "expected GET /api/config/export to return 200");
    const configExportPayload = await configExportResponse.json();
    assert(configExportPayload.config.includes("default_workspace: default"), "expected config export default workspace");
    assert(configExportPayload.config.includes("default_skill: coding"), "expected config export default skill");

    const setupSaveResponse = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime: {
          default_workspace: "alpha",
          default_skill: "research",
          safety_mode: "strict",
        },
      }),
    });
    assert(setupSaveResponse.status === 200, "expected setup save to return 200");
    const setupSavePayload = await setupSaveResponse.json();
    assert(setupSavePayload.runtime.default_workspace === "alpha", "expected updated default workspace");
    assert(setupSavePayload.runtime.default_skill === "research", "expected updated default skill");
    assert(setupSavePayload.runtime.safety_mode === "strict", "expected updated safety mode");

    const writtenConfig = await readFile(configPath, "utf8");
    assert(writtenConfig.includes("default_workspace: alpha"), "expected written config default workspace");
    assert(writtenConfig.includes("default_skill: research"), "expected written config default skill");
    assert(writtenConfig.includes("permission_mode: strict"), "expected written config safety mode");

    const invalidSafetyResponse = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime: {
          safety_mode: "dangerous",
        },
      }),
    });
    assert(invalidSafetyResponse.status === 400, "expected invalid safety mode to return 400");

    const configImportResponse = await fetch(`${baseUrl}/api/config/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: [
          "runtime:",
          "  default_workspace: default",
          "  default_skill: research",
          "  permission_mode: permissive",
          "  max_run_seconds: 240",
          "",
          "sandbox:",
          "  enabled: true",
          "  backend: bwrap",
          "",
        ].join("\n"),
      }),
    });
    assert(configImportResponse.status === 200, "expected config import to return 200");
    const configImportPayload = await configImportResponse.json();
    assert(configImportPayload.runtime.default_workspace === "default", "expected imported default workspace");
    assert(configImportPayload.runtime.default_skill === "research", "expected imported default skill");
    assert(configImportPayload.runtime.safety_mode === "permissive", "expected imported safety mode");

    const importedConfig = await readFile(configPath, "utf8");
    assert(importedConfig.includes("default_skill: research"), "expected imported config default skill");
    assert(importedConfig.includes("permission_mode: permissive"), "expected imported config safety mode");
    assert(importedConfig.includes("max_run_seconds: 240"), "expected imported config max run seconds");

    const invalidImportResponse = await fetch(`${baseUrl}/api/config/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: [
          "runtime:",
          "  default_workspace: default",
          "  default_skill: research",
          "  permission_mode: unsafe",
          "",
        ].join("\n"),
      }),
    });
    assert(invalidImportResponse.status === 400, "expected invalid config import to return 400");

    console.log("setup page smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4135;
const SSE_DELIMITER = "\n\n";
const WAVE_BYTES = Buffer.from("RIFFtestWAVEfmt ");

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const parseSsePayload = (payload) =>
  payload
    .split(SSE_DELIMITER)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      let eventType = "message";
      let data = {};

      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
          data = JSON.parse(line.slice("data: ".length));
        }
      }

      return { eventType, data };
    });

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

const startHostServer = async (tmpRoot, workspaceRoot, configPath) => {
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
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-workspace-config-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const configPath = join(tmpRoot, "config.yaml");
  const runtimeStatePath = join(tmpRoot, "runtime-state.json");
  const defaultWorkspacePath = join(workspaceRoot, "default");
  const alphaWorkspacePath = join(workspaceRoot, "alpha");

  await mkdir(defaultWorkspacePath, { recursive: true });
  await mkdir(alphaWorkspacePath, { recursive: true });
  await writeFile(join(defaultWorkspacePath, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(join(alphaWorkspacePath, "CLAUDE.md"), "# alpha\n", "utf8");
  await writeFile(
    configPath,
    "runtime:\n  default_workspace: default\n  default_skill: coding\n",
    "utf8",
  );

  const hostServer = await startHostServer(tmpRoot, workspaceRoot, configPath);
  const baseUrl = `http://${HOST}:${HOST_PORT}`;

  try {
    const getConfigResponse = await fetch(`${baseUrl}/api/config`);
    assert(getConfigResponse.status === 200, "expected GET /api/config to return 200");
    const getConfigPayload = await getConfigResponse.json();
    assert(
      getConfigPayload.runtime.default_workspace === "default",
      "unexpected default workspace from /api/config",
    );
    assert(
      getConfigPayload.runtime.default_skill === "coding",
      "unexpected default skill from /api/config",
    );
    assert(
      getConfigPayload.runtime.active_workspace === null,
      "unexpected initial active workspace from /api/config",
    );
    assert(
      getConfigPayload.runtime.active_skill === null,
      "unexpected initial active skill from /api/config",
    );

    const skillListResponse = await fetch(`${baseUrl}/api/skills`);
    assert(skillListResponse.status === 200, "expected GET /api/skills to return 200");
    const skillListPayload = await skillListResponse.json();
    const codingSkill = skillListPayload.skills.find((skill) => skill.id === "coding");
    const researchSkill = skillListPayload.skills.find((skill) => skill.id === "research");
    assert(codingSkill, "expected coding skill in /api/skills");
    assert(researchSkill, "expected research skill in /api/skills");

    const initialListResponse = await fetch(`${baseUrl}/api/workspaces`);
    assert(initialListResponse.status === 200, "expected GET /api/workspaces to return 200");
    const initialListPayload = await initialListResponse.json();
    const initialDefaultWorkspace = initialListPayload.workspaces.find(
      (workspace) => workspace.id === "default",
    );
    assert(initialDefaultWorkspace?.is_active, "default should be active before update");

    const setActiveResponse = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: { active_workspace: "alpha" } }),
    });
    assert(setActiveResponse.status === 200, "expected POST /api/config set active to return 200");
    const setActivePayload = await setActiveResponse.json();
    assert(
      setActivePayload.runtime.active_workspace === "alpha",
      "active workspace was not stored",
    );

    const updatedListResponse = await fetch(`${baseUrl}/api/workspaces`);
    assert(updatedListResponse.status === 200, "expected updated workspace list to return 200");
    const updatedListPayload = await updatedListResponse.json();
    const updatedAlphaWorkspace = updatedListPayload.workspaces.find(
      (workspace) => workspace.id === "alpha",
    );
    assert(updatedAlphaWorkspace?.is_active, "alpha should be active after update");

    const talkWithActiveResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping" }),
    });
    assert(talkWithActiveResponse.status === 200, "expected /api/talk to return 200");
    const talkWithActiveEvents = parseSsePayload(await talkWithActiveResponse.text());
    const activeStatusEvent = talkWithActiveEvents.find((event) => event.eventType === "status");
    const activeToolEvent = talkWithActiveEvents.find((event) => event.eventType === "tool");
    assert(
      activeStatusEvent?.data?.message === "Runner started for alpha",
      "talk did not use active workspace",
    );
    assert(
      activeToolEvent?.data?.detail === "coding",
      "talk did not use default skill",
    );

    const talkWithOverrideResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping", workspace: "default", skill: "research" }),
    });
    assert(
      talkWithOverrideResponse.status === 200,
      "expected /api/talk override to return 200",
    );
    const talkWithOverrideEvents = parseSsePayload(await talkWithOverrideResponse.text());
    const overrideStatusEvent = talkWithOverrideEvents.find(
      (event) => event.eventType === "status",
    );
    const overrideToolEvent = talkWithOverrideEvents.find(
      (event) => event.eventType === "tool",
    );
    assert(
      overrideStatusEvent?.data?.message === "Runner started for default",
      "talk override did not use requested workspace",
    );
    assert(
      overrideToolEvent?.data?.detail === "research",
      "talk override did not use requested skill",
    );

    const talkWithMissingSkillResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping", skill: "missing-skill" }),
    });
    assert(
      talkWithMissingSkillResponse.status === 404,
      "expected /api/talk missing skill to return 404",
    );

    const setActiveSkillResponse = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: { active_skill: "research" } }),
    });
    assert(
      setActiveSkillResponse.status === 200,
      "expected active skill update to return 200",
    );
    const setActiveSkillPayload = await setActiveSkillResponse.json();
    assert(
      setActiveSkillPayload.runtime.active_skill === "research",
      "active skill was not stored",
    );

    const talkWithActiveSkillResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping" }),
    });
    assert(
      talkWithActiveSkillResponse.status === 200,
      "expected /api/talk with active skill to return 200",
    );
    const talkWithActiveSkillEvents = parseSsePayload(await talkWithActiveSkillResponse.text());
    const activeSkillToolEvent = talkWithActiveSkillEvents.find(
      (event) => event.eventType === "tool",
    );
    assert(
      activeSkillToolEvent?.data?.detail === "research",
      "talk did not use active skill fallback",
    );

    const deniedToolTalkResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "ping",
        skill: "coding",
        tools: ["web_fetch"],
      }),
    });
    assert(
      deniedToolTalkResponse.status === 403,
      "expected talk with denied tools to return 403",
    );

    const invalidToolTalkResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "ping",
        tools: [],
      }),
    });
    assert(
      invalidToolTalkResponse.status === 400,
      "expected talk with invalid tools to return 400",
    );

    const allowedToolTalkResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "ping",
        skill: "coding",
        tools: ["read_file"],
      }),
    });
    assert(
      allowedToolTalkResponse.status === 200,
      "expected talk with allowed tools to return 200",
    );

    const setMissingWorkspaceResponse = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: { active_workspace: "missing" } }),
    });
    assert(
      setMissingWorkspaceResponse.status === 404,
      "expected missing active workspace update to return 404",
    );

    const missingFieldResponse = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: {} }),
    });
    assert(
      missingFieldResponse.status === 400,
      "expected missing active_workspace field to return 400",
    );

    const clearActiveResponse = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtime: { active_workspace: null, active_skill: null } }),
    });
    assert(clearActiveResponse.status === 200, "expected active workspace clear to return 200");
    const clearActivePayload = await clearActiveResponse.json();
    assert(
      clearActivePayload.runtime.active_workspace === null,
      "active workspace clear did not persist",
    );
    assert(
      clearActivePayload.runtime.active_skill === null,
      "active skill clear did not persist",
    );

    const stateFileContents = await readFile(runtimeStatePath, "utf8");
    assert(stateFileContents.trim() === "{}", "runtime state file should be empty after clear");

    const talkAfterClearResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping" }),
    });
    assert(
      talkAfterClearResponse.status === 200,
      "expected /api/talk after clear to return 200",
    );
    const talkAfterClearEvents = parseSsePayload(await talkAfterClearResponse.text());
    const clearedStatusEvent = talkAfterClearEvents.find((event) => event.eventType === "status");
    assert(
      clearedStatusEvent?.data?.message === "Runner started for default",
      "talk did not fall back to default workspace after clear",
    );

    const uploadForm = new FormData();
    uploadForm.append("file", new File([WAVE_BYTES], "sample.wav", { type: "audio/wav" }));
    const uploadResponse = await fetch(`${baseUrl}/api/audio`, {
      method: "POST",
      body: uploadForm,
    });
    assert(uploadResponse.status === 200, "expected /api/audio upload to return 200");
    const uploadPayload = await uploadResponse.json();

    const audioTalkMissingSkillResponse = await fetch(
      `${baseUrl}/api/audio/${uploadPayload.audio_id}/talk`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skill: "missing-skill" }),
      },
    );
    assert(
      audioTalkMissingSkillResponse.status === 404,
      "expected /api/audio/:id/talk missing skill to return 404",
    );

    const audioTalkDeniedToolsResponse = await fetch(
      `${baseUrl}/api/audio/${uploadPayload.audio_id}/talk`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skill: "coding", tools: ["web_fetch"] }),
      },
    );
    assert(
      audioTalkDeniedToolsResponse.status === 403,
      "expected /api/audio/:id/talk denied tools to return 403",
    );

    console.log("workspace config smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

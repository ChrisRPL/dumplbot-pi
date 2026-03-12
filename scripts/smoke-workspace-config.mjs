#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

const runUiCommand = (baseUrl, ...args) => {
  const result = spawnSync(
    "python3",
    ["apps/ui/dumpl_ui.py", "--mock", "--host-url", baseUrl, ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      timeout: 8000,
    },
  );

  if (result.error) {
    throw result.error;
  }

  return result;
};

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-workspace-config-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const configPath = join(tmpRoot, "config.yaml");
  const runtimeStatePath = join(tmpRoot, "runtime-state.json");
  const defaultWorkspacePath = join(workspaceRoot, "default");
  const alphaWorkspacePath = join(workspaceRoot, "alpha");
  const attachedReposRoot = join(tmpRoot, "attached-repos");
  const notesRepoPath = join(attachedReposRoot, "notes");

  await mkdir(defaultWorkspacePath, { recursive: true });
  await mkdir(alphaWorkspacePath, { recursive: true });
  await mkdir(notesRepoPath, { recursive: true });
  await writeFile(join(defaultWorkspacePath, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(join(alphaWorkspacePath, "CLAUDE.md"), "# alpha\n", "utf8");
  await writeFile(join(notesRepoPath, "README.md"), "# notes\n", "utf8");
  const normalizedNotesRepoPath = await realpath(notesRepoPath);
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
    assert(codingSkill.is_active, "expected coding to be active before active_skill update");
    assert(
      Array.isArray(codingSkill.bash_prefix_allowlist) && codingSkill.bash_prefix_allowlist.length > 0,
      "expected coding skill bash_prefix_allowlist metadata",
    );

    const initialListResponse = await fetch(`${baseUrl}/api/workspaces`);
    assert(initialListResponse.status === 200, "expected GET /api/workspaces to return 200");
    const initialListPayload = await initialListResponse.json();
    const initialDefaultWorkspace = initialListPayload.workspaces.find(
      (workspace) => workspace.id === "default",
    );
    assert(initialDefaultWorkspace?.is_active, "default should be active before update");
    assert(initialDefaultWorkspace?.default_skill === null, "workspace default skill should start empty");

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

    const setWorkspaceDefaultSkillResponse = await fetch(`${baseUrl}/api/workspaces/alpha/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default_skill: "research" }),
    });
    assert(
      setWorkspaceDefaultSkillResponse.status === 200,
      "expected workspace default skill update to return 200",
    );
    const setWorkspaceDefaultSkillPayload = await setWorkspaceDefaultSkillResponse.json();
    assert(
      setWorkspaceDefaultSkillPayload.default_skill === "research",
      "workspace default skill was not stored",
    );

    const workspaceListWithDefaultSkillResponse = await fetch(`${baseUrl}/api/workspaces`);
    assert(
      workspaceListWithDefaultSkillResponse.status === 200,
      "expected workspace list after default skill update",
    );
    const workspaceListWithDefaultSkillPayload = await workspaceListWithDefaultSkillResponse.json();
    const alphaWorkspaceWithDefaultSkill = workspaceListWithDefaultSkillPayload.workspaces.find(
      (workspace) => workspace.id === "alpha",
    );
    assert(
      alphaWorkspaceWithDefaultSkill?.default_skill === "research",
      "workspace list did not expose default skill",
    );

    const attachRepoResponse = await fetch(`${baseUrl}/api/workspaces/default/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "notes", path: notesRepoPath }),
    });
    assert(attachRepoResponse.status === 201, "expected workspace repo attach to return 201");
    const attachRepoPayload = await attachRepoResponse.json();
    assert(attachRepoPayload.id === "notes", "unexpected attached repo id");
    assert(attachRepoPayload.path === normalizedNotesRepoPath, "unexpected attached repo path");
    assert(attachRepoPayload.mount_path === "repos/notes", "unexpected attached repo mount path");

    const attachedMountPath = join(defaultWorkspacePath, "repos", "notes");
    const attachedMountStats = await lstat(attachedMountPath);
    assert(attachedMountStats.isSymbolicLink(), "expected attached repo mount to be symlink");
    const attachedMountTarget = await readlink(attachedMountPath);
    assert(attachedMountTarget === normalizedNotesRepoPath, "unexpected attached repo symlink target");

    const listWithRepoResponse = await fetch(`${baseUrl}/api/workspaces`);
    assert(listWithRepoResponse.status === 200, "expected workspace list with repo to return 200");
    const listWithRepoPayload = await listWithRepoResponse.json();
    const defaultWorkspaceWithRepo = listWithRepoPayload.workspaces.find(
      (workspace) => workspace.id === "default",
    );
    const attachedRepo = defaultWorkspaceWithRepo?.attached_repos?.find(
      (repo) => repo.id === "notes",
    );
    assert(attachedRepo, "expected attached repo metadata in workspace list");
    assert(attachedRepo.path === normalizedNotesRepoPath, "workspace list attached repo path mismatch");
    assert(attachedRepo.mount_path === "repos/notes", "workspace list attached repo mount mismatch");

    const duplicateAttachResponse = await fetch(`${baseUrl}/api/workspaces/default/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "notes", path: notesRepoPath }),
    });
    assert(duplicateAttachResponse.status === 409, "expected duplicate repo attach to return 409");

    const talkWithActiveResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping" }),
    });
    assert(talkWithActiveResponse.status === 200, "expected /api/talk to return 200");
    const talkWithActiveEvents = parseSsePayload(await talkWithActiveResponse.text());
    const activeSkillStatusEvent = talkWithActiveEvents.find(
      (event) => event.eventType === "status" && event.data?.message === "Using skill research",
    );
    const activePolicyToolEvent = talkWithActiveEvents.find(
      (event) => event.eventType === "tool" && event.data?.name === "skill-policy",
    );
    const activeRunnerStatusEvent = talkWithActiveEvents.find(
      (event) => event.eventType === "status" && event.data?.message === "Runner started for alpha",
    );
    const activePlannerToolEvent = talkWithActiveEvents.find(
      (event) => event.eventType === "tool" && event.data?.name === "planner",
    );
    assert(
      activeSkillStatusEvent,
      "talk did not emit selected skill status prelude",
    );
    assert(
      activePolicyToolEvent,
      "talk did not emit skill-policy tool prelude",
    );
    assert(
      activeRunnerStatusEvent?.data?.message === "Runner started for alpha",
      "talk did not use active workspace",
    );
    assert(
      activePlannerToolEvent?.data?.detail === "research",
      "talk did not use workspace default skill",
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
    const overrideRunnerStatusEvent = talkWithOverrideEvents.find(
      (event) => event.eventType === "status" && event.data?.message === "Runner started for default",
    );
    const overridePlannerToolEvent = talkWithOverrideEvents.find(
      (event) => event.eventType === "tool" && event.data?.name === "planner",
    );
    assert(
      overrideRunnerStatusEvent?.data?.message === "Runner started for default",
      "talk override did not use requested workspace",
    );
    assert(
      overridePlannerToolEvent?.data?.detail === "research",
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

    const activeSkillListResponse = await fetch(`${baseUrl}/api/skills`);
    assert(activeSkillListResponse.status === 200, "expected /api/skills after active update");
    const activeSkillListPayload = await activeSkillListResponse.json();
    const activeResearchSkill = activeSkillListPayload.skills.find(
      (skill) => skill.id === "research",
    );
    assert(activeResearchSkill?.is_active, "expected research to be active after active_skill update");

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
      (event) => event.eventType === "tool" && event.data?.name === "planner",
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
      deniedToolTalkResponse.status === 200,
      "expected talk with denied tools to return 200 SSE",
    );
    const deniedToolTalkEvents = parseSsePayload(await deniedToolTalkResponse.text());
    const deniedToolError = deniedToolTalkEvents.find((event) => event.eventType === "error");
    assert(
      deniedToolError?.data?.code === "policy_tools_denied",
      "expected policy_tools_denied code for denied tools talk",
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
      invalidToolTalkResponse.status === 200,
      "expected talk with invalid tools to return 200 SSE",
    );
    const invalidToolTalkEvents = parseSsePayload(await invalidToolTalkResponse.text());
    const invalidToolError = invalidToolTalkEvents.find((event) => event.eventType === "error");
    assert(
      invalidToolError?.data?.code === "policy_tools_invalid",
      "expected policy_tools_invalid code for invalid tools talk",
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

    const workspaceSelectResult = runUiCommand(baseUrl, "--workspace-select", "alpha");
    assert(workspaceSelectResult.status === 0, "expected UI workspace select to return 0");
    assert(
      workspaceSelectResult.stdout.includes("Workspace: alpha"),
      "expected UI workspace select output",
    );
    const configAfterUiWorkspaceSelect = await fetch(`${baseUrl}/api/config`);
    const configAfterUiWorkspaceSelectPayload = await configAfterUiWorkspaceSelect.json();
    assert(
      configAfterUiWorkspaceSelectPayload.runtime.active_workspace === "alpha",
      "UI workspace select did not persist active workspace",
    );

    const workspaceClearResult = runUiCommand(baseUrl, "--workspace-clear");
    assert(workspaceClearResult.status === 0, "expected UI workspace clear to return 0");
    assert(
      workspaceClearResult.stdout.includes("Workspace: host default"),
      "expected UI workspace clear output",
    );
    const configAfterUiWorkspaceClear = await fetch(`${baseUrl}/api/config`);
    const configAfterUiWorkspaceClearPayload = await configAfterUiWorkspaceClear.json();
    assert(
      configAfterUiWorkspaceClearPayload.runtime.active_workspace === null,
      "UI workspace clear did not persist runtime fallback",
    );

    const skillSelectResult = runUiCommand(baseUrl, "--skill-select", "research");
    assert(skillSelectResult.status === 0, "expected UI skill select to return 0");
    assert(
      skillSelectResult.stdout.includes("Skill: research"),
      "expected UI skill select output",
    );
    const configAfterUiSkillSelect = await fetch(`${baseUrl}/api/config`);
    const configAfterUiSkillSelectPayload = await configAfterUiSkillSelect.json();
    assert(
      configAfterUiSkillSelectPayload.runtime.active_skill === "research",
      "UI skill select did not persist active skill",
    );

    const skillClearResult = runUiCommand(baseUrl, "--skill-clear");
    assert(skillClearResult.status === 0, "expected UI skill clear to return 0");
    assert(
      skillClearResult.stdout.includes("Skill: workspace/default"),
      "expected UI skill clear output",
    );
    const configAfterUiSkillClear = await fetch(`${baseUrl}/api/config`);
    const configAfterUiSkillClearPayload = await configAfterUiSkillClear.json();
    assert(
      configAfterUiSkillClearPayload.runtime.active_skill === null,
      "UI skill clear did not persist runtime fallback",
    );

    const stateFileAfterUiClear = await readFile(runtimeStatePath, "utf8");
    assert(stateFileAfterUiClear.trim() === "{}", "runtime state file should be empty after UI clear");

    const workspaceCreateResult = runUiCommand(
      baseUrl,
      "--workspace-create",
      "field-lab",
      "--workspace-instructions",
      "# Field Lab\n\n- Capture hardware notes.\n",
    );
    assert(workspaceCreateResult.status === 0, "expected UI workspace create to return 0");
    assert(
      workspaceCreateResult.stdout.includes("field-lab [idle]"),
      "expected UI workspace create detail output",
    );
    assert(
      workspaceCreateResult.stdout.includes("instructions: yes"),
      "expected UI workspace create instructions output",
    );
    const workspaceListAfterCreateResponse = await fetch(`${baseUrl}/api/workspaces`);
    const workspaceListAfterCreatePayload = await workspaceListAfterCreateResponse.json();
    const fieldLabWorkspace = workspaceListAfterCreatePayload.workspaces.find(
      (workspace) => workspace.id === "field-lab",
    );
    assert(fieldLabWorkspace, "expected created workspace in workspace list");
    assert(fieldLabWorkspace.has_instructions === true, "expected created workspace instructions metadata");

    const workspaceDetailResult = runUiCommand(baseUrl, "--workspace-detail", "alpha");
    assert(workspaceDetailResult.status === 0, "expected UI workspace detail to return 0");
    assert(
      workspaceDetailResult.stdout.includes("default skill: research"),
      "expected UI workspace detail default skill output",
    );

    const skillDetailResult = runUiCommand(baseUrl, "--skill-detail", "coding");
    assert(skillDetailResult.status === 0, "expected UI skill detail to return 0");
    assert(
      skillDetailResult.stdout.includes("permission: balanced"),
      "expected UI skill detail permission output",
    );
    assert(
      skillDetailResult.stdout.includes("bash: git status"),
      "expected UI skill detail bash prefix output",
    );

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
    const clearedStatusEvent = talkAfterClearEvents.find(
      (event) => event.eventType === "status" && event.data?.message === "Runner started for default",
    );
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
      audioTalkDeniedToolsResponse.status === 200,
      "expected /api/audio/:id/talk denied tools to return 200 SSE",
    );
    const audioTalkDeniedToolsEvents = parseSsePayload(await audioTalkDeniedToolsResponse.text());
    const audioTalkDeniedToolsError = audioTalkDeniedToolsEvents.find(
      (event) => event.eventType === "error",
    );
    assert(
      audioTalkDeniedToolsError?.data?.code === "policy_tools_denied",
      "expected policy_tools_denied code for denied tools audio talk",
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

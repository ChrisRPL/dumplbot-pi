#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4135;
const MODEL_PORT = 4136;
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

const collectTokenText = (events) =>
  events
    .filter((event) => event.eventType === "token")
    .map((event) => String(event.data?.text ?? ""))
    .join("")
    .trim();

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

const readJsonBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });

const writeFakeResponseEvent = (response, payload) => {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const startFakeModelServer = async () => {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    const payload = await readJsonBody(request);
    const instructions = String(payload.instructions ?? "");
    const workspaceMatch = instructions.match(/Active workspace:\s*([^\n]+)/u);
    const workspaceId = workspaceMatch?.[1]?.trim() ?? "unknown";
    const skillId = instructions.includes("research mode")
      ? "research"
      : instructions.includes("coding mode")
      ? "coding"
      : "unknown";
    const replyText = `${workspaceId}|${skillId}`;

    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    });

    writeFakeResponseEvent(response, {
      type: "response.output_text.delta",
      delta: replyText,
    });
    writeFakeResponseEvent(response, {
      type: "response.completed",
    });
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(MODEL_PORT, HOST, resolve);
  });

  return server;
};

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
        DUMPLBOT_MODEL_BASE_URL: `http://${HOST}:${MODEL_PORT}`,
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

const waitForWorkspaceHistory = async (baseUrl, workspaceId, expectedCount) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/history`);

    if (response.ok) {
      const payload = await response.json();

      if (payload.total >= expectedCount) {
        return payload;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`workspace ${workspaceId} history did not reach ${expectedCount} entries in time`);
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
  const secretsPath = join(tmpRoot, "secrets.env");

  await mkdir(defaultWorkspacePath, { recursive: true });
  await mkdir(alphaWorkspacePath, { recursive: true });
  await mkdir(notesRepoPath, { recursive: true });
  await writeFile(join(defaultWorkspacePath, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(join(alphaWorkspacePath, "CLAUDE.md"), "# alpha\n", "utf8");
  await writeFile(join(notesRepoPath, "README.md"), "# notes\n", "utf8");
  await writeFile(secretsPath, "OPENAI_API_KEY=test-openai\n", "utf8");
  const normalizedNotesRepoPath = await realpath(notesRepoPath);
  await writeFile(
    configPath,
    "runtime:\n  default_workspace: default\n  default_skill: coding\n",
    "utf8",
  );

  const fakeModelServer = await startFakeModelServer();
  const hostServer = await startHostServer(tmpRoot, workspaceRoot, configPath, secretsPath);
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
    assert(
      codingSkill.prompt_prelude_summary?.includes("coding mode"),
      "expected coding skill prompt prelude summary metadata",
    );
    assert(
      codingSkill.model?.reasoning === "high",
      "expected coding skill model reasoning metadata",
    );
    const codingOpenAiIntegration = codingSkill.integrations?.find(
      (integration) => integration.provider === "openai",
    );
    const codingAnthropicIntegration = codingSkill.integrations?.find(
      (integration) => integration.provider === "anthropic",
    );
    assert(codingOpenAiIntegration?.configured === true, "expected openai skill integration readiness");
    assert(codingAnthropicIntegration?.configured === false, "expected anthropic skill integration readiness");

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
    const activeThinkingEvent = talkWithActiveEvents.find(
      (event) => event.eventType === "status" && event.data?.message === "Thinking",
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
      activeThinkingEvent,
      "talk did not enter model thinking state",
    );
    assert(
      collectTokenText(talkWithActiveEvents) === "alpha|research",
      "talk did not use active workspace + workspace default skill",
    );

    const alphaHistoryAfterFirstTalkPayload = await waitForWorkspaceHistory(baseUrl, "alpha", 1);
    assert(alphaHistoryAfterFirstTalkPayload.workspace_id === "alpha", "unexpected workspace history id");
    assert(alphaHistoryAfterFirstTalkPayload.total === 1, "expected one alpha history entry after first talk");
    assert(alphaHistoryAfterFirstTalkPayload.returned === 1, "expected one returned alpha history entry");
    assert(Array.isArray(alphaHistoryAfterFirstTalkPayload.history), "workspace history payload is invalid");
    assert(alphaHistoryAfterFirstTalkPayload.history[0]?.prompt === "ping", "workspace history prompt mismatch");
    assert(alphaHistoryAfterFirstTalkPayload.history[0]?.skill === "research", "workspace history skill mismatch");
    assert(alphaHistoryAfterFirstTalkPayload.history[0]?.source === "text", "workspace history source mismatch");
    assert(alphaHistoryAfterFirstTalkPayload.history[0]?.status === "success", "workspace history status mismatch");

    const alphaHistoryFile = JSON.parse(
      await readFile(join(alphaWorkspacePath, ".dumplbot-history.json"), "utf8"),
    );
    assert(Array.isArray(alphaHistoryFile), "workspace history file should contain an array");
    assert(alphaHistoryFile.length === 1, "workspace history file should contain one entry after first talk");
    assert(alphaHistoryFile[0]?.prompt === "ping", "workspace history file prompt mismatch");

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
    assert(
      collectTokenText(talkWithOverrideEvents) === "default|research",
      "talk override did not use requested workspace + skill",
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
      body: JSON.stringify({ text: "pong" }),
    });
    assert(
      talkWithActiveSkillResponse.status === 200,
      "expected /api/talk with active skill to return 200",
    );
    const talkWithActiveSkillEvents = parseSsePayload(await talkWithActiveSkillResponse.text());
    assert(
      collectTokenText(talkWithActiveSkillEvents) === "alpha|research",
      "talk did not use active skill fallback",
    );

    await waitForWorkspaceHistory(baseUrl, "alpha", 2);

    const alphaHistoryPagedResponse = await fetch(`${baseUrl}/api/workspaces/alpha/history?limit=1`);
    assert(alphaHistoryPagedResponse.status === 200, "expected paged alpha history route to return 200");
    const alphaHistoryPagedPayload = await alphaHistoryPagedResponse.json();
    assert(alphaHistoryPagedPayload.total === 2, "expected two alpha history entries after second talk");
    assert(alphaHistoryPagedPayload.returned === 1, "expected one paged alpha history entry");
    assert(alphaHistoryPagedPayload.history[0]?.prompt === "pong", "paged alpha history should return newest entry");

    const alphaHistoryOffsetResponse = await fetch(`${baseUrl}/api/workspaces/alpha/history?limit=1&offset=1`);
    assert(alphaHistoryOffsetResponse.status === 200, "expected alpha history offset route to return 200");
    const alphaHistoryOffsetPayload = await alphaHistoryOffsetResponse.json();
    assert(alphaHistoryOffsetPayload.returned === 1, "expected one offset alpha history entry");
    assert(alphaHistoryOffsetPayload.history[0]?.prompt === "ping", "offset alpha history should return older entry");

    const updatedAlphaHistoryFile = JSON.parse(
      await readFile(join(alphaWorkspacePath, ".dumplbot-history.json"), "utf8"),
    );
    assert(updatedAlphaHistoryFile.length === 2, "workspace history file should contain two alpha entries");
    assert(updatedAlphaHistoryFile[1]?.prompt === "pong", "workspace history file latest entry mismatch");

    const writeWorkspaceFileResponse = await fetch(`${baseUrl}/api/workspaces/alpha/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "notes/today.md",
        content: "# Alpha Notes\n\n- shipped workspace files\n",
      }),
    });
    assert(writeWorkspaceFileResponse.status === 200, "expected workspace file write to return 200");
    const writeWorkspaceFilePayload = await writeWorkspaceFileResponse.json();
    assert(writeWorkspaceFilePayload.workspace_id === "alpha", "workspace file write id mismatch");
    assert(writeWorkspaceFilePayload.path === "notes/today.md", "workspace file write path mismatch");
    assert(
      writeWorkspaceFilePayload.content.includes("workspace files"),
      "workspace file write content mismatch",
    );

    const workspaceFileContents = await readFile(join(alphaWorkspacePath, "notes", "today.md"), "utf8");
    assert(
      workspaceFileContents.includes("workspace files"),
      "workspace file should be stored under workspace root",
    );

    const workspaceFilesListResponse = await fetch(`${baseUrl}/api/workspaces/alpha/files`);
    assert(workspaceFilesListResponse.status === 200, "expected workspace files list to return 200");
    const workspaceFilesListPayload = await workspaceFilesListResponse.json();
    assert(workspaceFilesListPayload.workspace_id === "alpha", "workspace files list id mismatch");
    assert(Array.isArray(workspaceFilesListPayload.files), "workspace files list payload is invalid");
    assert(
      workspaceFilesListPayload.files.some((entry) => entry.path === "notes/today.md"),
      "workspace files list should include saved project file",
    );
    assert(
      !workspaceFilesListPayload.files.some((entry) => entry.path === ".dumplbot-history.json"),
      "workspace files list should hide internal history file",
    );
    assert(
      !workspaceFilesListPayload.files.some((entry) => entry.path === "repos/notes/README.md"),
      "workspace files list should hide attached repo contents",
    );

    const workspaceFileReadResponse = await fetch(
      `${baseUrl}/api/workspaces/alpha/files?path=notes%2Ftoday.md`,
    );
    assert(workspaceFileReadResponse.status === 200, "expected workspace file read to return 200");
    const workspaceFileReadPayload = await workspaceFileReadResponse.json();
    assert(workspaceFileReadPayload.path === "notes/today.md", "workspace file read path mismatch");
    assert(
      workspaceFileReadPayload.content.includes("workspace files"),
      "workspace file read content mismatch",
    );

    const invalidWorkspaceFileResponse = await fetch(`${baseUrl}/api/workspaces/alpha/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "../escape.md",
        content: "nope",
      }),
    });
    assert(
      invalidWorkspaceFileResponse.status === 400,
      "expected invalid workspace file path to return 400",
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

    const workspaceFilesResult = runUiCommand(baseUrl, "--workspace-files", "alpha");
    assert(workspaceFilesResult.status === 0, "expected UI workspace files to return 0");
    assert(
      workspaceFilesResult.stdout.includes("notes/today.md"),
      "expected UI workspace files output",
    );

    const workspaceFileResult = runUiCommand(
      baseUrl,
      "--workspace-file",
      "alpha",
      "--workspace-file-path",
      "notes/today.md",
    );
    assert(workspaceFileResult.status === 0, "expected UI workspace file read to return 0");
    assert(
      workspaceFileResult.stdout.includes("workspace files"),
      "expected UI workspace file content output",
    );

    const skillDetailResult = runUiCommand(baseUrl, "--skill-detail", "coding");
    assert(skillDetailResult.status === 0, "expected UI skill detail to return 0");
    assert(
      skillDetailResult.stdout.includes("permission: balanced"),
      "expected UI skill detail permission output",
    );
    assert(
      skillDetailResult.stdout.includes("reasoning: high"),
      "expected UI skill detail reasoning output",
    );
    assert(
      skillDetailResult.stdout.includes("prelude: You are in coding mode."),
      "expected UI skill detail prelude output",
    );
    assert(
      skillDetailResult.stdout.includes("integrations: openai[ready], anthropic[missing]"),
      "expected UI skill detail integration readiness output",
    );
    assert(
      skillDetailResult.stdout.includes("bash: git status"),
      "expected UI skill detail bash prefix output",
    );

    const skillSummaryResult = runUiCommand(baseUrl, "--skill-summary");
    assert(skillSummaryResult.status === 0, "expected UI skill summary to return 0");
    assert(
      skillSummaryResult.stdout.includes("* coding [balanced]"),
      "expected UI skill summary active skill output",
    );
    assert(
      skillSummaryResult.stdout.includes("high | tools:4 | ready 1/2"),
      "expected UI skill summary compact metadata output",
    );

    const homeNextTargetResult = runUiCommand(
      baseUrl,
      "--home-nav-mode",
      "home",
      "--home-nav-action",
      "next-target",
    );
    assert(homeNextTargetResult.status === 0, "expected home nav next-target to return 0");
    assert(
      homeNextTargetResult.stdout.includes("> skill"),
      "expected home nav next-target to focus skill",
    );

    const homeWorkspaceViewResult = runUiCommand(
      baseUrl,
      "--home-nav-mode",
      "home",
      "--home-nav-target",
      "workspace",
      "--home-nav-action",
      "toggle-view",
    );
    assert(homeWorkspaceViewResult.status === 0, "expected home nav workspace toggle to return 0");
    assert(
      homeWorkspaceViewResult.stdout.includes("Mock UI | Workspaces"),
      "expected home nav workspace toggle to render workspace screen",
    );
    assert(
      homeWorkspaceViewResult.stdout.includes("alpha [research]"),
      "expected home nav workspace toggle to show workspace content",
    );

    const homeSkillViewResult = runUiCommand(
      baseUrl,
      "--home-nav-mode",
      "home",
      "--home-nav-target",
      "skill",
      "--home-nav-action",
      "toggle-view",
    );
    assert(homeSkillViewResult.status === 0, "expected home nav skill toggle to return 0");
    assert(
      homeSkillViewResult.stdout.includes("Mock UI | Skills"),
      "expected home nav skill toggle to render skill screen",
    );
    assert(
      homeSkillViewResult.stdout.includes("* coding [balanced]"),
      "expected home nav skill toggle to show active skill",
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
    assert(
      collectTokenText(talkAfterClearEvents) === "default|coding",
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
    await new Promise((resolve) => {
      fakeModelServer.close(resolve);
    });
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type {
  DumplDoneEvent,
  DumplErrorEvent,
  DumplEvent,
  DumplStatusEvent,
  DumplSttEvent,
  DumplToolEvent,
} from "../../../packages/core/src";

import { parseSingleWavUpload, readRequestBuffer } from "./audio-upload";
import { getStoredAudioPath, storeAudioBuffer } from "./audio-store";
import type { RunnerInput, RunnerLaunchOptions } from "./runner";
import { streamRunnerEvents } from "./runner";
import { loadHostRuntimeConfig, loadHostSandboxConfig } from "./runtime-config";
import { loadHostRuntimeState, writeHostRuntimeState } from "./runtime-state-store";
import { listSkills, loadSkill, normalizeSkillId } from "./skill-store";
import { loadSttRuntimeConfig } from "./stt-config";
import { transcribeAudioFile } from "./transcriber";
import {
  createWorkspace,
  getExistingWorkspacePath,
  listWorkspaces,
  normalizeWorkspaceId,
} from "./workspace-store";

type DumplTalkRequest = {
  text: string;
  workspace?: string;
  skill?: string;
  tools?: string[];
};

type DumplAudioTalkRequest = {
  workspace?: string;
  skill?: string;
  tools?: string[];
};

type DumplCreateWorkspaceRequest = {
  id: string;
  instructions?: string;
};

type DumplUpdateConfigRequest = {
  runtime?: {
    active_workspace?: string | null;
    active_skill?: string | null;
  };
};

type AudioAction = "talk" | "transcribe";

type AudioActionRoute = {
  action: AudioAction;
  audioId: string;
};

const DEFAULT_HOST = process.env.DUMPLBOT_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number.parseInt(process.env.DUMPLBOT_PORT ?? "4123", 10);
const AUDIO_ACTIONS = new Set<AudioAction>(["talk", "transcribe"]);

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void => {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
};

const sendSseHeaders = (response: ServerResponse): void => {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
};

const writeSseEvent = (response: ServerResponse, event: DumplEvent): void => {
  const { type, ...payload } = event;
  response.write(`event: ${type}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const getRequestPathname = (request: IncomingMessage): string =>
  new URL(request.url ?? "/", "http://127.0.0.1").pathname;

const matchAudioActionRoute = (pathname: string): AudioActionRoute | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 4) {
    return null;
  }

  if (segments[0] !== "api" || segments[1] !== "audio") {
    return null;
  }

  const action = segments[3];

  if (!AUDIO_ACTIONS.has(action as AudioAction)) {
    return null;
  }

  return {
    action: action as AudioAction,
    audioId: segments[2],
  };
};

const readJson = async <T>(request: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(rawBody) as T;
};

const readOptionalJson = async <T>(request: IncomingMessage): Promise<Partial<T>> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();

  if (rawBody.length === 0) {
    return {};
  }

  return JSON.parse(rawBody) as Partial<T>;
};

const handleHealth = (_request: IncomingMessage, response: ServerResponse): void => {
  sendJson(response, 200, { ok: true });
};

const getWorkspaceErrorStatus = (message: string): number => {
  if (message === "workspace not found") {
    return 404;
  }

  if (message === "workspace id is invalid") {
    return 400;
  }

  if (message === "default workspace is required") {
    return 500;
  }

  return 500;
};

const getSkillErrorStatus = (message: string): number => {
  if (message === "skill not found") {
    return 404;
  }

  if (message === "skill id is invalid") {
    return 400;
  }

  if (message === "default skill is required") {
    return 500;
  }

  return 500;
};

const getPolicyErrorCode = (message: string): string => {
  if (message === "requested tools are not allowed by skill") {
    return "policy_tools_denied";
  }

  if (message === "strict mode does not allow requested tools") {
    return "policy_mode_denied";
  }

  if (message === "tools must be an array of non-empty strings") {
    return "policy_tools_invalid";
  }

  return "policy_denied";
};

type WorkspaceSelection = {
  defaultWorkspace: string;
  activeWorkspace: string | null;
};

type ResolvedWorkspace = {
  id: string;
  path: string;
};

const loadWorkspaceSelection = async (): Promise<WorkspaceSelection> => {
  const runtimeConfig = await loadHostRuntimeConfig();
  const runtimeState = await loadHostRuntimeState();

  return {
    defaultWorkspace: runtimeConfig.defaultWorkspace,
    activeWorkspace: runtimeState.activeWorkspace ?? null,
  };
};

const pickWorkspaceCandidate = (
  requestedWorkspace: string | undefined,
  selection: WorkspaceSelection,
): string => {
  if (requestedWorkspace?.trim().length) {
    return requestedWorkspace;
  }

  if (selection.activeWorkspace) {
    return selection.activeWorkspace;
  }

  if (selection.defaultWorkspace.trim().length > 0) {
    return selection.defaultWorkspace;
  }

  throw new Error("default workspace is required");
};

const resolveWorkspace = async (
  requestedWorkspace: string | undefined,
): Promise<ResolvedWorkspace> => {
  const selection = await loadWorkspaceSelection();
  const workspaceCandidate = pickWorkspaceCandidate(requestedWorkspace, selection);
  const workspaceId = normalizeWorkspaceId(workspaceCandidate);

  if (!workspaceId) {
    throw new Error("default workspace is required");
  }

  const workspacePath = await getExistingWorkspacePath(workspaceId);
  return {
    id: workspaceId,
    path: workspacePath,
  };
};

type ResolvedSkill = {
  id: string;
  toolAllowlist: string[];
  permissionMode: "strict" | "balanced" | "permissive";
};

type SkillSelection = {
  defaultSkill: string;
  activeSkill: string | null;
};

const loadSkillSelection = async (): Promise<SkillSelection> => {
  const runtimeConfig = await loadHostRuntimeConfig();
  const runtimeState = await loadHostRuntimeState();

  return {
    defaultSkill: runtimeConfig.defaultSkill,
    activeSkill: runtimeState.activeSkill ?? null,
  };
};

const pickSkillCandidate = (
  requestedSkill: string | undefined,
  selection: SkillSelection,
): string => {
  if (requestedSkill?.trim().length) {
    return requestedSkill;
  }

  if (selection.activeSkill) {
    return selection.activeSkill;
  }

  if (selection.defaultSkill.trim().length > 0) {
    return selection.defaultSkill;
  }

  throw new Error("default skill is required");
};

const resolveSkill = async (requestedSkill: string | undefined): Promise<ResolvedSkill> => {
  const selection = await loadSkillSelection();
  const skillCandidate = pickSkillCandidate(requestedSkill, selection);

  if (!skillCandidate.trim().length) {
    throw new Error("default skill is required");
  }

  const skillId = normalizeSkillId(skillCandidate);
  const skill = await loadSkill(skillId);
  return {
    id: skill.id,
    toolAllowlist: [...skill.toolAllowlist],
    permissionMode: skill.permissionMode,
  };
};

const parseRequestedTools = (requestedTools: string[] | undefined): string[] | null => {
  if (typeof requestedTools === "undefined") {
    return null;
  }

  if (!Array.isArray(requestedTools)) {
    throw new Error("tools must be an array of non-empty strings");
  }

  const normalizedTools: string[] = [];

  for (const requestedTool of requestedTools) {
    if (typeof requestedTool !== "string") {
      throw new Error("tools must be an array of non-empty strings");
    }

    const normalizedTool = requestedTool.trim();

    if (normalizedTool.length === 0) {
      throw new Error("tools must be an array of non-empty strings");
    }

    normalizedTools.push(normalizedTool);
  }

  const uniqueTools = Array.from(new Set(normalizedTools));

  if (uniqueTools.length === 0) {
    throw new Error("tools must be an array of non-empty strings");
  }

  return uniqueTools;
};

const resolveToolAllowlist = (
  skillToolAllowlist: string[],
  requestedTools: string[] | undefined,
): string[] => {
  const parsedRequestedTools = parseRequestedTools(requestedTools);

  if (!parsedRequestedTools) {
    return [...skillToolAllowlist];
  }

  const deniedTools = parsedRequestedTools.filter(
    (requestedTool) => !skillToolAllowlist.includes(requestedTool),
  );

  if (deniedTools.length > 0) {
    throw new Error("requested tools are not allowed by skill");
  }

  return parsedRequestedTools;
};

const STRICT_MODE_BLOCKED_TOOLS = new Set(["bash"]);

const applyPermissionModeToolClamp = (
  permissionMode: ResolvedSkill["permissionMode"],
  toolAllowlist: string[],
): string[] => {
  if (permissionMode !== "strict") {
    return [...toolAllowlist];
  }

  const clampedToolAllowlist = toolAllowlist.filter(
    (toolName) => !STRICT_MODE_BLOCKED_TOOLS.has(toolName),
  );

  if (clampedToolAllowlist.length === 0) {
    throw new Error("strict mode does not allow requested tools");
  }

  return clampedToolAllowlist;
};

type SkillPreludeInput = {
  id: string;
  toolAllowlist: string[];
};

const buildSkillPreludeEvents = (skill: SkillPreludeInput): DumplEvent[] => {
  const statusEvent: DumplStatusEvent = {
    type: "status",
    message: `Using skill ${skill.id}`,
  };
  const toolEvent: DumplToolEvent = {
    type: "tool",
    name: "skill-policy",
    detail: skill.toolAllowlist.join(","),
  };

  return [statusEvent, toolEvent];
};

const streamPolicyDeniedResponse = (
  response: ServerResponse,
  message: string,
): void => {
  sendSseHeaders(response);

  const statusEvent: DumplStatusEvent = {
    type: "status",
    message: "Policy check failed",
    phase: "policy",
  };
  writeSseEvent(response, statusEvent);

  const errorEvent: DumplErrorEvent = {
    type: "error",
    message,
    code: getPolicyErrorCode(message),
  };
  writeSseEvent(response, errorEvent);

  response.end();
};

const getConfigResponsePayload = async (): Promise<Record<string, unknown>> => {
  const runtimeConfig = await loadHostRuntimeConfig();
  const runtimeState = await loadHostRuntimeState();

  return {
    runtime: {
      default_workspace: runtimeConfig.defaultWorkspace,
      default_skill: runtimeConfig.defaultSkill,
      active_workspace: runtimeState.activeWorkspace ?? null,
      active_skill: runtimeState.activeSkill ?? null,
    },
  };
};

const handleWorkspaceList = async (response: ServerResponse): Promise<void> => {
  const workspaces = await listWorkspaces();
  const selection = await loadWorkspaceSelection();
  let activeWorkspaceId: string | null = null;

  try {
    const candidate = pickWorkspaceCandidate(undefined, selection);
    activeWorkspaceId = normalizeWorkspaceId(candidate);
  } catch {
    activeWorkspaceId = null;
  }

  sendJson(response, 200, {
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      has_instructions: workspace.hasInstructions,
      is_active: workspace.id === activeWorkspaceId,
    })),
  });
};

const handleWorkspaceCreate = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  let body: DumplCreateWorkspaceRequest;

  try {
    body = await readJson<DumplCreateWorkspaceRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  try {
    const workspace = await createWorkspace(body);
    sendJson(response, 201, {
      id: workspace.id,
      has_instructions: true,
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace create failed";
    const statusCode = message === "workspace already exists" ? 409 : 400;
    sendJson(response, statusCode, { error: message });
    return;
  }
};

const handleSkillList = async (response: ServerResponse): Promise<void> => {
  const skills = await listSkills();
  const selection = await loadSkillSelection();
  let activeSkillId: string | null = null;

  try {
    const candidate = pickSkillCandidate(undefined, selection);
    activeSkillId = normalizeSkillId(candidate);
  } catch {
    activeSkillId = null;
  }

  sendJson(response, 200, {
    skills: skills.map((skill) => ({
      id: skill.id,
      permission_mode: skill.permissionMode,
      tool_allowlist: skill.toolAllowlist,
      is_active: skill.id === activeSkillId,
    })),
  });
};

const handleConfigGet = async (response: ServerResponse): Promise<void> => {
  sendJson(response, 200, await getConfigResponsePayload());
};

const handleConfigUpdate = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  let body: DumplUpdateConfigRequest;

  try {
    body = await readJson<DumplUpdateConfigRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  if (!body.runtime || !("active_workspace" in body.runtime)) {
    const hasActiveSkill = "active_skill" in (body.runtime ?? {});

    if (!hasActiveSkill) {
      sendJson(response, 400, { error: "runtime.active_workspace or runtime.active_skill is required" });
      return;
    }
  }

  if (!body.runtime) {
    sendJson(response, 400, { error: "runtime.active_workspace or runtime.active_skill is required" });
    return;
  }

  const hasActiveWorkspace = "active_workspace" in body.runtime;
  const hasActiveSkill = "active_skill" in body.runtime;

  if (!hasActiveWorkspace && !hasActiveSkill) {
    sendJson(response, 400, { error: "runtime.active_workspace or runtime.active_skill is required" });
    return;
  }

  const currentRuntimeState = await loadHostRuntimeState();
  const nextRuntimeState = {
    activeWorkspace: currentRuntimeState.activeWorkspace,
    activeSkill: currentRuntimeState.activeSkill,
  };

  if (hasActiveWorkspace) {
    const activeWorkspace = body.runtime.active_workspace;

    if (typeof activeWorkspace === "undefined") {
      sendJson(response, 400, { error: "runtime.active_workspace must be string or null" });
      return;
    }

    try {
      if (activeWorkspace === null) {
        nextRuntimeState.activeWorkspace = undefined;
      } else {
        const workspaceId = normalizeWorkspaceId(activeWorkspace);
        await getExistingWorkspacePath(workspaceId);
        nextRuntimeState.activeWorkspace = workspaceId;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "workspace update failed";
      sendJson(response, getWorkspaceErrorStatus(message), { error: message });
      return;
    }
  }

  if (hasActiveSkill) {
    const activeSkill = body.runtime.active_skill;

    if (typeof activeSkill === "undefined") {
      sendJson(response, 400, { error: "runtime.active_skill must be string or null" });
      return;
    }

    try {
      if (activeSkill === null) {
        nextRuntimeState.activeSkill = undefined;
      } else {
        const skillId = normalizeSkillId(activeSkill);
        await loadSkill(skillId);
        nextRuntimeState.activeSkill = skillId;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "skill update failed";
      sendJson(response, getSkillErrorStatus(message), { error: message });
      return;
    }
  }

  await writeHostRuntimeState(nextRuntimeState);
  sendJson(response, 200, await getConfigResponsePayload());
};

const streamTalkResponse = async (
  response: ServerResponse,
  input: RunnerInput,
  launchOptions: RunnerLaunchOptions,
  preludeEvents: DumplEvent[] = [],
  assumeHeadersSent = false,
): Promise<void> => {
  if (!assumeHeadersSent) {
    sendSseHeaders(response);
  }

  for (const event of preludeEvents) {
    writeSseEvent(response, event);
  }

  let sawTerminalEvent = false;

  for await (const event of streamRunnerEvents(input, launchOptions)) {
    if (event.type === "done" || event.type === "error") {
      sawTerminalEvent = true;
    }

    writeSseEvent(response, event);
  }

  if (!sawTerminalEvent) {
    const doneEvent: DumplDoneEvent = {
      type: "done",
      summary: "Run finished",
    };
    writeSseEvent(response, doneEvent);
  }

  response.end();
};

const handleTalk = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  let body: DumplTalkRequest;

  try {
    body = await readJson<DumplTalkRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  const prompt = body.text?.trim();

  if (!prompt) {
    sendJson(response, 400, { error: "text is required" });
    return;
  }

  let resolvedWorkspace: ResolvedWorkspace;
  let resolvedSkill: ResolvedSkill;
  let toolAllowlist: string[];

  try {
    resolvedWorkspace = await resolveWorkspace(body.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace resolution failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  try {
    resolvedSkill = await resolveSkill(body.skill);
  } catch (error) {
    const message = error instanceof Error ? error.message : "skill resolution failed";
    sendJson(response, getSkillErrorStatus(message), { error: message });
    return;
  }

  try {
    toolAllowlist = resolveToolAllowlist(resolvedSkill.toolAllowlist, body.tools);
    toolAllowlist = applyPermissionModeToolClamp(resolvedSkill.permissionMode, toolAllowlist);
  } catch (error) {
    const message = error instanceof Error ? error.message : "policy validation failed";
    streamPolicyDeniedResponse(response, message);
    return;
  }

  const sandboxConfig = await loadHostSandboxConfig();

  await streamTalkResponse(response, {
    prompt,
    workspace: resolvedWorkspace.id,
    skill: resolvedSkill.id,
    toolAllowlist,
    policy: {
      workspace: resolvedWorkspace.id,
      skill: resolvedSkill.id,
      toolAllowlist,
      permissionMode: resolvedSkill.permissionMode,
    },
  }, {
    sandbox: sandboxConfig,
    workspacePath: resolvedWorkspace.path,
  }, buildSkillPreludeEvents({
    id: resolvedSkill.id,
    toolAllowlist,
  }));
};

const handleAudio = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const requestBody = await readRequestBuffer(request);
  let audioBuffer: Buffer;

  try {
    audioBuffer = parseSingleWavUpload(request.headers, requestBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid audio upload";
    sendJson(response, 400, { error: message });
    return;
  }

  const stored = await storeAudioBuffer(audioBuffer);
  sendJson(response, 200, { audio_id: stored.audioId });
};

const handleAudioTranscribe = async (
  audioId: string,
  response: ServerResponse,
): Promise<void> => {
  let audioPath: string;

  try {
    audioPath = await getStoredAudioPath(audioId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "audio lookup failed";
    const statusCode = message === "audio not found" ? 404 : 400;
    sendJson(response, statusCode, { error: message });
    return;
  }

  const sttConfig = await loadSttRuntimeConfig();
  const transcription = await transcribeAudioFile(audioId, audioPath, sttConfig);
  sendJson(response, 200, {
    audio_id: audioId,
    text: transcription.text,
  });
};

const handleAudioTalk = async (
  request: IncomingMessage,
  audioId: string,
  response: ServerResponse,
): Promise<void> => {
  let audioPath: string;

  try {
    audioPath = await getStoredAudioPath(audioId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "audio lookup failed";
    const statusCode = message === "audio not found" ? 404 : 400;
    sendJson(response, statusCode, { error: message });
    return;
  }

  let body: Partial<DumplAudioTalkRequest>;

  try {
    body = await readOptionalJson<DumplAudioTalkRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  let resolvedWorkspace: ResolvedWorkspace;
  let resolvedSkill: ResolvedSkill;
  let toolAllowlist: string[];

  try {
    resolvedWorkspace = await resolveWorkspace(body.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace resolution failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  try {
    resolvedSkill = await resolveSkill(body.skill);
  } catch (error) {
    const message = error instanceof Error ? error.message : "skill resolution failed";
    sendJson(response, getSkillErrorStatus(message), { error: message });
    return;
  }

  try {
    toolAllowlist = resolveToolAllowlist(resolvedSkill.toolAllowlist, body.tools);
    toolAllowlist = applyPermissionModeToolClamp(resolvedSkill.permissionMode, toolAllowlist);
  } catch (error) {
    const message = error instanceof Error ? error.message : "policy validation failed";
    streamPolicyDeniedResponse(response, message);
    return;
  }

  const sandboxConfig = await loadHostSandboxConfig();

  sendSseHeaders(response);

  const transcribingEvent: DumplStatusEvent = {
    type: "status",
    message: "Transcribing audio",
  };
  writeSseEvent(response, transcribingEvent);

  const sttConfig = await loadSttRuntimeConfig();
  const transcription = await transcribeAudioFile(audioId, audioPath, sttConfig);
  const prompt = transcription.text.trim();

  if (!prompt) {
    throw new Error("transcription returned empty text");
  }

  const sttEvent: DumplSttEvent = {
    type: "stt",
    text: prompt,
  };
  writeSseEvent(response, sttEvent);

  await streamTalkResponse(
    response,
    {
      prompt,
      workspace: resolvedWorkspace.id,
      skill: resolvedSkill.id,
      toolAllowlist,
      policy: {
        workspace: resolvedWorkspace.id,
        skill: resolvedSkill.id,
        toolAllowlist,
        permissionMode: resolvedSkill.permissionMode,
      },
    },
    {
      sandbox: sandboxConfig,
      workspacePath: resolvedWorkspace.path,
    },
    buildSkillPreludeEvents({
      id: resolvedSkill.id,
      toolAllowlist,
    }),
    true,
  );
};

const handleNotFound = (_request: IncomingMessage, response: ServerResponse): void => {
  sendJson(response, 404, { error: "not found" });
};

const handleInternalError = (
  response: ServerResponse,
  message: string,
): void => {
  if (!response.headersSent) {
    sendJson(response, 500, { error: message });
    return;
  }

  if (response.writableEnded) {
    return;
  }

  const event: DumplErrorEvent = {
    type: "error",
    message,
  };
  writeSseEvent(response, event);
  response.end();
};

export const createHostServer = (): Server =>
  createServer(async (request, response) => {
    try {
      const pathname = getRequestPathname(request);
      const audioActionRoute = request.method === "POST"
        ? matchAudioActionRoute(pathname)
        : null;

      if (request.method === "GET" && pathname === "/health") {
        handleHealth(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/talk") {
        await handleTalk(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/audio") {
        await handleAudio(request, response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/workspaces") {
        await handleWorkspaceList(response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/workspaces") {
        await handleWorkspaceCreate(request, response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/skills") {
        await handleSkillList(response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/config") {
        await handleConfigGet(response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/config") {
        await handleConfigUpdate(request, response);
        return;
      }

      if (request.method === "POST" && audioActionRoute?.action === "transcribe") {
        await handleAudioTranscribe(audioActionRoute.audioId, response);
        return;
      }

      if (request.method === "POST" && audioActionRoute?.action === "talk") {
        await handleAudioTalk(request, audioActionRoute.audioId, response);
        return;
      }

      handleNotFound(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      handleInternalError(response, message);
    }
  });

export const startHostServer = (): Server => {
  const server = createHostServer();

  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    process.stdout.write(
      `dumplbotd listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}\n`,
    );
  });

  return server;
};

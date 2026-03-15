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
import { clearLastAudio, getStoredAudioPath, readLastAudio, storeAudioBuffer } from "./audio-store";
import { clearLastDebugError, readLastDebugError, writeLastDebugError } from "./error-store";
import { isLanClientAddress, isLanOnlySetupPath } from "./lan-only";
import type { RunnerInput, RunnerLaunchOptions } from "./runner";
import { streamRunnerEvents } from "./runner";
import {
  loadHostRuntimeConfig,
  loadHostSandboxConfig,
  loadHostSchedulerConfig,
  loadHostServerConfig,
} from "./runtime-config";
import {
  parseImportedHostConfig,
  parseImportedHostRuntimeConfig,
  readHostConfigText,
  writeHostRuntimeConfigUpdate,
  writeImportedHostConfig,
} from "./runtime-config-store";
import { loadHostRuntimeState, writeHostRuntimeState } from "./runtime-state-store";
import {
  deleteScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  setScheduledJobEnabled,
  upsertScheduledJob,
} from "./scheduler-store";
import { writeSetupSecretUpdate } from "./secret-store";
import { loadSetupSecretStatus } from "./secret-status";
import { buildSetupHealthStatus } from "./setup-health-status";
import { buildSetupSystemStatus } from "./setup-system-status";
import { listSkills, loadSkill, normalizeSkillId } from "./skill-store";
import { loadSttRuntimeConfig } from "./stt-config";
import { renderSetupPage } from "./setup-page";
import { clearLastTranscript, readLastTranscript, storeTranscript } from "./transcript-store";
import { transcribeAudioFile } from "./transcriber";
import {
  createWorkspace,
  getExistingWorkspacePath,
  getWorkspacePath,
  listWorkspaces,
  normalizeWorkspaceId,
} from "./workspace-store";
import { listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from "./workspace-file-store";
import { loadWorkspaceHistory, recordWorkspaceRun } from "./workspace-history-store";
import {
  ensureWorkspaceRepoAttachment,
  loadWorkspaceConfig,
  writeWorkspaceConfig,
} from "./workspace-config-store";

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

type DumplAttachWorkspaceRepoRequest = {
  id: string;
  path: string;
};

type DumplUpdateWorkspaceConfigRequest = {
  default_skill?: string | null;
};

type DumplWriteWorkspaceFileRequest = {
  path: string;
  content: string;
};

type DumplUpdateConfigRequest = {
  runtime?: {
    default_workspace?: string;
    default_skill?: string;
    safety_mode?: "strict" | "balanced" | "permissive";
    active_workspace?: string | null;
    active_skill?: string | null;
  };
};

type DumplImportConfigRequest = {
  config: string;
};

type DumplSetupSecretsUpdateRequest = {
  anthropic_api_key?: string;
  openai_api_key?: string;
};

type DumplSeedDebugVoiceRequest = {
  transcript_text?: string | null;
  audio_size_bytes?: number | null;
  error_source?: string | null;
  error_message?: string | null;
};

type DumplUpsertJobRequest = {
  id: string;
  prompt: string;
  schedule: string;
  workspace?: string | null;
  skill?: string | null;
  enabled?: boolean;
};

type DumplPatchJobRequest = {
  prompt?: string;
  schedule?: string;
  workspace?: string | null;
  skill?: string | null;
  enabled?: boolean;
};

type AudioAction = "talk" | "transcribe";

type AudioActionRoute = {
  action: AudioAction;
  audioId: string;
};

type WorkspaceRepoRoute = {
  workspaceId: string;
};

type WorkspaceConfigRoute = {
  workspaceId: string;
};

type WorkspaceHistoryRoute = WorkspaceRepoRoute;
type WorkspaceFilesRoute = WorkspaceRepoRoute;

type JobAction = "enable" | "disable";

type JobRoute = {
  jobId: string;
};

type JobHistoryRoute = JobRoute;

type JobActionRoute = JobRoute & {
  action: JobAction;
};

const AUDIO_ACTIONS = new Set<AudioAction>(["talk", "transcribe"]);
let activeServerConfig: Awaited<ReturnType<typeof loadHostServerConfig>> | null = null;

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void => {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
};

const sendHtml = (
  response: ServerResponse,
  statusCode: number,
  html: string,
): void => {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
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

const matchWorkspaceRepoRoute = (pathname: string): WorkspaceRepoRoute | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 4) {
    return null;
  }

  if (segments[0] !== "api" || segments[1] !== "workspaces" || segments[3] !== "repos") {
    return null;
  }

  return {
    workspaceId: segments[2],
  };
};

const matchWorkspaceConfigRoute = (pathname: string): WorkspaceConfigRoute | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 4) {
    return null;
  }

  if (segments[0] !== "api" || segments[1] !== "workspaces" || segments[3] !== "config") {
    return null;
  }

  return {
    workspaceId: segments[2],
  };
};

const matchWorkspaceHistoryRoute = (pathname: string): WorkspaceHistoryRoute | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 4) {
    return null;
  }

  if (segments[0] !== "api" || segments[1] !== "workspaces" || segments[3] !== "history") {
    return null;
  }

  return {
    workspaceId: segments[2],
  };
};

const matchWorkspaceFilesRoute = (pathname: string): WorkspaceFilesRoute | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 4) {
    return null;
  }

  if (segments[0] !== "api" || segments[1] !== "workspaces" || segments[3] !== "files") {
    return null;
  }

  return {
    workspaceId: segments[2],
  };
};

const matchJobRoute = (pathname: string): JobRoute | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 3) {
    return null;
  }

  if (segments[0] !== "api" || segments[1] !== "jobs") {
    return null;
  }

  return {
    jobId: segments[2],
  };
};

const matchJobActionRoute = (pathname: string): JobActionRoute | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 4) {
    return null;
  }

  if (segments[0] !== "api" || segments[1] !== "jobs") {
    return null;
  }

  if (segments[3] !== "enable" && segments[3] !== "disable") {
    return null;
  }

  return {
    jobId: segments[2],
    action: segments[3],
  };
};

const matchJobHistoryRoute = (pathname: string): JobHistoryRoute | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 4) {
    return null;
  }

  if (segments[0] !== "api" || segments[1] !== "jobs" || segments[3] !== "history") {
    return null;
  }

  return {
    jobId: segments[2],
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

const getJobErrorStatus = (message: string): number => {
  if (message === "job not found") {
    return 404;
  }

  if (message === "job id is invalid") {
    return 400;
  }

  return 400;
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

  if (message === "bash tool requires command prefix allowlist") {
    return "policy_bash_prefix_required";
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
  attachedRepoPaths: string[];
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
  const workspaceConfig = await loadWorkspaceConfig(workspacePath);
  return {
    id: workspaceId,
    path: workspacePath,
    attachedRepoPaths: workspaceConfig.attachedRepos.map((attachment) => attachment.path),
  };
};

type ResolvedSkill = {
  id: string;
  toolAllowlist: string[];
  bashCommandPrefixAllowlist: string[];
  permissionMode: "strict" | "balanced" | "permissive";
};

type SkillSelection = {
  defaultSkill: string;
  activeSkill: string | null;
  workspaceDefaultSkill: string | null;
};

const loadSkillSelection = async (workspacePath?: string): Promise<SkillSelection> => {
  const runtimeConfig = await loadHostRuntimeConfig();
  const runtimeState = await loadHostRuntimeState();
  const workspaceConfig = workspacePath
    ? await loadWorkspaceConfig(workspacePath)
    : { defaultSkill: null, attachedRepos: [] };

  return {
    defaultSkill: runtimeConfig.defaultSkill,
    activeSkill: runtimeState.activeSkill ?? null,
    workspaceDefaultSkill: workspaceConfig.defaultSkill,
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

  if (selection.workspaceDefaultSkill) {
    return selection.workspaceDefaultSkill;
  }

  if (selection.defaultSkill.trim().length > 0) {
    return selection.defaultSkill;
  }

  throw new Error("default skill is required");
};

const resolveSkill = async (
  requestedSkill: string | undefined,
  workspacePath: string,
): Promise<ResolvedSkill> => {
  const selection = await loadSkillSelection(workspacePath);
  const skillCandidate = pickSkillCandidate(requestedSkill, selection);

  if (!skillCandidate.trim().length) {
    throw new Error("default skill is required");
  }

  const skillId = normalizeSkillId(skillCandidate);
  const skill = await loadSkill(skillId);
  return {
    id: skill.id,
    toolAllowlist: [...skill.toolAllowlist],
    bashCommandPrefixAllowlist: [...skill.bashCommandPrefixAllowlist],
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

const resolveBashCommandPrefixAllowlist = (
  toolAllowlist: string[],
  skillBashCommandPrefixAllowlist: string[],
): string[] => {
  if (!toolAllowlist.includes("bash")) {
    return [];
  }

  if (skillBashCommandPrefixAllowlist.length === 0) {
    throw new Error("bash tool requires command prefix allowlist");
  }

  return [...skillBashCommandPrefixAllowlist];
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

type StreamTalkOutcome = {
  completedAt: string;
  status: "success" | "error";
  summary: string;
};

const logWorkspaceHistoryWriteFailure = (
  workspaceId: string,
  error: unknown,
): void => {
  const message = error instanceof Error ? error.message : "unknown workspace history write failure";
  process.stderr.write(`workspace history write failed for ${workspaceId}: ${message}\n`);
};

const logDebugErrorWriteFailure = (
  source: string,
  error: unknown,
): void => {
  const message = error instanceof Error ? error.message : "unknown debug error write failure";
  process.stderr.write(`debug error write failed for ${source}: ${message}\n`);
};

const recordDebugError = async (
  source: string,
  message: string,
): Promise<void> => {
  try {
    await writeLastDebugError(source, message);
  } catch (error) {
    logDebugErrorWriteFailure(source, error);
  }
};

const streamPolicyDeniedResponse = async (
  response: ServerResponse,
  source: string,
  message: string,
): Promise<void> => {
  await recordDebugError(source, message);
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
      safety_mode: runtimeConfig.permissionMode,
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

  const workspacePayload = await Promise.all(workspaces.map(async (workspace) => {
    const workspaceConfig = await loadWorkspaceConfig(getWorkspacePath(workspace.id));

    return {
      id: workspace.id,
      has_instructions: workspace.hasInstructions,
      is_active: workspace.id === activeWorkspaceId,
      default_skill: workspaceConfig.defaultSkill,
      attached_repos: workspaceConfig.attachedRepos.map((attachment) => ({
        id: attachment.id,
        path: attachment.path,
        mount_path: `repos/${attachment.id}`,
      })),
    };
  }));

  sendJson(response, 200, {
    workspaces: workspacePayload,
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

const handleWorkspaceRepoAttach = async (
  request: IncomingMessage,
  workspaceId: string,
  response: ServerResponse,
): Promise<void> => {
  let body: DumplAttachWorkspaceRepoRequest;

  try {
    body = await readJson<DumplAttachWorkspaceRepoRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  let workspacePath: string;

  try {
    workspacePath = await getExistingWorkspacePath(workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace resolution failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  try {
    const workspaceConfig = await loadWorkspaceConfig(workspacePath);
    const duplicateAttachment = workspaceConfig.attachedRepos.find(
      (entry) => entry.id === body.id.trim().toLowerCase() || entry.path === body.path.trim(),
    );

    if (duplicateAttachment) {
      throw new Error("workspace repo already attached");
    }

    const attachment = await ensureWorkspaceRepoAttachment(workspacePath, body.id, body.path);
    await writeWorkspaceConfig(workspacePath, {
      defaultSkill: workspaceConfig.defaultSkill,
      attachedRepos: [...workspaceConfig.attachedRepos, attachment],
    });

    sendJson(response, 201, {
      id: attachment.id,
      path: attachment.path,
      mount_path: `repos/${attachment.id}`,
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace repo attach failed";
    const statusCode = message === "workspace repo already attached" ? 409 : 400;
    sendJson(response, statusCode, { error: message });
    return;
  }
};

const handleWorkspaceConfigUpdate = async (
  request: IncomingMessage,
  workspaceId: string,
  response: ServerResponse,
): Promise<void> => {
  let body: DumplUpdateWorkspaceConfigRequest;

  try {
    body = await readJson<DumplUpdateWorkspaceConfigRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  if (!("default_skill" in body)) {
    sendJson(response, 400, { error: "default_skill is required" });
    return;
  }

  let workspacePath: string;

  try {
    workspacePath = await getExistingWorkspacePath(workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace resolution failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  if (body.default_skill !== null && typeof body.default_skill !== "string") {
    sendJson(response, 400, { error: "default_skill must be string or null" });
    return;
  }

  let nextDefaultSkill: string | null = null;

  try {
    if (typeof body.default_skill === "string") {
      const skillId = normalizeSkillId(body.default_skill);
      await loadSkill(skillId);
      nextDefaultSkill = skillId;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace default skill update failed";
    sendJson(response, getSkillErrorStatus(message), { error: message });
    return;
  }

  const workspaceConfig = await loadWorkspaceConfig(workspacePath);
  const nextWorkspaceConfig = await writeWorkspaceConfig(workspacePath, {
    defaultSkill: nextDefaultSkill,
    attachedRepos: workspaceConfig.attachedRepos,
  });

  sendJson(response, 200, {
    id: workspaceId,
    default_skill: nextWorkspaceConfig.defaultSkill,
    attached_repos: nextWorkspaceConfig.attachedRepos.map((attachment) => ({
      id: attachment.id,
      path: attachment.path,
      mount_path: `repos/${attachment.id}`,
    })),
  });
};

const handleWorkspaceHistoryGet = async (
  request: IncomingMessage,
  workspaceId: string,
  response: ServerResponse,
): Promise<void> => {
  try {
    const workspacePath = await getExistingWorkspacePath(workspaceId);
    const history = await loadWorkspaceHistory(workspacePath);
    const historyWindow = parseWorkspaceHistoryWindow(request);
    const returnedHistory = sliceWorkspaceHistory(history, historyWindow);

    sendJson(response, 200, {
      workspace_id: normalizeWorkspaceId(workspaceId),
      total: history.length,
      returned: returnedHistory.length,
      history: returnedHistory.map(toWorkspaceHistoryEntryPayload),
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace history lookup failed";
    const statusCode = message === "workspace not found"
      ? 404
      : 400;
    sendJson(response, statusCode, { error: message });
    return;
  }
};

const handleWorkspaceFilesGet = async (
  request: IncomingMessage,
  workspaceId: string,
  response: ServerResponse,
): Promise<void> => {
  try {
    const workspacePath = await getExistingWorkspacePath(workspaceId);
    const filePath = parseOptionalWorkspaceFilePath(request);

    if (typeof filePath === "string" && filePath.trim().length > 0) {
      const file = await readWorkspaceFile(workspacePath, filePath);
      sendJson(response, 200, {
        workspace_id: normalizeWorkspaceId(workspaceId),
        path: file.path,
        content: file.content,
        size: file.size,
        updated_at: file.updatedAt,
      });
      return;
    }

    const files = await listWorkspaceFiles(workspacePath);
    sendJson(response, 200, {
      workspace_id: normalizeWorkspaceId(workspaceId),
      files: files.map(toWorkspaceFileSummaryPayload),
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace files lookup failed";
    const statusCode = message === "workspace not found"
      ? 404
      : getWorkspaceFileErrorStatus(message);
    sendJson(response, statusCode, { error: message });
    return;
  }
};

const handleWorkspaceFileWrite = async (
  request: IncomingMessage,
  workspaceId: string,
  response: ServerResponse,
): Promise<void> => {
  let body: DumplWriteWorkspaceFileRequest;

  try {
    body = await readJson<DumplWriteWorkspaceFileRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  if (typeof body.path !== "string") {
    sendJson(response, 400, { error: "path must be string" });
    return;
  }

  if (typeof body.content !== "string") {
    sendJson(response, 400, { error: "content must be string" });
    return;
  }

  try {
    const workspacePath = await getExistingWorkspacePath(workspaceId);
    const file = await writeWorkspaceFile(workspacePath, body.path, body.content);
    sendJson(response, 200, {
      workspace_id: normalizeWorkspaceId(workspaceId),
      path: file.path,
      content: file.content,
      size: file.size,
      updated_at: file.updatedAt,
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace file write failed";
    const statusCode = message === "workspace not found"
      ? 404
      : getWorkspaceFileErrorStatus(message);
    sendJson(response, statusCode, { error: message });
    return;
  }
};

const isSkillIntegrationConfigured = (
  provider: string,
  secretStatus: Awaited<ReturnType<typeof loadSetupSecretStatus>>,
): boolean => {
  if (provider === "openai") {
    return secretStatus.openaiApiKeyConfigured;
  }

  if (provider === "anthropic") {
    return secretStatus.anthropicApiKeyConfigured;
  }

  return false;
};

const handleSkillList = async (response: ServerResponse): Promise<void> => {
  const [skills, secretStatus] = await Promise.all([
    listSkills(),
    loadSetupSecretStatus(),
  ]);
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
      bash_prefix_allowlist: skill.bashCommandPrefixAllowlist,
      prompt_prelude_summary: skill.promptPreludeSummary,
      model: {
        reasoning: skill.modelReasoning,
      },
      integrations: skill.integrations.map((integration) => ({
        provider: integration.provider,
        purpose: integration.purpose,
        configured: isSkillIntegrationConfigured(integration.provider, secretStatus),
      })),
      is_active: skill.id === activeSkillId,
    })),
  });
};

const handleConfigGet = async (response: ServerResponse): Promise<void> => {
  sendJson(response, 200, await getConfigResponsePayload());
};

const handleDebugVoiceGet = async (response: ServerResponse): Promise<void> => {
  const [lastTranscript, lastAudio, lastError] = await Promise.all([
    readLastTranscript(),
    readLastAudio(),
    readLastDebugError(),
  ]);

  sendJson(response, 200, {
    transcript: {
      present: lastTranscript !== null,
      path: lastTranscript?.transcriptPath ?? null,
      text: lastTranscript?.text ?? null,
      updated_at: lastTranscript?.updatedAt ?? null,
    },
    audio: {
      present: lastAudio !== null,
      path: lastAudio?.audioPath ?? null,
      size_bytes: lastAudio?.sizeBytes ?? null,
      updated_at: lastAudio?.updatedAt ?? null,
    },
    error: {
      present: lastError !== null,
      path: lastError?.errorPath ?? null,
      source: lastError?.source ?? null,
      message: lastError?.message ?? null,
      updated_at: lastError?.updatedAt ?? null,
    },
  });
};

const handleDebugVoiceClear = async (response: ServerResponse): Promise<void> => {
  await Promise.all([
    clearLastTranscript(),
    clearLastAudio(),
    clearLastDebugError(),
  ]);

  await handleDebugVoiceGet(response);
};

const handleDebugVoiceSeed = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  let body: DumplSeedDebugVoiceRequest;

  try {
    body = await readJson<DumplSeedDebugVoiceRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  if (
    typeof body.transcript_text !== "undefined"
    && body.transcript_text !== null
    && typeof body.transcript_text !== "string"
  ) {
    sendJson(response, 400, { error: "transcript_text must be string or null" });
    return;
  }

  if (
    typeof body.audio_size_bytes !== "undefined"
    && body.audio_size_bytes !== null
    && (!Number.isInteger(body.audio_size_bytes) || body.audio_size_bytes < 0)
  ) {
    sendJson(response, 400, { error: "audio_size_bytes must be non-negative integer or null" });
    return;
  }

  if (
    typeof body.error_source !== "undefined"
    && body.error_source !== null
    && typeof body.error_source !== "string"
  ) {
    sendJson(response, 400, { error: "error_source must be string or null" });
    return;
  }

  if (
    typeof body.error_message !== "undefined"
    && body.error_message !== null
    && typeof body.error_message !== "string"
  ) {
    sendJson(response, 400, { error: "error_message must be string or null" });
    return;
  }

  if ((body.error_source === null) !== (body.error_message === null) && (
    body.error_source === null || body.error_message === null
  )) {
    sendJson(response, 400, { error: "error_source and error_message must both be set or both be null" });
    return;
  }

  await Promise.all([
    clearLastTranscript(),
    clearLastAudio(),
    clearLastDebugError(),
  ]);

  if (typeof body.transcript_text === "string") {
    await storeTranscript("debug-seed", body.transcript_text);
  }

  if (typeof body.audio_size_bytes === "number") {
    await storeAudioBuffer(Buffer.alloc(body.audio_size_bytes, 0));
  }

  if (typeof body.error_source === "string" && typeof body.error_message === "string") {
    await writeLastDebugError(body.error_source, body.error_message);
  }

  await handleDebugVoiceGet(response);
};

const handleConfigExport = async (response: ServerResponse): Promise<void> => {
  sendJson(response, 200, {
    config: await readHostConfigText(),
  });
};

const handleSetupStatusGet = async (response: ServerResponse): Promise<void> => {
  const secretStatus = await loadSetupSecretStatus();

  sendJson(response, 200, {
    secrets: {
      anthropic_api_key_configured: secretStatus.anthropicApiKeyConfigured,
      openai_api_key_configured: secretStatus.openaiApiKeyConfigured,
      secrets_file_present: secretStatus.secretsFilePresent,
    },
  });
};

const handleSetupHealthGet = async (response: ServerResponse): Promise<void> => {
  const [schedulerConfig, sttConfig] = await Promise.all([
    loadHostSchedulerConfig(),
    loadSttRuntimeConfig(),
  ]);
  sendJson(response, 200, buildSetupHealthStatus(schedulerConfig, sttConfig));
};

const handleSetupSystemGet = async (response: ServerResponse): Promise<void> => {
  const configuredServerConfig = await loadHostServerConfig(undefined, {
    applyEnvOverrides: false,
  });
  const currentActiveServerConfig = activeServerConfig ?? configuredServerConfig;
  sendJson(response, 200, buildSetupSystemStatus(currentActiveServerConfig, configuredServerConfig));
};

const handleSetupSecretsUpdate = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  let body: DumplSetupSecretsUpdateRequest;

  try {
    body = await readJson<DumplSetupSecretsUpdateRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  const hasOpenAiKey = typeof body.openai_api_key === "string" && body.openai_api_key.trim().length > 0;
  const hasAnthropicKey = typeof body.anthropic_api_key === "string" && body.anthropic_api_key.trim().length > 0;

  if (!hasOpenAiKey && !hasAnthropicKey) {
    sendJson(response, 400, { error: "at least one non-empty setup secret is required" });
    return;
  }

  await writeSetupSecretUpdate({
    openaiApiKey: hasOpenAiKey ? body.openai_api_key : undefined,
    anthropicApiKey: hasAnthropicKey ? body.anthropic_api_key : undefined,
  });
  await handleSetupStatusGet(response);
};

const handleConfigImport = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  let body: DumplImportConfigRequest;

  try {
    body = await readJson<DumplImportConfigRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  if (typeof body.config !== "string") {
    sendJson(response, 400, { error: "config must be string" });
    return;
  }

  let importedConfig;

  try {
    importedConfig = parseImportedHostConfig(body.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "config import validation failed";
    sendJson(response, 400, { error: message });
    return;
  }

  try {
    const workspaceId = normalizeWorkspaceId(importedConfig.runtime.defaultWorkspace);
    await getExistingWorkspacePath(workspaceId);
    importedConfig.runtime.defaultWorkspace = workspaceId;
  } catch (error) {
    const message = error instanceof Error ? error.message : "config import workspace validation failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  try {
    const skillId = normalizeSkillId(importedConfig.runtime.defaultSkill);
    await loadSkill(skillId);
    importedConfig.runtime.defaultSkill = skillId;
  } catch (error) {
    const message = error instanceof Error ? error.message : "config import skill validation failed";
    sendJson(response, getSkillErrorStatus(message), { error: message });
    return;
  }

  try {
    await writeImportedHostConfig(body.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "config import failed";
    sendJson(response, 400, { error: message });
    return;
  }

  sendJson(response, 200, {
    config: await readHostConfigText(),
    ...(await getConfigResponsePayload()),
  });
};

const toJobPayload = (job: Awaited<ReturnType<typeof upsertScheduledJob>>) => ({
  id: job.id,
  prompt: job.prompt,
  schedule: job.schedule,
  workspace: job.workspace,
  skill: job.skill,
  enabled: job.enabled,
  last_run_at: job.lastRunAt,
  last_status: job.lastStatus,
  last_result: job.lastResult,
  last_duration_ms: job.lastDurationMs,
  last_error: job.lastError,
  failure_count: job.failureCount,
  last_success_at: job.lastSuccessAt,
  history: job.history.map((entry) => ({
    completed_at: entry.completedAt,
    result: entry.result,
    status: entry.status,
  })),
});

const toJobHistoryEntryPayload = (entry: Awaited<ReturnType<typeof upsertScheduledJob>>["history"][number]) => ({
  completed_at: entry.completedAt,
  result: entry.result,
  status: entry.status,
});

const toWorkspaceHistoryEntryPayload = (entry: Awaited<ReturnType<typeof loadWorkspaceHistory>>[number]) => ({
  completed_at: entry.completedAt,
  prompt: entry.prompt,
  transcript: entry.transcript,
  skill: entry.skill,
  source: entry.source,
  status: entry.status,
  summary: entry.summary,
});

const toWorkspaceFileSummaryPayload = (entry: Awaited<ReturnType<typeof listWorkspaceFiles>>[number]) => ({
  path: entry.path,
  size: entry.size,
  updated_at: entry.updatedAt,
});

const parseOptionalPositiveIntSearchParam = (
  request: IncomingMessage,
  key: string,
  { allowZero = false }: { allowZero?: boolean } = {},
): number | null => {
  const rawValue = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get(key);

  if (rawValue === null) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  const minimumValue = allowZero ? 0 : 1;

  if (!Number.isInteger(parsedValue) || parsedValue < minimumValue) {
    throw new Error(`history ${key} is invalid`);
  }

  return parsedValue;
};

const parseJobHistoryWindow = (request: IncomingMessage): { limit: number | null; offset: number } => ({
  limit: parseOptionalPositiveIntSearchParam(request, "limit"),
  offset: parseOptionalPositiveIntSearchParam(request, "offset", { allowZero: true }) ?? 0,
});

const parseWorkspaceHistoryWindow = (request: IncomingMessage): { limit: number | null; offset: number } => ({
  limit: parseOptionalPositiveIntSearchParam(request, "limit"),
  offset: parseOptionalPositiveIntSearchParam(request, "offset", { allowZero: true }) ?? 0,
});

const parseOptionalWorkspaceFilePath = (request: IncomingMessage): string | null =>
  new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("path");

const sliceJobHistory = (
  history: Awaited<ReturnType<typeof upsertScheduledJob>>["history"],
  { limit, offset }: { limit: number | null; offset: number },
) => {
  const endIndex = Math.max(0, history.length - offset);
  const startIndex = limit === null
    ? 0
    : Math.max(0, endIndex - limit);

  return history.slice(startIndex, endIndex);
};

const sliceWorkspaceHistory = (
  history: Awaited<ReturnType<typeof loadWorkspaceHistory>>,
  { limit, offset }: { limit: number | null; offset: number },
) => {
  const endIndex = Math.max(0, history.length - offset);
  const startIndex = limit === null
    ? 0
    : Math.max(0, endIndex - limit);

  return history.slice(startIndex, endIndex);
};

const getWorkspaceFileErrorStatus = (message: string): number => {
  if (message === "workspace file not found") {
    return 404;
  }

  if (
    message === "workspace file path is invalid"
    || message === "workspace file path is required"
  ) {
    return 400;
  }

  return 500;
};

const handleJobList = async (response: ServerResponse): Promise<void> => {
  const jobs = await listScheduledJobs();
  sendJson(response, 200, {
    jobs: jobs.map(toJobPayload),
  });
};

const handleJobGet = async (
  jobId: string,
  response: ServerResponse,
): Promise<void> => {
  try {
    const job = await getScheduledJob(jobId);
    sendJson(response, 200, toJobPayload(job));
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "job lookup failed";
    sendJson(response, getJobErrorStatus(message), { error: message });
    return;
  }
};

const handleJobHistoryGet = async (
  request: IncomingMessage,
  jobId: string,
  response: ServerResponse,
): Promise<void> => {
  try {
    const job = await getScheduledJob(jobId);
    const historyWindow = parseJobHistoryWindow(request);
    const returnedHistory = sliceJobHistory(job.history, historyWindow);

    sendJson(response, 200, {
      job_id: job.id,
      total: job.history.length,
      returned: returnedHistory.length,
      history: returnedHistory.map(toJobHistoryEntryPayload),
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "job history lookup failed";
    sendJson(response, getJobErrorStatus(message), { error: message });
    return;
  }
};

const handleJobUpsert = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  let body: DumplUpsertJobRequest;

  try {
    body = await readJson<DumplUpsertJobRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  if (body.workspace !== null && typeof body.workspace !== "undefined" && typeof body.workspace !== "string") {
    sendJson(response, 400, { error: "workspace must be string or null" });
    return;
  }

  if (body.skill !== null && typeof body.skill !== "undefined" && typeof body.skill !== "string") {
    sendJson(response, 400, { error: "skill must be string or null" });
    return;
  }

  if (typeof body.enabled !== "undefined" && typeof body.enabled !== "boolean") {
    sendJson(response, 400, { error: "enabled must be boolean" });
    return;
  }

  let normalizedWorkspace: string | null = null;
  let normalizedSkill: string | null = null;

  try {
    if (typeof body.workspace === "string") {
      normalizedWorkspace = normalizeWorkspaceId(body.workspace);
      await getExistingWorkspacePath(normalizedWorkspace);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace validation failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  try {
    if (typeof body.skill === "string") {
      normalizedSkill = normalizeSkillId(body.skill);
      await loadSkill(normalizedSkill);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "skill validation failed";
    sendJson(response, getSkillErrorStatus(message), { error: message });
    return;
  }

  try {
    const job = await upsertScheduledJob({
      id: body.id,
      prompt: body.prompt,
      schedule: body.schedule,
      workspace: normalizedWorkspace,
      skill: normalizedSkill,
      enabled: body.enabled ?? true,
    });
    sendJson(response, 200, toJobPayload(job));
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "job upsert failed";
    sendJson(response, 400, { error: message });
    return;
  }
};

const handleJobPatch = async (
  request: IncomingMessage,
  jobId: string,
  response: ServerResponse,
): Promise<void> => {
  let body: Partial<DumplPatchJobRequest>;

  try {
    body = await readOptionalJson<DumplPatchJobRequest>(request);
  } catch {
    sendJson(response, 400, { error: "request body must be valid JSON" });
    return;
  }

  const hasPrompt = "prompt" in body;
  const hasSchedule = "schedule" in body;
  const hasWorkspace = "workspace" in body;
  const hasSkill = "skill" in body;
  const hasEnabled = "enabled" in body;

  if (!hasPrompt && !hasSchedule && !hasWorkspace && !hasSkill && !hasEnabled) {
    sendJson(response, 400, { error: "job patch requires at least one mutable field" });
    return;
  }

  if (hasPrompt && typeof body.prompt !== "string") {
    sendJson(response, 400, { error: "prompt must be string" });
    return;
  }

  if (hasSchedule && typeof body.schedule !== "string") {
    sendJson(response, 400, { error: "schedule must be string" });
    return;
  }

  if (hasWorkspace && body.workspace !== null && typeof body.workspace !== "string") {
    sendJson(response, 400, { error: "workspace must be string or null" });
    return;
  }

  if (hasSkill && body.skill !== null && typeof body.skill !== "string") {
    sendJson(response, 400, { error: "skill must be string or null" });
    return;
  }

  if (hasEnabled && typeof body.enabled !== "boolean") {
    sendJson(response, 400, { error: "enabled must be boolean" });
    return;
  }

  let existingJob;

  try {
    existingJob = await getScheduledJob(jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "job lookup failed";
    sendJson(response, getJobErrorStatus(message), { error: message });
    return;
  }

  let normalizedWorkspace = existingJob.workspace;
  let normalizedSkill = existingJob.skill;

  try {
    if (hasWorkspace) {
      if (body.workspace === null) {
        normalizedWorkspace = null;
      } else {
        normalizedWorkspace = normalizeWorkspaceId(body.workspace as string);
        await getExistingWorkspacePath(normalizedWorkspace);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace validation failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  try {
    if (hasSkill) {
      if (body.skill === null) {
        normalizedSkill = null;
      } else {
        normalizedSkill = normalizeSkillId(body.skill as string);
        await loadSkill(normalizedSkill);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "skill validation failed";
    sendJson(response, getSkillErrorStatus(message), { error: message });
    return;
  }

  try {
    const job = await upsertScheduledJob({
      id: existingJob.id,
      prompt: hasPrompt ? body.prompt as string : existingJob.prompt,
      schedule: hasSchedule ? body.schedule as string : existingJob.schedule,
      workspace: normalizedWorkspace,
      skill: normalizedSkill,
      enabled: hasEnabled ? body.enabled as boolean : existingJob.enabled,
    });
    sendJson(response, 200, toJobPayload(job));
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "job patch failed";
    sendJson(response, 400, { error: message });
    return;
  }
};

const handleJobDelete = async (
  jobId: string,
  response: ServerResponse,
): Promise<void> => {
  try {
    await deleteScheduledJob(jobId);
    sendJson(response, 200, { ok: true });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "job delete failed";
    sendJson(response, getJobErrorStatus(message), { error: message });
    return;
  }
};

const handleJobAction = async (
  jobId: string,
  action: JobAction,
  response: ServerResponse,
): Promise<void> => {
  try {
    const job = await setScheduledJobEnabled(jobId, action === "enable");
    sendJson(response, 200, toJobPayload(job));
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "job update failed";
    sendJson(response, getJobErrorStatus(message), { error: message });
    return;
  }
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

  if (!body.runtime) {
    sendJson(response, 400, { error: "one runtime config field is required" });
    return;
  }

  const hasDefaultWorkspace = "default_workspace" in body.runtime;
  const hasDefaultSkill = "default_skill" in body.runtime;
  const hasSafetyMode = "safety_mode" in body.runtime;
  const hasActiveWorkspace = "active_workspace" in body.runtime;
  const hasActiveSkill = "active_skill" in body.runtime;

  if (!hasDefaultWorkspace && !hasDefaultSkill && !hasSafetyMode && !hasActiveWorkspace && !hasActiveSkill) {
    sendJson(response, 400, { error: "one runtime config field is required" });
    return;
  }

  const currentRuntimeConfig = await loadHostRuntimeConfig();
  const nextRuntimeConfig = {
    defaultWorkspace: currentRuntimeConfig.defaultWorkspace,
    defaultSkill: currentRuntimeConfig.defaultSkill,
    permissionMode: currentRuntimeConfig.permissionMode,
  };
  const currentRuntimeState = await loadHostRuntimeState();
  const nextRuntimeState = {
    activeWorkspace: currentRuntimeState.activeWorkspace,
    activeSkill: currentRuntimeState.activeSkill,
  };

  if (hasDefaultWorkspace) {
    const defaultWorkspace = body.runtime.default_workspace;

    if (typeof defaultWorkspace !== "string") {
      sendJson(response, 400, { error: "runtime.default_workspace must be string" });
      return;
    }

    try {
      const workspaceId = normalizeWorkspaceId(defaultWorkspace);
      await getExistingWorkspacePath(workspaceId);
      nextRuntimeConfig.defaultWorkspace = workspaceId;
    } catch (error) {
      const message = error instanceof Error ? error.message : "default workspace update failed";
      sendJson(response, getWorkspaceErrorStatus(message), { error: message });
      return;
    }
  }

  if (hasDefaultSkill) {
    const defaultSkill = body.runtime.default_skill;

    if (typeof defaultSkill !== "string") {
      sendJson(response, 400, { error: "runtime.default_skill must be string" });
      return;
    }

    try {
      const skillId = normalizeSkillId(defaultSkill);
      await loadSkill(skillId);
      nextRuntimeConfig.defaultSkill = skillId;
    } catch (error) {
      const message = error instanceof Error ? error.message : "default skill update failed";
      sendJson(response, getSkillErrorStatus(message), { error: message });
      return;
    }
  }

  if (hasSafetyMode) {
    const safetyMode = body.runtime.safety_mode;

    if (safetyMode !== "strict" && safetyMode !== "balanced" && safetyMode !== "permissive") {
      sendJson(response, 400, { error: "runtime.safety_mode must be strict, balanced, or permissive" });
      return;
    }

    nextRuntimeConfig.permissionMode = safetyMode;
  }

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

  await writeHostRuntimeConfigUpdate({
    defaultWorkspace: nextRuntimeConfig.defaultWorkspace,
    defaultSkill: nextRuntimeConfig.defaultSkill,
    permissionMode: nextRuntimeConfig.permissionMode,
  });
  await writeHostRuntimeState(nextRuntimeState);
  sendJson(response, 200, await getConfigResponsePayload());
};

const streamTalkResponse = async (
  response: ServerResponse,
  input: RunnerInput,
  launchOptions: RunnerLaunchOptions,
  maxRunSeconds: number,
  preludeEvents: DumplEvent[] = [],
  assumeHeadersSent = false,
): Promise<StreamTalkOutcome> => {
  if (!assumeHeadersSent) {
    sendSseHeaders(response);
  }

  for (const event of preludeEvents) {
    writeSseEvent(response, event);
  }

  let sawTerminalEvent = false;
  let outcome: StreamTalkOutcome | null = null;

  for await (const event of streamRunnerEvents(input, launchOptions, maxRunSeconds)) {
    if (event.type === "done") {
      sawTerminalEvent = true;
      outcome = {
        completedAt: new Date().toISOString(),
        status: "success",
        summary: event.summary?.trim() || "Run finished",
      };
    }

    if (event.type === "error") {
      sawTerminalEvent = true;
      outcome = {
        completedAt: new Date().toISOString(),
        status: "error",
        summary: event.message,
      };
    }

    writeSseEvent(response, event);
  }

  if (!sawTerminalEvent) {
    const doneEvent: DumplDoneEvent = {
      type: "done",
      summary: "Run finished",
    };
    const doneSummary = doneEvent.summary ?? "Run finished";
    outcome = {
      completedAt: new Date().toISOString(),
      status: "success",
      summary: doneSummary,
    };
    writeSseEvent(response, doneEvent);
  }

  response.end();
  return outcome ?? {
    completedAt: new Date().toISOString(),
    status: "success",
    summary: "Run finished",
  };
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
  let bashCommandPrefixAllowlist: string[];

  try {
    resolvedWorkspace = await resolveWorkspace(body.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace resolution failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  try {
    resolvedSkill = await resolveSkill(body.skill, resolvedWorkspace.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : "skill resolution failed";
    sendJson(response, getSkillErrorStatus(message), { error: message });
    return;
  }

  try {
    toolAllowlist = resolveToolAllowlist(resolvedSkill.toolAllowlist, body.tools);
    toolAllowlist = applyPermissionModeToolClamp(resolvedSkill.permissionMode, toolAllowlist);
    bashCommandPrefixAllowlist = resolveBashCommandPrefixAllowlist(
      toolAllowlist,
      resolvedSkill.bashCommandPrefixAllowlist,
    );
  } catch (error) {
      const message = error instanceof Error ? error.message : "policy validation failed";
      await streamPolicyDeniedResponse(response, "talk", message);
      return;
    }

  const [runtimeConfig, sandboxConfig] = await Promise.all([
    loadHostRuntimeConfig(),
    loadHostSandboxConfig(),
  ]);

  const runOutcome = await streamTalkResponse(response, {
    prompt,
    workspace: resolvedWorkspace.id,
    skill: resolvedSkill.id,
    toolAllowlist,
    policy: {
      workspace: resolvedWorkspace.id,
      skill: resolvedSkill.id,
      toolAllowlist,
      bashCommandPrefixAllowlist,
      permissionMode: resolvedSkill.permissionMode,
    },
  }, {
    sandbox: sandboxConfig,
    workspacePath: resolvedWorkspace.path,
    attachedRepoPaths: resolvedWorkspace.attachedRepoPaths,
  }, runtimeConfig.maxRunSeconds, buildSkillPreludeEvents({
    id: resolvedSkill.id,
    toolAllowlist,
  }));

  if (runOutcome.status === "error") {
    await recordDebugError("talk", runOutcome.summary);
  }

  try {
    await recordWorkspaceRun(resolvedWorkspace.path, {
      completedAt: runOutcome.completedAt,
      prompt,
      transcript: null,
      skill: resolvedSkill.id,
      source: "text",
      status: runOutcome.status,
      summary: runOutcome.summary,
    });
  } catch (error) {
    logWorkspaceHistoryWriteFailure(resolvedWorkspace.id, error);
  }
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
  let transcription;

  try {
    transcription = await transcribeAudioFile(audioId, audioPath, sttConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : "audio transcription failed";
    await recordDebugError("audio-transcribe", message);
    sendJson(response, 500, { error: message });
    return;
  }

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
  let bashCommandPrefixAllowlist: string[];

  try {
    resolvedWorkspace = await resolveWorkspace(body.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace resolution failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  try {
    resolvedSkill = await resolveSkill(body.skill, resolvedWorkspace.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : "skill resolution failed";
    sendJson(response, getSkillErrorStatus(message), { error: message });
    return;
  }

  try {
    toolAllowlist = resolveToolAllowlist(resolvedSkill.toolAllowlist, body.tools);
    toolAllowlist = applyPermissionModeToolClamp(resolvedSkill.permissionMode, toolAllowlist);
    bashCommandPrefixAllowlist = resolveBashCommandPrefixAllowlist(
      toolAllowlist,
      resolvedSkill.bashCommandPrefixAllowlist,
    );
  } catch (error) {
      const message = error instanceof Error ? error.message : "policy validation failed";
      await streamPolicyDeniedResponse(response, "audio-talk", message);
      return;
    }

  const [runtimeConfig, sandboxConfig] = await Promise.all([
    loadHostRuntimeConfig(),
    loadHostSandboxConfig(),
  ]);

  sendSseHeaders(response);

  const transcribingEvent: DumplStatusEvent = {
    type: "status",
    message: "Transcribing audio",
  };
  writeSseEvent(response, transcribingEvent);

  try {
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

    const runOutcome = await streamTalkResponse(
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
          bashCommandPrefixAllowlist,
          permissionMode: resolvedSkill.permissionMode,
        },
      },
      {
        sandbox: sandboxConfig,
        workspacePath: resolvedWorkspace.path,
        attachedRepoPaths: resolvedWorkspace.attachedRepoPaths,
      },
      runtimeConfig.maxRunSeconds,
      buildSkillPreludeEvents({
        id: resolvedSkill.id,
        toolAllowlist,
      }),
      true,
    );

    if (runOutcome.status === "error") {
      await recordDebugError("audio-talk", runOutcome.summary);
    }

    try {
      await recordWorkspaceRun(resolvedWorkspace.path, {
        completedAt: runOutcome.completedAt,
        prompt,
        transcript: prompt,
        skill: resolvedSkill.id,
        source: "audio",
        status: runOutcome.status,
        summary: runOutcome.summary,
      });
    } catch (error) {
      logWorkspaceHistoryWriteFailure(resolvedWorkspace.id, error);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "audio talk failed";
    await recordDebugError("audio-talk", message);
    throw error;
  }
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

const sendLanOnlySetupDenied = (
  pathname: string,
  response: ServerResponse,
): void => {
  const message = "setup routes are only available from localhost or a private LAN address";

  if (pathname === "/setup") {
    sendHtml(
      response,
      403,
      `<!doctype html><html lang="en"><body><p>${message}</p></body></html>`,
    );
    return;
  }

  sendJson(response, 403, { error: message });
};

export const createHostServer = (): Server =>
  createServer(async (request, response) => {
    try {
      const pathname = getRequestPathname(request);
      const audioActionRoute = request.method === "POST"
        ? matchAudioActionRoute(pathname)
        : null;
      const workspaceRepoRoute = request.method === "POST"
        ? matchWorkspaceRepoRoute(pathname)
        : null;
      const workspaceConfigRoute = request.method === "POST"
        ? matchWorkspaceConfigRoute(pathname)
        : null;
      const workspaceHistoryRoute = request.method === "GET"
        ? matchWorkspaceHistoryRoute(pathname)
        : null;
      const workspaceFilesRoute = request.method === "GET" || request.method === "POST"
        ? matchWorkspaceFilesRoute(pathname)
        : null;
      const jobHistoryRoute = request.method === "GET"
        ? matchJobHistoryRoute(pathname)
        : null;
      const jobRoute = request.method === "GET" || request.method === "DELETE" || request.method === "PATCH"
        ? matchJobRoute(pathname)
        : null;
      const jobActionRoute = request.method === "POST"
        ? matchJobActionRoute(pathname)
        : null;

      if (isLanOnlySetupPath(pathname) && !isLanClientAddress(request.socket.remoteAddress)) {
        sendLanOnlySetupDenied(pathname, response);
        return;
      }

      if (request.method === "GET" && pathname === "/health") {
        handleHealth(request, response);
        return;
      }

      if (request.method === "GET" && pathname === "/setup") {
        sendHtml(response, 200, renderSetupPage());
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

      if (request.method === "POST" && workspaceRepoRoute) {
        await handleWorkspaceRepoAttach(request, workspaceRepoRoute.workspaceId, response);
        return;
      }

      if (request.method === "POST" && workspaceConfigRoute) {
        await handleWorkspaceConfigUpdate(request, workspaceConfigRoute.workspaceId, response);
        return;
      }

      if (request.method === "GET" && workspaceHistoryRoute) {
        await handleWorkspaceHistoryGet(request, workspaceHistoryRoute.workspaceId, response);
        return;
      }

      if (request.method === "GET" && workspaceFilesRoute) {
        await handleWorkspaceFilesGet(request, workspaceFilesRoute.workspaceId, response);
        return;
      }

      if (request.method === "POST" && workspaceFilesRoute) {
        await handleWorkspaceFileWrite(request, workspaceFilesRoute.workspaceId, response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/skills") {
        await handleSkillList(response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/jobs") {
        await handleJobList(response);
        return;
      }

      if (request.method === "GET" && jobHistoryRoute) {
        await handleJobHistoryGet(request, jobHistoryRoute.jobId, response);
        return;
      }

      if (request.method === "GET" && jobRoute) {
        await handleJobGet(jobRoute.jobId, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/jobs") {
        await handleJobUpsert(request, response);
        return;
      }

      if (request.method === "PATCH" && jobRoute) {
        await handleJobPatch(request, jobRoute.jobId, response);
        return;
      }

      if (request.method === "DELETE" && jobRoute) {
        await handleJobDelete(jobRoute.jobId, response);
        return;
      }

      if (request.method === "POST" && jobActionRoute) {
        await handleJobAction(jobActionRoute.jobId, jobActionRoute.action, response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/config") {
        await handleConfigGet(response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/debug/voice") {
        await handleDebugVoiceGet(response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/debug/voice/clear") {
        await handleDebugVoiceClear(response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/debug/voice/seed") {
        await handleDebugVoiceSeed(request, response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/config/export") {
        await handleConfigExport(response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/setup/status") {
        await handleSetupStatusGet(response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/setup/health") {
        await handleSetupHealthGet(response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/setup/system") {
        await handleSetupSystemGet(response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/setup/secrets") {
        await handleSetupSecretsUpdate(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/config/import") {
        await handleConfigImport(request, response);
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

const formatServerBindHost = (host: string): string => (
  host.includes(":")
    ? `[${host}]`
    : host
);

export const startHostServer = async (): Promise<Server> => {
  const serverConfig = await loadHostServerConfig();
  activeServerConfig = serverConfig;
  const server = createHostServer();

  server.listen(serverConfig.port, serverConfig.host, () => {
    process.stdout.write(
      `dumplbotd listening on http://${formatServerBindHost(serverConfig.host)}:${serverConfig.port}\n`,
    );
  });

  return server;
};

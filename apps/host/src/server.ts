import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type {
  DumplDoneEvent,
  DumplErrorEvent,
  DumplEvent,
  DumplStatusEvent,
  DumplSttEvent,
} from "../../../packages/core/src";

import { parseSingleWavUpload, readRequestBuffer } from "./audio-upload";
import { getStoredAudioPath, storeAudioBuffer } from "./audio-store";
import type { RunnerInput } from "./runner";
import { streamRunnerEvents } from "./runner";
import { loadHostRuntimeConfig } from "./runtime-config";
import { loadHostRuntimeState, writeHostRuntimeState } from "./runtime-state-store";
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
};

type DumplAudioTalkRequest = {
  workspace?: string;
  skill?: string;
};

type DumplCreateWorkspaceRequest = {
  id: string;
  instructions?: string;
};

type DumplUpdateConfigRequest = {
  runtime?: {
    active_workspace?: string | null;
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

const resolveWorkspaceId = async (requestedWorkspace: string | undefined): Promise<string> => {
  const runtimeConfig = await loadHostRuntimeConfig();
  const workspaceCandidate = requestedWorkspace?.trim().length
    ? requestedWorkspace
    : runtimeConfig.defaultWorkspace;
  const workspaceId = normalizeWorkspaceId(workspaceCandidate);

  if (!workspaceId) {
    throw new Error("default workspace is required");
  }

  await getExistingWorkspacePath(workspaceId);
  return workspaceId;
};

const getConfigResponsePayload = async (): Promise<Record<string, unknown>> => {
  const runtimeConfig = await loadHostRuntimeConfig();
  const runtimeState = await loadHostRuntimeState();

  return {
    runtime: {
      default_workspace: runtimeConfig.defaultWorkspace,
      active_workspace: runtimeState.activeWorkspace ?? null,
    },
  };
};

const handleWorkspaceList = async (response: ServerResponse): Promise<void> => {
  const workspaces = await listWorkspaces();
  sendJson(response, 200, {
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      has_instructions: workspace.hasInstructions,
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
    sendJson(response, 400, { error: "runtime.active_workspace is required" });
    return;
  }

  const activeWorkspace = body.runtime.active_workspace;

  if (typeof activeWorkspace === "undefined") {
    sendJson(response, 400, { error: "runtime.active_workspace is required" });
    return;
  }

  try {
    if (activeWorkspace === null) {
      await writeHostRuntimeState({});
    } else {
      const workspaceId = normalizeWorkspaceId(activeWorkspace);
      await getExistingWorkspacePath(workspaceId);
      await writeHostRuntimeState({ activeWorkspace: workspaceId });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace update failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  sendJson(response, 200, await getConfigResponsePayload());
};

const streamTalkResponse = async (
  response: ServerResponse,
  input: RunnerInput,
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

  for await (const event of streamRunnerEvents(input)) {
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

  let workspaceId: string;

  try {
    workspaceId = await resolveWorkspaceId(body.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace resolution failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

  await streamTalkResponse(response, {
    prompt,
    workspace: workspaceId,
    skill: body.skill,
  });
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

  let workspaceId: string;

  try {
    workspaceId = await resolveWorkspaceId(body.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace resolution failed";
    sendJson(response, getWorkspaceErrorStatus(message), { error: message });
    return;
  }

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
      workspace: workspaceId,
      skill: body.skill,
    },
    [],
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

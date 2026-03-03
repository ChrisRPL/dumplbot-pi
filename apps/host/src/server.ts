import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { DumplDoneEvent, DumplErrorEvent, DumplEvent } from "../../../packages/core/src";

import { parseSingleWavUpload, readRequestBuffer } from "./audio-upload";
import { storeAudioBuffer } from "./audio-store";
import { streamRunnerEvents } from "./runner";

type DumplTalkRequest = {
  text: string;
  workspace?: string;
  skill?: string;
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

const handleHealth = (_request: IncomingMessage, response: ServerResponse): void => {
  sendJson(response, 200, { ok: true });
};

const handleTalk = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const body = await readJson<DumplTalkRequest>(request);
  const prompt = body.text?.trim();

  if (!prompt) {
    sendJson(response, 400, { error: "text is required" });
    return;
  }

  sendSseHeaders(response);

  let sawTerminalEvent = false;

  for await (const event of streamRunnerEvents({
    prompt,
    workspace: body.workspace,
    skill: body.skill,
  })) {
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

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { DumplDoneEvent, DumplEvent, DumplStatusEvent } from "../../../packages/core/src";

type DumplTalkRequest = {
  text: string;
  workspace?: string;
  skill?: string;
};

const DEFAULT_HOST = process.env.DUMPLBOT_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number.parseInt(process.env.DUMPLBOT_PORT ?? "4123", 10);

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void => {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
};

const sendSse = (response: ServerResponse, events: DumplEvent[]): void => {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });

  for (const event of events) {
    const { type, ...payload } = event;
    response.write(`event: ${type}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  response.end();
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

  if (!body.text || body.text.trim().length === 0) {
    sendJson(response, 400, { error: "text is required" });
    return;
  }

  const events: Array<DumplStatusEvent | DumplDoneEvent> = [
    {
      type: "status",
      message: `Queued prompt for ${body.workspace ?? "default"} (${body.skill ?? "default"})`,
    },
    {
      type: "done",
      summary: "Host SSE scaffold responded successfully.",
    },
  ];

  sendSse(response, events);
};

const handleNotFound = (_request: IncomingMessage, response: ServerResponse): void => {
  sendJson(response, 404, { error: "not found" });
};

export const createHostServer = (): Server =>
  createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        handleHealth(request, response);
        return;
      }

      if (request.method === "POST" && request.url === "/api/talk") {
        await handleTalk(request, response);
        return;
      }

      handleNotFound(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      sendJson(response, 500, { error: message });
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

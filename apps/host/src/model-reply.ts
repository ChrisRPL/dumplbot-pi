import { loadSetupSecrets } from "./secret-store";
import type { RunnerControlHooks } from "./runner";
import type {
  DumplDoneEvent,
  DumplErrorEvent,
  DumplEvent,
  DumplStatusEvent,
  DumplTokenEvent,
} from "../../../packages/core/src";

export type ModelReplyRuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
};

export type ModelReplyInput = {
  prompt: string;
  instructions: string;
  reasoningEffort: "low" | "medium" | "high";
};

type ResponsesStreamEvent = {
  type?: unknown;
  delta?: unknown;
  error?: {
    message?: unknown;
  };
  response?: {
    error?: {
      message?: unknown;
    };
  };
  message?: unknown;
};

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_MAX_OUTPUT_TOKENS = 600;

const getResponsesUrl = (baseUrl: string): URL =>
  new URL("/v1/responses", baseUrl);

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
};

const buildRequestPayload = (
  input: ModelReplyInput,
  config: ModelReplyRuntimeConfig,
): Record<string, unknown> => ({
  model: config.model,
  input: input.prompt,
  instructions: input.instructions,
  reasoning: {
    effort: input.reasoningEffort,
  },
  max_output_tokens: config.maxOutputTokens,
  stream: true,
});

const toErrorEvent = (message: string): DumplErrorEvent => ({
  type: "error",
  message,
});

const extractErrorMessage = (payload: ResponsesStreamEvent): string | null => {
  if (typeof payload.error?.message === "string" && payload.error.message.trim().length > 0) {
    return payload.error.message.trim();
  }

  if (
    typeof payload.response?.error?.message === "string"
    && payload.response.error.message.trim().length > 0
  ) {
    return payload.response.error.message.trim();
  }

  if (typeof payload.message === "string" && payload.message.trim().length > 0) {
    return payload.message.trim();
  }

  return null;
};

async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ResponsesStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEventLines: string[] = [];

  const flushEvent = async function* (): AsyncGenerator<ResponsesStreamEvent> {
    if (currentEventLines.length === 0) {
      return;
    }

    const dataLines = currentEventLines
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));
    currentEventLines = [];

    if (dataLines.length === 0) {
      return;
    }

    const rawPayload = dataLines.join("\n").trim();

    if (rawPayload.length === 0 || rawPayload === "[DONE]") {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      throw new Error("model reply stream emitted invalid JSON");
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("model reply stream emitted invalid event");
    }

    yield parsed as ResponsesStreamEvent;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");

        if (newlineIndex === -1) {
          break;
        }

        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.endsWith("\r")
          ? rawLine.slice(0, -1)
          : rawLine;

        if (line.length === 0) {
          yield* flushEvent();
          continue;
        }

        currentEventLines.push(line);
      }
    }

    buffer += decoder.decode();

    if (buffer.length > 0) {
      const trailingLine = buffer.endsWith("\r")
        ? buffer.slice(0, -1)
        : buffer;

      if (trailingLine.length > 0) {
        currentEventLines.push(trailingLine);
      }
    }

    yield* flushEvent();
  } finally {
    reader.releaseLock();
  }
}

export const loadModelReplyRuntimeConfig = async (): Promise<ModelReplyRuntimeConfig> => {
  const setupSecrets = await loadSetupSecrets();

  return {
    apiKey: setupSecrets.openaiApiKey || process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.DUMPLBOT_MODEL_BASE_URL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    model: process.env.DUMPLBOT_MODEL ?? DEFAULT_MODEL,
    maxOutputTokens: parsePositiveInt(
      process.env.DUMPLBOT_MODEL_MAX_OUTPUT_TOKENS,
      DEFAULT_MAX_OUTPUT_TOKENS,
    ),
  };
};

export async function* streamModelReplyEvents(
  input: ModelReplyInput,
  config: ModelReplyRuntimeConfig,
  controlHooks?: RunnerControlHooks,
): AsyncGenerator<DumplEvent> {
  const abortController = new AbortController();
  let settled = false;

  const settle = (): void => {
    if (settled) {
      return;
    }

    settled = true;
    controlHooks?.onSettled?.();
  };

  controlHooks?.onCancelReady?.(() => {
    abortController.abort();
  });

  if (!config.apiKey.trim()) {
    yield toErrorEvent("OPENAI_API_KEY is required for freeform replies");
    settle();
    return;
  }

  const thinkingEvent: DumplStatusEvent = {
    type: "status",
    message: "Thinking",
  };
  yield thinkingEvent;

  let sawOutputText = false;

  try {
    const response = await fetch(getResponsesUrl(config.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildRequestPayload(input, config)),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).trim();
      const suffix = detail.length > 0 ? ` ${detail}` : "";
      yield toErrorEvent(`model reply failed: ${response.status}${suffix}`);
      settle();
      return;
    }

    if (!response.body) {
      yield toErrorEvent("model reply failed: missing response body");
      settle();
      return;
    }

    for await (const payload of parseSseEvents(response.body)) {
      if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
        sawOutputText = true;
        const tokenEvent: DumplTokenEvent = {
          type: "token",
          text: payload.delta,
        };
        yield tokenEvent;
        continue;
      }

      if (payload.type === "response.failed" || payload.type === "error") {
        yield toErrorEvent(extractErrorMessage(payload) ?? "model reply failed");
        settle();
        return;
      }
    }

    if (!sawOutputText) {
      yield toErrorEvent("model response returned empty text");
      settle();
      return;
    }

    const doneEvent: DumplDoneEvent = {
      type: "done",
      summary: "Model reply completed.",
    };
    yield doneEvent;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      yield toErrorEvent("run canceled");
      settle();
      return;
    }

    const message = error instanceof Error ? error.message : "model reply failed";
    yield toErrorEvent(message);
  } finally {
    settle();
  }
}

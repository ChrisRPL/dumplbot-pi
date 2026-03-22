import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { storeTranscript } from "./transcript-store";
import type { SttRuntimeConfig } from "./stt-config";

type OpenAiTranscriptionResponse = {
  text: string;
};

export type TranscriptionResult = {
  text: string;
  transcriptPath: string;
};

const getTranscriptionsUrl = (baseUrl: string): URL =>
  new URL("/v1/audio/transcriptions", baseUrl);

const parseTranscriptionResponse = (payload: unknown): OpenAiTranscriptionResponse => {
  if (!payload || typeof payload !== "object" || !("text" in payload)) {
    throw new Error("transcription response is invalid");
  }

  const text = (payload as { text: unknown }).text;

  if (typeof text !== "string") {
    throw new Error("transcription response text is invalid");
  }

  return { text };
};

const createTranscriptionForm = async (
  audioPath: string,
  config: SttRuntimeConfig,
): Promise<FormData> => {
  const audioBuffer = await readFile(audioPath);
  const form = new FormData();

  form.append(
    "file",
    new Blob([audioBuffer], { type: "audio/wav" }),
    basename(audioPath),
  );
  form.append("model", config.model);

  if (config.language && config.language !== "auto") {
    form.append("language", config.language);
  }

  if (config.promptBias) {
    form.append("prompt", config.promptBias);
  }

  return form;
};

export const transcribeAudioFile = async (
  audioId: string,
  audioPath: string,
  config: SttRuntimeConfig,
): Promise<TranscriptionResult> => {
  if (!config.apiKey) {
    throw new Error("OPENAI_API_KEY is required for transcription");
  }

  const response = await fetch(getTranscriptionsUrl(config.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
    },
    body: await createTranscriptionForm(audioPath, config),
  });

  if (!response.ok) {
    const detail = await response.text();
    const suffix = detail ? ` ${detail}` : "";
    throw new Error(`transcription failed: ${response.status}${suffix}`);
  }

  const parsed = parseTranscriptionResponse(await response.json());
  const stored = await storeTranscript(audioId, parsed.text);

  return {
    text: parsed.text,
    transcriptPath: stored.transcriptPath,
  };
};

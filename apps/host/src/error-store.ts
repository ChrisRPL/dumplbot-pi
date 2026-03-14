import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type LastDebugError = {
  errorPath: string;
  source: string;
  message: string;
  updatedAt: string;
};

type StoredLastDebugError = {
  source: string;
  message: string;
  updated_at: string;
};

const TMP_ROOT = process.env.DUMPLBOT_TMP_ROOT ?? "/tmp/dumplbot";
const LAST_ERROR_PATH = join(TMP_ROOT, "last-error.json");

const parseStoredLastDebugError = (payload: unknown): StoredLastDebugError => {
  if (!payload || typeof payload !== "object") {
    throw new Error("last error payload is invalid");
  }

  const candidate = payload as {
    source?: unknown;
    message?: unknown;
    updated_at?: unknown;
  };

  if (typeof candidate.source !== "string" || candidate.source.trim().length === 0) {
    throw new Error("last error source is invalid");
  }

  if (typeof candidate.message !== "string" || candidate.message.trim().length === 0) {
    throw new Error("last error message is invalid");
  }

  if (typeof candidate.updated_at !== "string" || candidate.updated_at.trim().length === 0) {
    throw new Error("last error timestamp is invalid");
  }

  return {
    source: candidate.source,
    message: candidate.message,
    updated_at: candidate.updated_at,
  };
};

export const writeLastDebugError = async (
  source: string,
  message: string,
): Promise<LastDebugError> => {
  const trimmedSource = source.trim();
  const trimmedMessage = message.trim();

  if (!trimmedSource) {
    throw new Error("debug error source is required");
  }

  if (!trimmedMessage) {
    throw new Error("debug error message is required");
  }

  await mkdir(TMP_ROOT, { recursive: true });

  const stored: StoredLastDebugError = {
    source: trimmedSource,
    message: trimmedMessage,
    updated_at: new Date().toISOString(),
  };

  await writeFile(LAST_ERROR_PATH, JSON.stringify(stored, null, 2), "utf8");

  return {
    errorPath: LAST_ERROR_PATH,
    source: stored.source,
    message: stored.message,
    updatedAt: stored.updated_at,
  };
};

export const readLastDebugError = async (): Promise<LastDebugError | null> => {
  try {
    const payload = JSON.parse(await readFile(LAST_ERROR_PATH, "utf8"));
    const stored = parseStoredLastDebugError(payload);

    return {
      errorPath: LAST_ERROR_PATH,
      source: stored.source,
      message: stored.message,
      updatedAt: stored.updated_at,
    };
  } catch {
    return null;
  }
};

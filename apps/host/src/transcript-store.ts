import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyRetentionPolicy } from "./retention";

export type StoredTranscript = {
  transcriptPath: string;
};

const TMP_ROOT = process.env.DUMPLBOT_TMP_ROOT ?? "/tmp/dumplbot";
const TRANSCRIPT_ROOT = join(TMP_ROOT, "transcripts");
const LAST_TRANSCRIPT_PATH = join(TMP_ROOT, "last-transcript.txt");

const sanitizeTranscriptId = (transcriptId: string): string =>
  transcriptId.replace(/[^a-z0-9_-]/gi, "").toLowerCase();

export const storeTranscript = async (
  transcriptId: string,
  transcriptText: string,
): Promise<StoredTranscript> => {
  const safeTranscriptId = sanitizeTranscriptId(transcriptId);

  if (!safeTranscriptId) {
    throw new Error("transcript id is required");
  }

  await mkdir(TRANSCRIPT_ROOT, { recursive: true });

  const transcriptPath = join(TRANSCRIPT_ROOT, `${safeTranscriptId}.txt`);
  await writeFile(transcriptPath, transcriptText, "utf8");
  await writeFile(LAST_TRANSCRIPT_PATH, transcriptText, "utf8");

  try {
    await applyRetentionPolicy(TRANSCRIPT_ROOT, ".txt");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`transcript retention warning: ${message}\n`);
  }

  return {
    transcriptPath,
  };
};

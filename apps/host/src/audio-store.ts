import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type StoredAudio = {
  audioId: string;
  audioPath: string;
  lastAudioPath: string;
};

const TMP_ROOT = process.env.DUMPLBOT_TMP_ROOT ?? "/tmp/dumplbot";
const AUDIO_ROOT = join(TMP_ROOT, "audio");
const LAST_AUDIO_PATH = join(TMP_ROOT, "last-audio.wav");

const createAudioId = (): string => randomBytes(6).toString("hex");

const createAudioPath = (audioId: string): string =>
  join(AUDIO_ROOT, `${audioId}.wav`);

const validateAudioId = (audioId: string): string => {
  const trimmedAudioId = audioId.trim().toLowerCase();

  if (!/^[a-z0-9]+$/u.test(trimmedAudioId)) {
    throw new Error("audio id is invalid");
  }

  return trimmedAudioId;
};

export const storeAudioBuffer = async (audioBuffer: Buffer): Promise<StoredAudio> => {
  const audioId = createAudioId();
  const audioPath = createAudioPath(audioId);

  await mkdir(AUDIO_ROOT, { recursive: true });
  await writeFile(audioPath, audioBuffer);
  await writeFile(LAST_AUDIO_PATH, audioBuffer);

  return {
    audioId,
    audioPath,
    lastAudioPath: LAST_AUDIO_PATH,
  };
};

export const getStoredAudioPath = async (audioId: string): Promise<string> => {
  const safeAudioId = validateAudioId(audioId);
  const audioPath = createAudioPath(safeAudioId);

  try {
    await access(audioPath);
  } catch {
    throw new Error("audio not found");
  }

  return audioPath;
};

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type HostRuntimeState = {
  activeWorkspace?: string;
  activeSkill?: string;
};

const TMP_ROOT = process.env.DUMPLBOT_TMP_ROOT ?? "/tmp/dumplbot";
const DEFAULT_STATE_PATH = join(TMP_ROOT, "runtime-state.json");

const getStatePath = (): string =>
  process.env.DUMPLBOT_RUNTIME_STATE_PATH ?? DEFAULT_STATE_PATH;

const parseRuntimeState = (raw: string): HostRuntimeState => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("runtime state is invalid");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("runtime state is invalid");
  }

  const activeWorkspace = (parsed as { active_workspace?: unknown }).active_workspace;
  const activeSkill = (parsed as { active_skill?: unknown }).active_skill;
  const state: HostRuntimeState = {};

  if (typeof activeWorkspace === "string") {
    state.activeWorkspace = activeWorkspace;
  }

  if (typeof activeSkill === "string") {
    state.activeSkill = activeSkill;
  }

  return state;
};

export const loadHostRuntimeState = async (): Promise<HostRuntimeState> => {
  const statePath = getStatePath();

  try {
    const raw = await readFile(statePath, "utf8");
    return parseRuntimeState(raw);
  } catch (error) {
    const isMissingFile =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (!isMissingFile) {
      throw error;
    }
  }

  return {};
};

export const writeHostRuntimeState = async (
  state: HostRuntimeState,
): Promise<HostRuntimeState> => {
  const statePath = getStatePath();
  const directoryPath = dirname(statePath);
  const normalizedActiveWorkspace = state.activeWorkspace?.trim();
  const normalizedActiveSkill = state.activeSkill?.trim();
  const payload: { active_workspace?: string; active_skill?: string } = {};

  if (normalizedActiveWorkspace && normalizedActiveWorkspace.length > 0) {
    payload.active_workspace = normalizedActiveWorkspace;
  }

  if (normalizedActiveSkill && normalizedActiveSkill.length > 0) {
    payload.active_skill = normalizedActiveSkill;
  }

  await mkdir(directoryPath, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const writtenState: HostRuntimeState = {};

  if (typeof payload.active_workspace === "string") {
    writtenState.activeWorkspace = payload.active_workspace;
  }

  if (typeof payload.active_skill === "string") {
    writtenState.activeSkill = payload.active_skill;
  }

  return writtenState;
};

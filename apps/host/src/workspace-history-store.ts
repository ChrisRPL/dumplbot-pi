import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const WORKSPACE_HISTORY_FILENAME = ".dumplbot-history.json";
const MAX_WORKSPACE_HISTORY_ENTRIES = 20;

export type WorkspaceRunRecord = {
  completedAt: string;
  prompt: string;
  transcript: string | null;
  skill: string;
  source: "text" | "audio";
  status: "success" | "error";
  summary: string;
};

type RawWorkspaceRunRecord = {
  completed_at?: unknown;
  prompt?: unknown;
  transcript?: unknown;
  skill?: unknown;
  source?: unknown;
  status?: unknown;
  summary?: unknown;
};

const getWorkspaceHistoryPath = (workspacePath: string): string =>
  join(workspacePath, WORKSPACE_HISTORY_FILENAME);

const trimWorkspaceHistory = (history: WorkspaceRunRecord[]): WorkspaceRunRecord[] =>
  history.slice(-MAX_WORKSPACE_HISTORY_ENTRIES);

const parseWorkspaceRunRecord = (entry: unknown): WorkspaceRunRecord => {
  if (!entry || typeof entry !== "object") {
    throw new Error("workspace history entry is invalid");
  }

  const rawEntry = entry as RawWorkspaceRunRecord;

  if (typeof rawEntry.completed_at !== "string" || rawEntry.completed_at.trim().length === 0) {
    throw new Error("workspace history entry is invalid");
  }

  if (typeof rawEntry.prompt !== "string") {
    throw new Error("workspace history entry is invalid");
  }

  if (rawEntry.transcript !== null && typeof rawEntry.transcript !== "string" && typeof rawEntry.transcript !== "undefined") {
    throw new Error("workspace history entry is invalid");
  }

  if (typeof rawEntry.skill !== "string" || rawEntry.skill.trim().length === 0) {
    throw new Error("workspace history entry is invalid");
  }

  if (rawEntry.source !== "text" && rawEntry.source !== "audio") {
    throw new Error("workspace history entry is invalid");
  }

  if (rawEntry.status !== "success" && rawEntry.status !== "error") {
    throw new Error("workspace history entry is invalid");
  }

  if (typeof rawEntry.summary !== "string" || rawEntry.summary.trim().length === 0) {
    throw new Error("workspace history entry is invalid");
  }

  return {
    completedAt: rawEntry.completed_at,
    prompt: rawEntry.prompt,
    transcript: typeof rawEntry.transcript === "string" ? rawEntry.transcript : null,
    skill: rawEntry.skill.trim(),
    source: rawEntry.source,
    status: rawEntry.status,
    summary: rawEntry.summary.trim(),
  };
};

export const loadWorkspaceHistory = async (
  workspacePath: string,
): Promise<WorkspaceRunRecord[]> => {
  const historyPath = getWorkspaceHistoryPath(workspacePath);

  try {
    const rawHistory = await readFile(historyPath, "utf8");
    const parsed = JSON.parse(rawHistory);

    if (!Array.isArray(parsed)) {
      throw new Error("workspace history is invalid");
    }

    return trimWorkspaceHistory(parsed.map(parseWorkspaceRunRecord));
  } catch (error) {
    const isMissingFile =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (isMissingFile) {
      return [];
    }

    throw error;
  }
};

export const recordWorkspaceRun = async (
  workspacePath: string,
  record: WorkspaceRunRecord,
): Promise<WorkspaceRunRecord[]> => {
  const historyPath = getWorkspaceHistoryPath(workspacePath);
  const history = await loadWorkspaceHistory(workspacePath);
  const nextHistory = trimWorkspaceHistory([
    ...history,
    record,
  ]);

  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(
    historyPath,
    `${JSON.stringify(nextHistory.map((entry) => ({
      completed_at: entry.completedAt,
      prompt: entry.prompt,
      transcript: entry.transcript,
      skill: entry.skill,
      source: entry.source,
      status: entry.status,
      summary: entry.summary,
    })), null, 2)}\n`,
    "utf8",
  );

  return nextHistory;
};

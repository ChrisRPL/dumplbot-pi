import { lstat, mkdir, readFile, realpath, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const WORKSPACE_CONFIG_FILENAME = ".dumplbot-workspace.json";
const WORKSPACE_REPOS_DIRNAME = "repos";
const WORKSPACE_REPO_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

export type WorkspaceRepoAttachment = {
  id: string;
  path: string;
  mountPath: string;
};

export type WorkspaceConfig = {
  defaultSkill: string | null;
  attachedRepos: WorkspaceRepoAttachment[];
};

type RawWorkspaceConfig = {
  default_skill?: unknown;
  attached_repos?: unknown;
};

const getWorkspaceConfigPath = (workspacePath: string): string =>
  join(workspacePath, WORKSPACE_CONFIG_FILENAME);

const getWorkspaceRepoMountPath = (repoId: string): string =>
  join(WORKSPACE_REPOS_DIRNAME, repoId);

export const normalizeWorkspaceRepoId = (repoId: string): string => {
  const normalizedRepoId = repoId.trim().toLowerCase();

  if (!WORKSPACE_REPO_ID_PATTERN.test(normalizedRepoId)) {
    throw new Error("workspace repo id is invalid");
  }

  return normalizedRepoId;
};

const normalizeWorkspaceRepoPath = async (repoPath: string): Promise<string> => {
  const trimmedRepoPath = repoPath.trim();

  if (!trimmedRepoPath || !isAbsolute(trimmedRepoPath)) {
    throw new Error("workspace repo path must be absolute");
  }

  return realpath(trimmedRepoPath);
};

const parseWorkspaceConfig = (workspacePath: string, raw: string): WorkspaceConfig => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("workspace config is invalid");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("workspace config is invalid");
  }

  const rawConfig = parsed as RawWorkspaceConfig;
  const defaultSkill = typeof rawConfig.default_skill === "string" && rawConfig.default_skill.trim().length > 0
    ? rawConfig.default_skill.trim()
    : null;
  const rawAttachedRepos = rawConfig.attached_repos;
  const attachedRepos: WorkspaceRepoAttachment[] = [];

  if (typeof rawAttachedRepos !== "undefined") {
    if (!Array.isArray(rawAttachedRepos)) {
      throw new Error("workspace config attached_repos must be array");
    }

    for (const entry of rawAttachedRepos) {
      if (!entry || typeof entry !== "object") {
        throw new Error("workspace config attached_repos entry is invalid");
      }

      const rawAttachment = entry as { id?: unknown; path?: unknown };

      if (typeof rawAttachment.id !== "string" || typeof rawAttachment.path !== "string") {
        throw new Error("workspace config attached_repos entry is invalid");
      }

      const repoId = normalizeWorkspaceRepoId(rawAttachment.id);
      const repoPath = resolve(rawAttachment.path.trim());

      if (!isAbsolute(repoPath)) {
        throw new Error("workspace config attached_repos path must be absolute");
      }

      if (attachedRepos.some((attachment) => attachment.id === repoId)) {
        throw new Error("workspace config attached_repos id must be unique");
      }

      attachedRepos.push({
        id: repoId,
        path: repoPath,
        mountPath: join(workspacePath, getWorkspaceRepoMountPath(repoId)),
      });
    }
  }

  return {
    defaultSkill,
    attachedRepos,
  };
};

export const loadWorkspaceConfig = async (workspacePath: string): Promise<WorkspaceConfig> => {
  const configPath = getWorkspaceConfigPath(workspacePath);

  try {
    const rawConfig = await readFile(configPath, "utf8");
    return parseWorkspaceConfig(workspacePath, rawConfig);
  } catch (error) {
    const isMissingFile =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (!isMissingFile) {
      throw error;
    }
  }

  return {
    defaultSkill: null,
    attachedRepos: [],
  };
};

export const writeWorkspaceConfig = async (
  workspacePath: string,
  config: WorkspaceConfig,
): Promise<WorkspaceConfig> => {
  const configPath = getWorkspaceConfigPath(workspacePath);
  const payload: { default_skill?: string; attached_repos?: Array<{ id: string; path: string }> } = {};

  if (config.defaultSkill && config.defaultSkill.trim().length > 0) {
    payload.default_skill = config.defaultSkill.trim();
  }

  if (config.attachedRepos.length > 0) {
    payload.attached_repos = config.attachedRepos.map((attachment) => ({
      id: attachment.id,
      path: attachment.path,
    }));
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return loadWorkspaceConfig(workspacePath);
};

export const ensureWorkspaceRepoAttachment = async (
  workspacePath: string,
  repoId: string,
  repoPath: string,
): Promise<WorkspaceRepoAttachment> => {
  const normalizedRepoId = normalizeWorkspaceRepoId(repoId);
  const normalizedRepoPath = await normalizeWorkspaceRepoPath(repoPath);
  const reposRoot = join(workspacePath, WORKSPACE_REPOS_DIRNAME);
  const mountPath = join(reposRoot, normalizedRepoId);

  await mkdir(reposRoot, { recursive: true });

  try {
    const existing = await lstat(mountPath);

    if (!existing.isSymbolicLink()) {
      throw new Error("workspace repo mount already exists");
    }

    const existingTarget = await readlink(mountPath);
    const existingPath = resolve(dirname(mountPath), existingTarget);

    if (existingPath !== normalizedRepoPath) {
      throw new Error("workspace repo mount already exists");
    }
  } catch (error) {
    const isMissingLink =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (!isMissingLink) {
      throw error;
    }

    await symlink(normalizedRepoPath, mountPath, "dir");
  }

  return {
    id: normalizedRepoId,
    path: normalizedRepoPath,
    mountPath,
  };
};

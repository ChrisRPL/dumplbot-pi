import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

const RESERVED_WORKSPACE_FILE_PREFIX = ".dumplbot-";
const RESERVED_WORKSPACE_ROOT_DIRS = new Set(["repos"]);

export type WorkspaceFileSummary = {
  path: string;
  size: number;
  updatedAt: string;
};

export type WorkspaceFile = WorkspaceFileSummary & {
  content: string;
};

const normalizeWorkspaceFilePath = (filePath: string): string => {
  const trimmedPath = filePath.trim();

  if (!trimmedPath) {
    throw new Error("workspace file path is required");
  }

  const normalizedPath = posix.normalize(trimmedPath.replaceAll("\\", "/"));

  if (
    normalizedPath === "."
    || normalizedPath.startsWith("../")
    || normalizedPath.includes("/../")
    || normalizedPath.startsWith("/")
  ) {
    throw new Error("workspace file path is invalid");
  }

  const segments = normalizedPath.split("/");

  if (segments[0] && RESERVED_WORKSPACE_ROOT_DIRS.has(segments[0])) {
    throw new Error("workspace file path is invalid");
  }

  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error("workspace file path is invalid");
    }

    if (segment.startsWith(RESERVED_WORKSPACE_FILE_PREFIX)) {
      throw new Error("workspace file path is invalid");
    }
  }

  return normalizedPath;
};

const isReservedWorkspaceEntry = (entryPath: string): boolean => {
  const segments = entryPath.split("/");

  if (segments.length === 0) {
    return false;
  }

  if (RESERVED_WORKSPACE_ROOT_DIRS.has(segments[0])) {
    return true;
  }

  return segments.some((segment) => segment.startsWith(RESERVED_WORKSPACE_FILE_PREFIX));
};

const buildWorkspaceFileSummary = async (
  workspacePath: string,
  relativePath: string,
): Promise<WorkspaceFileSummary> => {
  const normalizedPath = normalizeWorkspaceFilePath(relativePath);
  const fileStats = await stat(join(workspacePath, normalizedPath));

  if (!fileStats.isFile()) {
    throw new Error("workspace file not found");
  }

  return {
    path: normalizedPath,
    size: fileStats.size,
    updatedAt: fileStats.mtime.toISOString(),
  };
};

const walkWorkspaceFiles = async (
  workspacePath: string,
  relativePath = "",
): Promise<WorkspaceFileSummary[]> => {
  const directoryPath = relativePath
    ? join(workspacePath, relativePath)
    : workspacePath;
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  const files: WorkspaceFileSummary[] = [];

  for (const directoryEntry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    const nextRelativePath = relativePath
      ? `${relativePath}/${directoryEntry.name}`
      : directoryEntry.name;

    if (isReservedWorkspaceEntry(nextRelativePath)) {
      continue;
    }

    if (directoryEntry.isDirectory()) {
      files.push(...await walkWorkspaceFiles(workspacePath, nextRelativePath));
      continue;
    }

    if (!directoryEntry.isFile()) {
      continue;
    }

    files.push(await buildWorkspaceFileSummary(workspacePath, nextRelativePath));
  }

  return files;
};

export const listWorkspaceFiles = async (
  workspacePath: string,
): Promise<WorkspaceFileSummary[]> => {
  const files = await walkWorkspaceFiles(workspacePath);
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

export const readWorkspaceFile = async (
  workspacePath: string,
  filePath: string,
): Promise<WorkspaceFile> => {
  const normalizedPath = normalizeWorkspaceFilePath(filePath);
  const [content, summary] = await Promise.all([
    readFile(join(workspacePath, normalizedPath), "utf8").catch((error: unknown) => {
      const isMissingFile =
        error instanceof Error
        && "code" in error
        && error.code === "ENOENT";

      if (isMissingFile) {
        throw new Error("workspace file not found");
      }

      throw error;
    }),
    buildWorkspaceFileSummary(workspacePath, normalizedPath),
  ]);

  return {
    ...summary,
    content,
  };
};

export const writeWorkspaceFile = async (
  workspacePath: string,
  filePath: string,
  content: string,
): Promise<WorkspaceFile> => {
  const normalizedPath = normalizeWorkspaceFilePath(filePath);
  const destinationPath = join(workspacePath, normalizedPath);

  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, content, "utf8");

  return readWorkspaceFile(workspacePath, normalizedPath);
};

import { spawn } from "node:child_process";
import { once } from "node:events";

export type BashInvocation = {
  argv: string[];
  detail: string;
};

const BASH_PROMPT_PREFIX = "bash:";

const tokenizeCommandText = (commandText: string): string[] => {
  const tokens: string[] = [];
  let currentToken = "";
  let currentQuote: "'" | '"' | null = null;
  let tokenStarted = false;
  let escaping = false;

  for (const character of commandText) {
    if (escaping) {
      currentToken += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (currentQuote === "'") {
      if (character === "'") {
        currentQuote = null;
      } else {
        currentToken += character;
        tokenStarted = true;
      }

      continue;
    }

    if (currentQuote === '"') {
      if (character === '"') {
        currentQuote = null;
        continue;
      }

      if (character === "\\") {
        escaping = true;
        continue;
      }

      currentToken += character;
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      currentQuote = character;
      tokenStarted = true;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(currentToken);
        currentToken = "";
        tokenStarted = false;
      }

      continue;
    }

    currentToken += character;
    tokenStarted = true;
  }

  if (escaping || currentQuote) {
    throw new Error("runner bash command has invalid quoting");
  }

  if (tokenStarted) {
    tokens.push(currentToken);
  }

  return tokens;
};

const parseCommandPrefix = (allowedPrefix: string): string[] => {
  const parsedPrefix = tokenizeCommandText(allowedPrefix.trim());

  if (parsedPrefix.length === 0) {
    throw new Error("runner policy bash command prefix is invalid");
  }

  return parsedPrefix;
};

export const parseBashPrompt = (prompt: string): BashInvocation | null => {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt.startsWith(BASH_PROMPT_PREFIX)) {
    return null;
  }

  const commandText = trimmedPrompt.slice(BASH_PROMPT_PREFIX.length).trim();

  if (commandText.length === 0) {
    throw new Error("runner bash command is required");
  }

  const argv = tokenizeCommandText(commandText);

  if (argv.length === 0) {
    throw new Error("runner bash command is required");
  }

  return {
    argv,
    detail: commandText,
  };
};

export const commandMatchesAllowedPrefix = (
  argv: string[],
  allowedPrefix: string,
): boolean => {
  const prefixArgv = parseCommandPrefix(allowedPrefix);

  if (argv.length < prefixArgv.length) {
    return false;
  }

  return prefixArgv.every((token, index) => argv[index] === token);
};

export const executeCommand = async (
  argv: string[],
): Promise<{ stdout: string; stderr: string }> => {
  const child = spawn(argv[0] as string, argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let childErrorMessage: string | null = null;

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.on("error", (error) => {
    childErrorMessage = error.message;
  });

  const [exitCode, signal] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];

  if (childErrorMessage) {
    throw new Error(`runner bash command failed to start: ${childErrorMessage}`);
  }

  if (signal) {
    throw new Error(`runner bash command exited from signal ${signal}`);
  }

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  if (exitCode && exitCode !== 0) {
    const detail = (stderr || stdout).trim();
    const suffix = detail.length > 0 ? `: ${detail}` : "";
    throw new Error(`runner bash command failed with code ${exitCode}${suffix}`);
  }

  return {
    stdout,
    stderr,
  };
};

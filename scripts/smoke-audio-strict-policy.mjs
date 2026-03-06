#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4137;
const SSE_DELIMITER = "\n\n";
const WAVE_BYTES = Buffer.from("RIFFtestWAVEfmt ");

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const parseSsePayload = (payload) =>
  payload
    .split(SSE_DELIMITER)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      let eventType = "message";
      let data = {};

      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
          data = JSON.parse(line.slice("data: ".length));
        }
      }

      return { eventType, data };
    });

const waitForServerReady = (childProcess) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("host server did not start in time"));
    }, 8000);

    const onData = (chunk) => {
      const text = chunk.toString("utf8");

      if (text.includes("dumplbotd listening")) {
        clearTimeout(timeout);
        childProcess.stdout.off("data", onData);
        resolve();
      }
    };

    childProcess.stdout.on("data", onData);
    childProcess.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`host server exited early: ${code ?? "unknown"}`));
    });
  });

const startHostServer = async (tmpRoot, workspaceRoot, skillsRoot, configPath) => {
  const childProcess = spawn(
    process.execPath,
    ["dist/apps/host/src/main.js"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DUMPLBOT_HOST: HOST,
        DUMPLBOT_PORT: String(HOST_PORT),
        DUMPLBOT_TMP_ROOT: tmpRoot,
        DUMPLBOT_WORKSPACES_ROOT: workspaceRoot,
        DUMPLBOT_SKILLS_ROOT: skillsRoot,
        DUMPLBOT_CONFIG_PATH: configPath,
        DUMPLBOT_SANDBOX_ENABLED: "false",
      },
    },
  );

  await waitForServerReady(childProcess);
  return childProcess;
};

const stopHostServer = async (childProcess) => {
  if (childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill("SIGINT");
  await new Promise((resolve) => {
    childProcess.once("exit", resolve);
    setTimeout(() => resolve(), 3000);
  });
};

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-audio-strict-policy-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const skillsRoot = join(tmpRoot, "skills");
  const configPath = join(tmpRoot, "config.yaml");
  const defaultWorkspaceRoot = join(workspaceRoot, "default");
  const strictSkillRoot = join(skillsRoot, "strict-bash");

  await mkdir(defaultWorkspaceRoot, { recursive: true });
  await mkdir(strictSkillRoot, { recursive: true });
  await writeFile(join(defaultWorkspaceRoot, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(
    join(strictSkillRoot, "skill.yaml"),
    [
      "id: strict-bash",
      "prompt_prelude: |",
      "  strict mode fixture",
      "tool_allowlist:",
      "  - read_file",
      "  - bash",
      "permission_mode: strict",
      "model:",
      "  reasoning: medium",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    configPath,
    [
      "runtime:",
      "  default_workspace: default",
      "  default_skill: strict-bash",
      "",
    ].join("\n"),
    "utf8",
  );

  const hostServer = await startHostServer(tmpRoot, workspaceRoot, skillsRoot, configPath);
  const baseUrl = `http://${HOST}:${HOST_PORT}`;

  try {
    const uploadForm = new FormData();
    uploadForm.append("file", new File([WAVE_BYTES], "sample.wav", { type: "audio/wav" }));
    const uploadResponse = await fetch(`${baseUrl}/api/audio`, {
      method: "POST",
      body: uploadForm,
    });
    assert(uploadResponse.status === 200, "expected /api/audio upload to return 200");
    const uploadPayload = await uploadResponse.json();

    const talkResponse = await fetch(`${baseUrl}/api/audio/${uploadPayload.audio_id}/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: ["bash"] }),
    });
    assert(talkResponse.status === 200, "expected /api/audio/:id/talk to return 200 SSE");

    const events = parseSsePayload(await talkResponse.text());
    const statusEvents = events.filter((event) => event.eventType === "status");
    const errorEvents = events.filter((event) => event.eventType === "error");
    const doneEvents = events.filter((event) => event.eventType === "done");
    const sttEvents = events.filter((event) => event.eventType === "stt");

    assert(statusEvents.length === 1, "expected exactly one status event");
    assert(
      statusEvents[0].data?.phase === "policy",
      "expected policy phase status event",
    );
    assert(errorEvents.length === 1, "expected exactly one terminal error event");
    assert(
      errorEvents[0].data?.code === "policy_mode_denied",
      "expected policy_mode_denied error code",
    );
    assert(
      errorEvents[0].data?.message === "strict mode does not allow requested tools",
      "unexpected strict mode denial message",
    );
    assert(doneEvents.length === 0, "unexpected done event for strict mode denial");
    assert(sttEvents.length === 0, "unexpected stt event for strict mode denial");

    console.log("audio strict policy smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

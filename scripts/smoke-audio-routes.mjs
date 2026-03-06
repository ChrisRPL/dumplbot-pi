#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4123;
const STT_PORT = 4124;
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

const startFakeSttServer = async () => {
  const fakeServer = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/audio/transcriptions") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: "smoke route transcript" }));
    });
  });

  await new Promise((resolve, reject) => {
    fakeServer.once("error", reject);
    fakeServer.listen(STT_PORT, HOST, resolve);
  });

  return fakeServer;
};

const startHostServer = async (tmpRoot, workspaceRoot) => {
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
        DUMPLBOT_SANDBOX_ENABLED: "false",
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: `http://${HOST}:${STT_PORT}`,
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

const uploadAudio = async (baseUrl, fileName, contentType) => {
  const form = new FormData();
  form.append("file", new File([WAVE_BYTES], fileName, { type: contentType }));

  return fetch(`${baseUrl}/api/audio`, {
    method: "POST",
    body: form,
  });
};

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-audio-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const wavePath = join(tmpRoot, "sample.wav");
  const defaultWorkspaceRoot = join(workspaceRoot, "default");

  await mkdir(defaultWorkspaceRoot, { recursive: true });
  await writeFile(join(defaultWorkspaceRoot, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(wavePath, WAVE_BYTES);
  const fakeSttServer = await startFakeSttServer();
  const hostServer = await startHostServer(tmpRoot, workspaceRoot);
  const baseUrl = `http://${HOST}:${HOST_PORT}`;

  try {
    const goodUpload = await uploadAudio(baseUrl, "sample.wav", "audio/wav");
    assert(goodUpload.ok, `audio upload failed: ${goodUpload.status}`);
    const uploadJson = await goodUpload.json();
    assert(typeof uploadJson.audio_id === "string", "audio upload missing audio_id");

    const badUpload = await uploadAudio(baseUrl, "sample.txt", "text/plain");
    assert(badUpload.status === 400, `expected 400 for bad upload, got ${badUpload.status}`);

    const transcribeResponse = await fetch(
      `${baseUrl}/api/audio/${uploadJson.audio_id}/transcribe`,
      { method: "POST" },
    );
    assert(transcribeResponse.ok, `audio transcribe failed: ${transcribeResponse.status}`);
    const transcribeJson = await transcribeResponse.json();
    assert(
      transcribeJson.text === "smoke route transcript",
      "unexpected transcribe text",
    );

    const talkResponse = await fetch(
      `${baseUrl}/api/audio/${uploadJson.audio_id}/talk`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "default", skill: "coding" }),
      },
    );
    assert(talkResponse.ok, `audio talk failed: ${talkResponse.status}`);
    const talkSse = await talkResponse.text();
    const events = parseSsePayload(talkSse);

    assert(events.length >= 4, "expected at least four SSE events");
    assert(events[0].eventType === "status", "missing initial status event");
    assert(
      events[0].data.message === "Transcribing audio",
      "unexpected initial status message",
    );
    assert(events[1].eventType === "stt", "missing stt event");
    assert(events[1].data.text === "smoke route transcript", "unexpected stt text");
    assert(events.some((event) => event.eventType === "done"), "missing done event");

    const missingTalkResponse = await fetch(
      `${baseUrl}/api/talk`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "ping", workspace: "missing" }),
      },
    );
    assert(
      missingTalkResponse.status === 404,
      `expected 404 for missing /api/talk workspace, got ${missingTalkResponse.status}`,
    );

    const missingAudioTalkResponse = await fetch(
      `${baseUrl}/api/audio/${uploadJson.audio_id}/talk`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "missing", skill: "coding" }),
      },
    );
    assert(
      missingAudioTalkResponse.status === 404,
      `expected 404 for missing /api/audio/:id/talk workspace, got ${missingAudioTalkResponse.status}`,
    );

    const transcriptPath = join(tmpRoot, "last-transcript.txt");
    const transcriptText = await readFile(transcriptPath, "utf8");
    assert(
      transcriptText === "smoke route transcript",
      "last transcript was not stored",
    );

    console.log("audio route smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await new Promise((resolve) => fakeSttServer.close(resolve));
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

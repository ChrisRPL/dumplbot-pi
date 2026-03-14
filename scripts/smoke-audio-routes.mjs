#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

const readPngDimensions = async (filePath) => {
  const pngBytes = await readFile(filePath);
  assert(pngBytes.length >= 24, "expected png file to contain header");
  assert(
    pngBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "expected png signature",
  );
  return {
    width: pngBytes.readUInt32BE(16),
    height: pngBytes.readUInt32BE(20),
  };
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
  let transcriptionRequestCount = 0;

  const fakeServer = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/audio/transcriptions") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    request.resume();
    request.on("end", () => {
      transcriptionRequestCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        text: transcriptionRequestCount === 3
          ? ""
          : "smoke route transcript",
      }));
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

const runUiCommand = (baseUrl, ...args) => {
  const result = spawnSync(
    "python3",
    ["apps/ui/dumpl_ui.py", "--mock", "--host-url", baseUrl, ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      timeout: 8000,
    },
  );

  if (result.error) {
    throw result.error;
  }

  return result;
};

const runPreviewSnapshot = (baseUrl, outputPath, ...args) => {
  const result = spawnSync(
    "python3",
    ["apps/ui/dumpl_ui.py", "--host-url", baseUrl, "--preview-snapshot", outputPath, ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      timeout: 8000,
    },
  );

  if (result.error) {
    throw result.error;
  }

  return result;
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

    const debugVoiceResponse = await fetch(`${baseUrl}/api/debug/voice`);
    assert(debugVoiceResponse.ok, `debug voice route failed: ${debugVoiceResponse.status}`);
    const debugVoiceJson = await debugVoiceResponse.json();
    assert(debugVoiceJson.transcript.present === true, "expected debug transcript presence");
    assert(debugVoiceJson.transcript.text === "smoke route transcript", "unexpected debug transcript text");
    assert(
      typeof debugVoiceJson.transcript.path === "string" && debugVoiceJson.transcript.path.endsWith("last-transcript.txt"),
      "unexpected debug transcript path",
    );
    assert(typeof debugVoiceJson.transcript.updated_at === "string", "expected debug transcript timestamp");
    assert(debugVoiceJson.audio.present === true, "expected debug audio presence");
    assert(
      typeof debugVoiceJson.audio.path === "string" && debugVoiceJson.audio.path.endsWith("last-audio.wav"),
      "unexpected debug audio path",
    );
    assert(debugVoiceJson.audio.size_bytes === WAVE_BYTES.length, "unexpected debug audio size");
    assert(typeof debugVoiceJson.audio.updated_at === "string", "expected debug audio timestamp");
    assert(debugVoiceJson.error.present === false, "expected empty debug error before failure");

    const transcriptScreenResult = runUiCommand(baseUrl, "--transcript-screen");
    assert(transcriptScreenResult.status === 0, "expected transcript screen to return 0");
    assert(
      transcriptScreenResult.stdout.includes("Mock UI | Diagnostics"),
      "expected transcript screen header",
    );
    assert(
      transcriptScreenResult.stdout.includes("Last transcript"),
      "expected transcript screen status",
    );
    assert(
      transcriptScreenResult.stdout.includes("smoke route transcript"),
      "expected transcript screen text",
    );
    assert(
      transcriptScreenResult.stdout.includes("age: "),
      "expected transcript screen age summary",
    );

    const audioScreenResult = runUiCommand(baseUrl, "--audio-screen");
    assert(audioScreenResult.status === 0, "expected audio screen to return 0");
    assert(
      audioScreenResult.stdout.includes("Mock UI | Diagnostics"),
      "expected audio screen header",
    );
    assert(
      audioScreenResult.stdout.includes("Last audio"),
      "expected audio screen status",
    );
    assert(
      audioScreenResult.stdout.includes("last-audio.wav"),
      "expected audio screen path",
    );
    assert(
      audioScreenResult.stdout.includes(`size: ${WAVE_BYTES.length} B`),
      "expected audio screen size",
    );
    assert(
      audioScreenResult.stdout.includes("age: "),
      "expected audio screen age summary",
    );

    const homeTranscriptViewResult = runUiCommand(
      baseUrl,
      "--home-nav-mode",
      "home",
      "--home-nav-target",
      "transcript",
      "--home-nav-action",
      "toggle-view",
    );
    assert(homeTranscriptViewResult.status === 0, "expected home transcript toggle to return 0");
    assert(
      homeTranscriptViewResult.stdout.includes("smoke route transcript"),
      "expected home transcript toggle to render transcript screen",
    );

    const homeAudioViewResult = runUiCommand(
      baseUrl,
      "--home-nav-mode",
      "home",
      "--home-nav-target",
      "audio",
      "--home-nav-action",
      "toggle-view",
    );
    assert(homeAudioViewResult.status === 0, "expected home audio toggle to return 0");
    assert(
      homeAudioViewResult.stdout.includes("last-audio.wav"),
      "expected home audio toggle to render audio screen",
    );

    const transcriptPreviewPath = join(tmpRoot, "preview-transcript.png");
    const transcriptPreviewResult = runPreviewSnapshot(baseUrl, transcriptPreviewPath, "--transcript-screen");
    assert(transcriptPreviewResult.status === 0, "expected transcript preview snapshot to return 0");
    const transcriptPreviewDimensions = await readPngDimensions(transcriptPreviewPath);
    assert(transcriptPreviewDimensions.width === 510, "expected transcript preview width");
    assert(transcriptPreviewDimensions.height === 960, "expected transcript preview height");

    const audioPreviewPath = join(tmpRoot, "preview-audio.png");
    const audioPreviewResult = runPreviewSnapshot(baseUrl, audioPreviewPath, "--audio-screen");
    assert(audioPreviewResult.status === 0, "expected audio preview snapshot to return 0");
    const audioPreviewDimensions = await readPngDimensions(audioPreviewPath);
    assert(audioPreviewDimensions.width === 510, "expected audio preview width");
    assert(audioPreviewDimensions.height === 960, "expected audio preview height");

    const failedTalkResponse = await fetch(
      `${baseUrl}/api/audio/${uploadJson.audio_id}/talk`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "default", skill: "coding" }),
      },
    );
    assert(failedTalkResponse.ok, `failed audio talk returned ${failedTalkResponse.status}`);
    const failedTalkEvents = parseSsePayload(await failedTalkResponse.text());
    const failedTalkErrorEvent = failedTalkEvents.find((event) => event.eventType === "error");
    assert(failedTalkErrorEvent, "expected failed audio talk error event");
    assert(
      failedTalkErrorEvent.data.message === "transcription returned empty text",
      "unexpected failed audio talk error message",
    );

    const debugVoiceErrorResponse = await fetch(`${baseUrl}/api/debug/voice`);
    assert(debugVoiceErrorResponse.ok, `debug voice error route failed: ${debugVoiceErrorResponse.status}`);
    const debugVoiceErrorJson = await debugVoiceErrorResponse.json();
    assert(debugVoiceErrorJson.error.present === true, "expected debug error presence after failed talk");
    assert(debugVoiceErrorJson.error.source === "audio-talk", "unexpected debug error source");
    assert(
      debugVoiceErrorJson.error.message === "transcription returned empty text",
      "unexpected debug error message",
    );
    assert(
      typeof debugVoiceErrorJson.error.path === "string" && debugVoiceErrorJson.error.path.endsWith("last-error.json"),
      "unexpected debug error path",
    );
    assert(typeof debugVoiceErrorJson.error.updated_at === "string", "expected debug error timestamp");

    const errorScreenResult = runUiCommand(baseUrl, "--error-screen");
    assert(errorScreenResult.status === 0, "expected error screen to return 0");
    assert(
      errorScreenResult.stdout.includes("Last error"),
      "expected error screen status",
    );
    assert(
      errorScreenResult.stdout.includes("source: audio-talk"),
      "expected error screen source",
    );
    assert(
      errorScreenResult.stdout.includes("transcription returned empty text"),
      "expected error screen message",
    );
    assert(
      errorScreenResult.stdout.includes("age: "),
      "expected error screen age summary",
    );

    const homeErrorViewResult = runUiCommand(
      baseUrl,
      "--home-nav-mode",
      "home",
      "--home-nav-target",
      "error",
      "--home-nav-action",
      "toggle-view",
    );
    assert(homeErrorViewResult.status === 0, "expected home error toggle to return 0");
    assert(
      homeErrorViewResult.stdout.includes("transcription returned empty text"),
      "expected home error toggle to render error screen",
    );

    const voiceDebugScreenResult = runUiCommand(baseUrl, "--voice-debug-screen");
    const normalizedVoiceDebugOutput = voiceDebugScreenResult.stdout.replace(/\s+/g, " ");
    assert(voiceDebugScreenResult.status === 0, "expected voice debug screen to return 0");
    assert(
      voiceDebugScreenResult.stdout.includes("Voice debug"),
      "expected voice debug screen status",
    );
    assert(
      voiceDebugScreenResult.stdout.includes("err: audio-talk"),
      "expected voice debug screen error summary",
    );
    assert(
      normalizedVoiceDebugOutput.includes("error: transcription returne"),
      "expected voice debug screen error message",
    );

    const errorPreviewPath = join(tmpRoot, "preview-error.png");
    const errorPreviewResult = runPreviewSnapshot(baseUrl, errorPreviewPath, "--error-screen");
    assert(errorPreviewResult.status === 0, "expected error preview snapshot to return 0");
    const errorPreviewDimensions = await readPngDimensions(errorPreviewPath);
    assert(errorPreviewDimensions.width === 510, "expected error preview width");
    assert(errorPreviewDimensions.height === 960, "expected error preview height");

    const voiceDebugPreviewPath = join(tmpRoot, "preview-voice-debug.png");
    const voiceDebugPreviewResult = runPreviewSnapshot(baseUrl, voiceDebugPreviewPath, "--voice-debug-screen");
    assert(voiceDebugPreviewResult.status === 0, "expected voice debug preview snapshot to return 0");
    const voiceDebugPreviewDimensions = await readPngDimensions(voiceDebugPreviewPath);
    assert(voiceDebugPreviewDimensions.width === 510, "expected voice debug preview width");
    assert(voiceDebugPreviewDimensions.height === 960, "expected voice debug preview height");

    const clearDebugResponse = await fetch(`${baseUrl}/api/debug/voice/clear`, {
      method: "POST",
    });
    assert(clearDebugResponse.ok, `debug voice clear route failed: ${clearDebugResponse.status}`);
    const clearDebugJson = await clearDebugResponse.json();
    assert(clearDebugJson.transcript.present === false, "expected cleared transcript state");
    assert(clearDebugJson.audio.present === false, "expected cleared audio state");
    assert(clearDebugJson.error.present === false, "expected cleared error state");

    const clearedTranscriptScreenResult = runUiCommand(baseUrl, "--transcript-screen");
    assert(clearedTranscriptScreenResult.status === 0, "expected cleared transcript screen to return 0");
    assert(
      clearedTranscriptScreenResult.stdout.includes("No transcript captured"),
      "expected cleared transcript screen empty state",
    );

    const clearedErrorScreenResult = runUiCommand(baseUrl, "--error-screen");
    assert(clearedErrorScreenResult.status === 0, "expected cleared error screen to return 0");
    assert(
      clearedErrorScreenResult.stdout.includes("No error captured"),
      "expected cleared error screen empty state",
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

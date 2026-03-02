import type { IncomingHttpHeaders } from "node:http";

const HEADER_DELIMITER = Buffer.from("\r\n\r\n");
const LINE_DELIMITER = "\r\n";
const WAV_CONTENT_TYPES = new Set([
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
]);

const getMultipartBoundary = (contentTypeHeader: string | undefined): string => {
  if (!contentTypeHeader) {
    throw new Error("content-type header is required");
  }

  const segments = contentTypeHeader.split(";").map((segment) => segment.trim());
  const mediaType = segments[0]?.toLowerCase();

  if (mediaType !== "multipart/form-data") {
    throw new Error("content-type must be multipart/form-data");
  }

  const boundarySegment = segments.find((segment) => segment.startsWith("boundary="));

  if (!boundarySegment) {
    throw new Error("multipart boundary is required");
  }

  const boundary = boundarySegment.slice("boundary=".length).replace(/^"|"$/g, "");

  if (!boundary) {
    throw new Error("multipart boundary is invalid");
  }

  return boundary;
};

const parsePartHeaders = (headerBlock: string): Map<string, string> => {
  const headers = new Map<string, string>();

  for (const rawLine of headerBlock.split(LINE_DELIMITER)) {
    const separatorIndex = rawLine.indexOf(":");

    if (separatorIndex <= 0) {
      throw new Error("multipart part header is invalid");
    }

    const name = rawLine.slice(0, separatorIndex).trim().toLowerCase();
    const value = rawLine.slice(separatorIndex + 1).trim();
    headers.set(name, value);
  }

  return headers;
};

const validateWavPartHeaders = (headers: Map<string, string>): void => {
  const disposition = headers.get("content-disposition");
  const contentType = headers.get("content-type")?.toLowerCase();

  if (!disposition || !disposition.includes("form-data") || !disposition.includes("filename=")) {
    throw new Error("multipart upload must include one file part");
  }

  if (!contentType || !WAV_CONTENT_TYPES.has(contentType)) {
    throw new Error("uploaded file must be audio/wav");
  }
};

const validateWavBuffer = (audioBuffer: Buffer): void => {
  if (audioBuffer.length < 12) {
    throw new Error("uploaded wav is too small");
  }

  if (audioBuffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("uploaded file is not a RIFF wav");
  }

  if (audioBuffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("uploaded file is not a WAVE file");
  }
};

export const readRequestBuffer = async (request: AsyncIterable<Buffer | string>): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

export const parseSingleWavUpload = (
  headers: IncomingHttpHeaders,
  body: Buffer,
): Buffer => {
  const boundary = getMultipartBoundary(headers["content-type"]);
  const delimiter = Buffer.from(`--${boundary}`);
  const bodyStart = delimiter.toString("latin1") + LINE_DELIMITER;
  const bodyText = body.toString("latin1");

  if (!bodyText.startsWith(bodyStart)) {
    throw new Error("multipart body does not start with boundary");
  }

  const headerStart = Buffer.byteLength(bodyStart, "latin1");
  const headerEnd = body.indexOf(HEADER_DELIMITER, headerStart);

  if (headerEnd < 0) {
    throw new Error("multipart part headers are incomplete");
  }

  const headerBlock = body.toString("utf8", headerStart, headerEnd);
  const partHeaders = parsePartHeaders(headerBlock);
  validateWavPartHeaders(partHeaders);

  const fileStart = headerEnd + HEADER_DELIMITER.length;
  const trailingDelimiter = Buffer.from(`\r\n--${boundary}`);
  const fileEnd = body.indexOf(trailingDelimiter, fileStart);

  if (fileEnd < 0) {
    throw new Error("multipart file body is incomplete");
  }

  const audioBuffer = body.subarray(fileStart, fileEnd);
  const closing = body.subarray(fileEnd + 2, body.length).toString("latin1");

  if (closing !== `--${boundary}--\r\n` && closing !== `--${boundary}--`) {
    throw new Error("multipart upload must contain exactly one file part");
  }

  validateWavBuffer(audioBuffer);
  return audioBuffer;
};

import fs from "node:fs";

const CHUNK_SIZE = 16 * 1024;
const NEWLINE = 0x0a;

export interface ParsedTranscriptLine {
  message?: unknown;
  type?: string;
  timestamp?: unknown;
}

/** Extract epoch-ms timestamp from a parsed JSONL line. Returns null if unavailable. */
function extractTimestamp(parsed: ParsedTranscriptLine): number | null {
  // Top-level timestamp (used in readLastMessageTimestampFromOpenTranscript)
  const raw = parsed.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  // Message-level timestamp
  const msg = parsed.message as Record<string, unknown> | undefined;
  if (msg) {
    const msgTs = msg.timestamp;
    if (typeof msgTs === "number" && Number.isFinite(msgTs)) return msgTs;
    if (typeof msgTs === "string") {
      const ms = Date.parse(msgTs);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

function isMessageLine(parsed: ParsedTranscriptLine): boolean {
  return parsed.message != null;
}

function tryParseLine(line: string): ParsedTranscriptLine | null {
  try {
    return JSON.parse(line) as ParsedTranscriptLine;
  } catch {
    return null;
  }
}

/**
 * Read forward from a byte offset, collecting up to `limit` message lines.
 * Returns parsed message objects (the `.message` field) and the total lines scanned.
 */
export function readMessagesForward(
  fd: number,
  startOffset: number,
  fileSize: number,
  limit: number,
): { messages: unknown[]; linesScanned: number } {
  const messages: unknown[] = [];
  let linesScanned = 0;
  let offset = startOffset;
  let partial = "";

  while (offset < fileSize && messages.length < limit) {
    const toRead = Math.min(CHUNK_SIZE, fileSize - offset);
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, offset);
    offset += toRead;

    const chunk = partial + buf.toString("utf-8");
    const lines = chunk.split("\n");
    // Last element may be partial if we haven't reached EOF
    partial = offset < fileSize ? (lines.pop() ?? "") : "";

    for (const line of lines) {
      if (!line.trim()) continue;
      linesScanned++;
      const parsed = tryParseLine(line);
      if (parsed && isMessageLine(parsed)) {
        messages.push(parsed.message);
        if (messages.length >= limit) break;
      }
    }
  }

  // Handle any remaining partial line at EOF
  if (partial.trim() && messages.length < limit) {
    linesScanned++;
    const parsed = tryParseLine(partial);
    if (parsed && isMessageLine(parsed)) {
      messages.push(parsed.message);
    }
  }

  return { messages, linesScanned };
}

/**
 * Scan forward from `offset` to find the start of the next complete line.
 * Returns the byte offset right after the next newline, or `offset` if already at line start (offset === 0).
 */
function alignToNextLine(fd: number, offset: number, fileSize: number): number {
  if (offset === 0) return 0;
  let pos = offset;
  const buf = Buffer.alloc(1);
  while (pos < fileSize) {
    fs.readSync(fd, buf, 0, 1, pos);
    pos++;
    if (buf[0] === NEWLINE) return pos;
  }
  return fileSize;
}

/**
 * Read the first complete line starting at or after `offset`.
 * Returns the parsed line and the byte offset after that line, or null if no valid line found.
 */
function readLineAt(
  fd: number,
  offset: number,
  fileSize: number,
): { parsed: ParsedTranscriptLine; lineEnd: number } | null {
  const lineStart = alignToNextLine(fd, offset, fileSize);
  if (lineStart >= fileSize) return null;

  let pos = lineStart;
  let accumulated = "";
  while (pos < fileSize) {
    const toRead = Math.min(CHUNK_SIZE, fileSize - pos);
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, pos);
    const chunk = buf.toString("utf-8");
    const nlIdx = chunk.indexOf("\n");
    if (nlIdx >= 0) {
      accumulated += chunk.slice(0, nlIdx);
      const lineEnd = pos + Buffer.byteLength(chunk.slice(0, nlIdx + 1), "utf-8");
      const parsed = tryParseLine(accumulated);
      return parsed ? { parsed, lineEnd } : null;
    }
    accumulated += chunk;
    pos += toRead;
  }
  // Last line without trailing newline
  const parsed = tryParseLine(accumulated);
  return parsed ? { parsed, lineEnd: fileSize } : null;
}

/**
 * Binary search the JSONL file for the first message line at or after `targetMs`.
 * Returns the byte offset to start reading from.
 */
export function seekToTimestamp(fd: number, fileSize: number, targetMs: number): number {
  if (fileSize === 0) return 0;

  let lo = 0;
  let hi = fileSize;
  let bestOffset = 0; // fallback: start of file

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const line = readLineAt(fd, mid, fileSize);
    if (!line) {
      // No parseable line from mid onward, narrow from below
      lo = mid + 1;
      continue;
    }

    const ts = extractTimestamp(line.parsed);
    if (ts === null) {
      // No timestamp on this line; skip forward
      lo = line.lineEnd;
      continue;
    }

    if (ts < targetMs) {
      lo = line.lineEnd;
    } else {
      // This line is at or after target — it could be the answer
      bestOffset = alignToNextLine(fd, mid, fileSize);
      hi = mid;
    }
  }

  return bestOffset;
}

/**
 * Find byte offset that is `offset` message lines before the end of file.
 * Reads backward from EOF counting message lines.
 * Returns the byte offset to start reading forward from.
 *
 * Strategy: scan backward for newline bytes to find line boundaries,
 * then parse each line to check if it's a message. Track byte offsets directly.
 */
export function seekFromEnd(fd: number, fileSize: number, offset: number): number {
  if (fileSize === 0 || offset <= 0) return fileSize;

  // Collect byte offsets of message line starts by scanning backward for newlines.
  // messageStartOffsets[0] = last message, [1] = second-to-last, etc.
  // We need exactly `offset` entries; the last one is where to start reading.
  const messageStartOffsets: number[] = [];
  let pos = fileSize;
  let prevWasNewline = true;
  let lineStart = fileSize;

  while (pos > 0 && messageStartOffsets.length < offset) {
    const toRead = Math.min(CHUNK_SIZE, pos);
    const readStart = pos - toRead;
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, readStart);

    // Scan bytes in reverse for newlines
    for (let i = toRead - 1; i >= 0; i--) {
      if (buf[i] === NEWLINE) {
        if (!prevWasNewline) {
          // We just found the end of a line; lineStart marks where this line begins
          // The line content is from lineStart to the position just before this newline
          // Actually, lineStart is the byte after the previous newline we found
          const lineEnd = readStart + i + 1; // byte after this newline
          // lineStart was set when we last saw a newline or at file end
          // Read and check the line from lineEnd to lineStart
          checkAndCollectMessage(fd, lineEnd, lineStart, messageStartOffsets, offset);
        }
        lineStart = readStart + i + 1;
        prevWasNewline = true;
      } else {
        prevWasNewline = false;
      }
    }

    pos = readStart;
  }

  // Handle the very first line (no leading newline)
  if (messageStartOffsets.length < offset && !prevWasNewline && lineStart > 0) {
    checkAndCollectMessage(fd, 0, lineStart, messageStartOffsets, offset);
  }

  if (messageStartOffsets.length === 0) return fileSize;
  if (messageStartOffsets.length < offset) return 0;
  // The last collected offset is the `offset`th message from end — start reading there
  return messageStartOffsets[messageStartOffsets.length - 1];
}

function checkAndCollectMessage(
  fd: number,
  lineByteStart: number,
  lineByteEnd: number,
  collected: number[],
  maxCollect: number,
): void {
  if (collected.length >= maxCollect) return;
  const len = lineByteEnd - lineByteStart;
  if (len <= 0) return;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, lineByteStart);
  const line = buf.toString("utf-8").trim();
  if (!line) return;
  const parsed = tryParseLine(line);
  if (parsed && isMessageLine(parsed)) {
    collected.push(lineByteStart);
  }
}

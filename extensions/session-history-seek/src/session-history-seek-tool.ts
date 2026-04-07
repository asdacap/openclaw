import fs from "node:fs";
import { Type } from "@sinclair/typebox";
import {
  type AnyAgentTool,
  type OpenClawPluginApi,
  capArrayByJsonBytes,
  jsonUtf8Bytes,
  redactSensitiveText,
  truncateUtf16Safe,
} from "../api.js";
import { readMessagesForward, seekFromEnd, seekToTimestamp } from "./jsonl-seek.js";

const SESSIONS_HISTORY_MAX_BYTES = 80 * 1024;
const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4000;

const SessionHistorySeekSchema = Type.Object({
  sessionKey: Type.String({ description: "Session key to read history from" }),
  limit: Type.Number({ minimum: 1, description: "Max number of messages to return" }),
  offset: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Skip this many messages from the end, then read forward. 0 = start from the last message.",
    }),
  ),
  startTime: Type.Optional(
    Type.String({
      description: "ISO 8601 timestamp — seek to this point, then read limit messages forward.",
    }),
  ),
});

function truncateHistoryText(text: string): {
  text: string;
  truncated: boolean;
  redacted: boolean;
} {
  const sanitized = redactSensitiveText(text);
  const redacted = sanitized !== text;
  if (sanitized.length <= SESSIONS_HISTORY_TEXT_MAX_CHARS) {
    return { text: sanitized, truncated: false, redacted };
  }
  const cut = truncateUtf16Safe(sanitized, SESSIONS_HISTORY_TEXT_MAX_CHARS);
  return { text: `${cut}\n…(truncated)…`, truncated: true, redacted };
}

function sanitizeContentBlock(block: unknown): {
  block: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!block || typeof block !== "object") return { block, truncated: false, redacted: false };
  const entry = { ...(block as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;
  const type = typeof entry.type === "string" ? entry.type : "";

  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (type === "thinking") {
    if (typeof entry.thinking === "string") {
      const res = truncateHistoryText(entry.thinking);
      entry.thinking = res.text;
      truncated ||= res.truncated;
      redacted ||= res.redacted;
    }
    if ("thinkingSignature" in entry) {
      delete entry.thinkingSignature;
      truncated = true;
    }
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  if (type === "image") {
    const data = typeof entry.data === "string" ? entry.data : undefined;
    const bytes = data ? data.length : undefined;
    if ("data" in entry) {
      delete entry.data;
      truncated = true;
    }
    entry.omitted = true;
    if (bytes !== undefined) entry.bytes = bytes;
  }
  return { block: entry, truncated, redacted };
}

function sanitizeMessage(message: unknown): {
  message: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!message || typeof message !== "object")
    return { message, truncated: false, redacted: false };
  const entry = { ...(message as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;

  if ("details" in entry) {
    delete entry.details;
    truncated = true;
  }
  if ("usage" in entry) {
    delete entry.usage;
    truncated = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    truncated = true;
  }

  if (typeof entry.content === "string") {
    const res = truncateHistoryText(entry.content);
    entry.content = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block: unknown) => sanitizeContentBlock(block));
    entry.content = updated.map((item) => item.block);
    truncated ||= updated.some((item) => item.truncated);
    redacted ||= updated.some((item) => item.redacted);
  }
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  return { message: entry, truncated, redacted };
}

function enforceHardCap(params: { items: unknown[]; bytes: number; maxBytes: number }): {
  items: unknown[];
  bytes: number;
  hardCapped: boolean;
} {
  if (params.bytes <= params.maxBytes) {
    return { items: params.items, bytes: params.bytes, hardCapped: false };
  }
  const last = params.items.at(-1);
  const lastOnly = last ? [last] : [];
  const lastBytes = jsonUtf8Bytes(lastOnly);
  if (lastBytes <= params.maxBytes) {
    return { items: lastOnly, bytes: lastBytes, hardCapped: true };
  }
  const placeholder = [
    { role: "assistant", content: "[sessions_history_seek omitted: message too large]" },
  ];
  return { items: placeholder, bytes: jsonUtf8Bytes(placeholder), hardCapped: true };
}

function jsonResult(payload: unknown): {
  content: Array<{ type: string; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export function createSessionHistorySeekTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    label: "Session History Seek",
    name: "sessions_history_seek",
    description:
      "Read session history with seeking support. Use `offset` to skip N messages from the end and read forward, or `startTime` to seek to a timestamp. Only one of offset/startTime may be provided.",
    parameters: SessionHistorySeekSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
      if (!sessionKey)
        return jsonResult({ status: "invalid_params", error: "sessionKey is required" });

      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : 50;

      const offset =
        typeof params.offset === "number" && Number.isFinite(params.offset)
          ? Math.max(0, Math.floor(params.offset))
          : undefined;

      const startTime = typeof params.startTime === "string" ? params.startTime.trim() : undefined;

      if (offset !== undefined && startTime !== undefined) {
        return jsonResult({
          status: "invalid_params",
          error: "offset and startTime are mutually exclusive",
        });
      }

      let startTimeMs: number | undefined;
      if (startTime) {
        startTimeMs = Date.parse(startTime);
        if (!Number.isFinite(startTimeMs)) {
          return jsonResult({
            status: "invalid_params",
            error: "startTime must be a valid ISO 8601 timestamp",
          });
        }
      }

      // Resolve transcript file path via plugin runtime
      const storePath = api.runtime.agent.session.resolveStorePath();
      const store = api.runtime.agent.session.loadSessionStore(storePath);
      const entry = store[sessionKey] as { sessionId?: string; sessionFile?: string } | undefined;
      if (!entry?.sessionId) {
        return jsonResult({ status: "not_found", error: `Unknown session key: ${sessionKey}` });
      }
      const filePath = api.runtime.agent.session.resolveSessionFilePath(entry.sessionId, entry);
      if (!filePath || !fs.existsSync(filePath)) {
        return jsonResult({ status: "not_found", error: "Session transcript not found" });
      }

      const fd = fs.openSync(filePath, "r");
      try {
        const stat = fs.fstatSync(fd);
        const fileSize = stat.size;
        if (fileSize === 0) {
          return jsonResult({ sessionKey, messages: [], totalReturned: 0 });
        }

        let seekOffset: number;
        if (startTimeMs !== undefined) {
          seekOffset = seekToTimestamp(fd, fileSize, startTimeMs);
        } else if (offset !== undefined && offset > 0) {
          seekOffset = seekFromEnd(fd, fileSize, offset);
        } else {
          // Default: read from end (offset=0 means last messages)
          // For offset=0, we want the last `limit` messages — seek from end by `limit`
          seekOffset = seekFromEnd(fd, fileSize, limit);
        }

        const { messages } = readMessagesForward(fd, seekOffset, fileSize, limit);

        // Sanitize
        const sanitized = messages.map((m) => sanitizeMessage(m));
        const contentTruncated = sanitized.some((e) => e.truncated);
        const contentRedacted = sanitized.some((e) => e.redacted);
        const capped = capArrayByJsonBytes(
          sanitized.map((e) => e.message),
          SESSIONS_HISTORY_MAX_BYTES,
        );
        const droppedMessages = capped.items.length < messages.length;
        const hardened = enforceHardCap({
          items: capped.items,
          bytes: capped.bytes,
          maxBytes: SESSIONS_HISTORY_MAX_BYTES,
        });

        return jsonResult({
          sessionKey,
          messages: hardened.items,
          totalReturned: hardened.items.length,
          truncated: droppedMessages || contentTruncated || hardened.hardCapped,
          droppedMessages: droppedMessages || hardened.hardCapped,
          contentTruncated,
          contentRedacted,
          bytes: hardened.bytes,
        });
      } finally {
        fs.closeSync(fd);
      }
    },
  } as AnyAgentTool;
}

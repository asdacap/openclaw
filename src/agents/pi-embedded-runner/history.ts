import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { formatDurationSince } from "../current-time.js";
import { normalizeProviderId } from "../provider-id.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 * For channel/group sessions, uses historyLimit from provider config.
 */
export function getHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: OpenClawConfig | undefined,
): number | undefined {
  if (!sessionKey || !config) {
    return undefined;
  }

  const parts = sessionKey.split(":").filter(Boolean);
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = normalizeProviderId(providerParts[0] ?? "");
  if (!provider) {
    return undefined;
  }

  const kind = providerParts[1]?.toLowerCase();
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);

  const resolveProviderConfig = (
    cfg: OpenClawConfig | undefined,
    providerId: string,
  ):
    | {
        historyLimit?: number;
        dmHistoryLimit?: number;
        dms?: Record<string, { historyLimit?: number }>;
      }
    | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") {
      return undefined;
    }
    for (const [configuredProviderId, value] of Object.entries(
      channels as Record<string, unknown>,
    )) {
      if (normalizeProviderId(configuredProviderId) !== providerId) {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      return value as {
        historyLimit?: number;
        dmHistoryLimit?: number;
        dms?: Record<string, { historyLimit?: number }>;
      };
    }
    return undefined;
  };

  const providerConfig = resolveProviderConfig(config, provider);
  if (!providerConfig) {
    return undefined;
  }

  // For DM sessions: per-DM override -> dmHistoryLimit.
  // Accept both "direct" (new) and "dm" (legacy) for backward compat.
  if (kind === "dm" || kind === "direct") {
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== undefined) {
      return providerConfig.dms[userId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  }

  // For channel/group sessions: use historyLimit from provider config
  // This prevents context overflow in long-running channel sessions
  if (kind === "channel" || kind === "group") {
    return providerConfig.historyLimit;
  }

  return undefined;
}

/**
 * @deprecated Use getHistoryLimitFromSessionKey instead.
 * Alias for backward compatibility.
 */
export const getDmHistoryLimitFromSessionKey = getHistoryLimitFromSessionKey;

export function parseMessageTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

const TEMPORAL_MARKER_PREFIX = "[";
const TEMPORAL_MARKER_SUFFIX = " since last interaction]";
const DEFAULT_MIN_GAP_MS = 60_000; // 1 minute

function extractTextContent(msg: AgentMessage): string | undefined {
  const user = msg as Extract<AgentMessage, { role: "user" }>;
  if (typeof user.content === "string") {
    return user.content;
  }
  if (!Array.isArray(user.content)) {
    return undefined;
  }
  const textBlock = user.content.find(
    (block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  ) as { type: "text"; text: string } | undefined;
  return textBlock?.text;
}

function hasTemporalMarker(text: string): boolean {
  return text.startsWith(TEMPORAL_MARKER_PREFIX) && text.includes(TEMPORAL_MARKER_SUFFIX);
}

function buildTemporalMarker(durationText: string): string {
  return `${TEMPORAL_MARKER_PREFIX}${durationText}${TEMPORAL_MARKER_SUFFIX}`;
}

/**
 * Injects temporal markers into user messages at turn boundaries so the model
 * understands how much time passed between turns. Follows the same content
 * prepend pattern as annotateInterSessionUserMessages().
 */
export function injectTurnTemporalMarkers(
  messages: AgentMessage[],
  options?: {
    /** Minimum gap in ms to inject a marker. Default: 60_000 (1 minute) */
    minGapMs?: number;
    /** Current time for computing duration of the latest gap. Default: Date.now() */
    nowMs?: number;
  },
): AgentMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  const minGapMs = options?.minGapMs ?? DEFAULT_MIN_GAP_MS;
  let touched = false;
  const out: AgentMessage[] = [];
  let lastSeenTimestamp: number | null = null;

  for (const msg of messages) {
    const msgTs = parseMessageTimestamp((msg as { timestamp?: unknown }).timestamp);

    // At a turn boundary (user message), check for a time gap
    if (msg.role === "user" && lastSeenTimestamp !== null && msgTs !== null) {
      const gap = msgTs - lastSeenTimestamp;
      if (gap >= minGapMs) {
        const duration = formatDurationSince(lastSeenTimestamp, msgTs);
        if (duration && duration !== "just now") {
          const marker = buildTemporalMarker(duration);
          const existingText = extractTextContent(msg);
          // Skip if already has a temporal marker
          if (existingText === undefined || !hasTemporalMarker(existingText)) {
            if (typeof msg.content === "string") {
              touched = true;
              out.push({
                ...(msg as unknown as Record<string, unknown>),
                content: `${marker}\n${msg.content}`,
              } as AgentMessage);
              lastSeenTimestamp = msgTs;
              continue;
            }
            if (Array.isArray(msg.content)) {
              const textIndex = msg.content.findIndex(
                (block) =>
                  block &&
                  typeof block === "object" &&
                  (block as { type?: unknown }).type === "text" &&
                  typeof (block as { text?: unknown }).text === "string",
              );
              if (textIndex >= 0) {
                const existingBlock = msg.content[textIndex] as { type: "text"; text: string };
                const nextContent = [...msg.content];
                nextContent[textIndex] = {
                  ...existingBlock,
                  text: `${marker}\n${existingBlock.text}`,
                };
                touched = true;
                out.push({
                  ...(msg as unknown as Record<string, unknown>),
                  content: nextContent,
                } as AgentMessage);
                lastSeenTimestamp = msgTs;
                continue;
              }
              // No text block found — prepend one
              touched = true;
              out.push({
                ...(msg as unknown as Record<string, unknown>),
                content: [{ type: "text", text: marker }, ...msg.content],
              } as AgentMessage);
              lastSeenTimestamp = msgTs;
              continue;
            }
          }
        }
      }
    }

    out.push(msg);
    if (msgTs !== null) {
      lastSeenTimestamp = msgTs;
    }
  }

  return touched ? out : messages;
}

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  getHistoryLimitFromSessionKey,
  injectTurnTemporalMarkers,
  parseMessageTimestamp,
} from "./history.js";

describe("getHistoryLimitFromSessionKey", () => {
  it("matches channel history limits across canonical provider aliases", () => {
    expect(
      getHistoryLimitFromSessionKey("agent:main:z-ai:channel:general", {
        channels: {
          "z.ai": {
            historyLimit: 17,
          },
        },
      }),
    ).toBe(17);
  });
});

describe("parseMessageTimestamp", () => {
  it("returns number timestamps as-is", () => {
    expect(parseMessageTimestamp(1700000000000)).toBe(1700000000000);
  });

  it("parses ISO string timestamps", () => {
    expect(parseMessageTimestamp("2026-04-04T13:00:00.000Z")).toBe(
      Date.parse("2026-04-04T13:00:00.000Z"),
    );
  });

  it("returns null for invalid values", () => {
    expect(parseMessageTimestamp(undefined)).toBeNull();
    expect(parseMessageTimestamp(null)).toBeNull();
    expect(parseMessageTimestamp("not-a-date")).toBeNull();
    expect(parseMessageTimestamp(NaN)).toBeNull();
    expect(parseMessageTimestamp(Infinity)).toBeNull();
  });
});

describe("injectTurnTemporalMarkers", () => {
  function msg(
    role: string,
    content: string | Array<{ type: string; text: string }>,
    timestampMs: number,
  ): AgentMessage {
    return { role, content, timestamp: timestampMs } as unknown as AgentMessage;
  }

  it("returns the same array reference when no changes are needed", () => {
    const messages: AgentMessage[] = [];
    expect(injectTurnTemporalMarkers(messages)).toBe(messages);
  });

  it("returns the same array reference when all gaps are below threshold", () => {
    const messages = [
      msg("user", "hello", 1000),
      msg("assistant", "hi", 2000),
      msg("user", "ok", 30_000), // 29s gap, below 60s default
    ];
    expect(injectTurnTemporalMarkers(messages)).toBe(messages);
  });

  it("injects marker for string content when gap exceeds threshold", () => {
    const t0 = Date.parse("2026-04-01T10:00:00Z");
    const t1 = t0 + 1000; // assistant reply 1s later
    const t2 = t1 + 3 * 3_600_000; // 3 hours after assistant reply
    const messages = [
      msg("user", "hello", t0),
      msg("assistant", "hi", t1),
      msg("user", "what's new?", t2),
    ];
    const result = injectTurnTemporalMarkers(messages);
    expect(result).not.toBe(messages);
    expect(result[0]).toBe(messages[0]); // first msg unchanged
    expect(result[1]).toBe(messages[1]); // assistant unchanged
    const modifiedContent = (result[2] as { content: string }).content;
    expect(modifiedContent).toContain("[3 hours since last interaction]");
    expect(modifiedContent).toContain("what's new?");
  });

  it("injects marker for array content when gap exceeds threshold", () => {
    const t0 = Date.parse("2026-04-01T10:00:00Z");
    const t1 = t0 + 1000; // assistant reply 1s later
    const t2 = t1 + 2 * 24 * 3_600_000; // 2 days after assistant reply
    const messages = [
      msg("user", [{ type: "text", text: "hello" }], t0),
      msg("assistant", "hi", t1),
      msg("user", [{ type: "text", text: "what's new?" }], t2),
    ];
    const result = injectTurnTemporalMarkers(messages);
    expect(result).not.toBe(messages);
    const modifiedContent = (result[2] as { content: Array<{ type: string; text: string }> })
      .content;
    expect(modifiedContent[0].text).toContain("[2 days since last interaction]");
    expect(modifiedContent[0].text).toContain("what's new?");
  });

  it("prepends text block for array content without text", () => {
    const t0 = Date.parse("2026-04-01T10:00:00Z");
    const t1 = t0 + 1000; // assistant reply 1s later
    const t2 = t1 + 5 * 60_000; // 5 minutes after assistant reply
    const messages = [
      msg("user", "hello", t0),
      msg("assistant", "hi", t1),
      msg(
        "user",
        [{ type: "image", text: "" }] as unknown as Array<{ type: string; text: string }>,
        t2,
      ),
    ];
    const result = injectTurnTemporalMarkers(messages);
    const modifiedContent = (result[2] as { content: Array<{ type: string; text?: string }> })
      .content;
    expect(modifiedContent.length).toBe(2);
    expect(modifiedContent[0].type).toBe("text");
    expect(modifiedContent[0].text).toContain("[5 minutes since last interaction]");
  });

  it("does not double-inject markers", () => {
    const t0 = Date.parse("2026-04-01T10:00:00Z");
    const t1 = t0 + 1000;
    const t2 = t0 + 3 * 3_600_000;
    const messages = [
      msg("user", "hello", t0),
      msg("assistant", "hi", t1),
      msg("user", "[3 hours since last interaction]\nwhat's new?", t2),
    ];
    const result = injectTurnTemporalMarkers(messages);
    expect(result).toBe(messages); // no change since already prefixed
  });

  it("skips markers when timestamps are missing", () => {
    const messages = [
      { role: "user", content: "hello" } as unknown as AgentMessage,
      { role: "assistant", content: "hi" } as unknown as AgentMessage,
      { role: "user", content: "ok" } as unknown as AgentMessage,
    ];
    expect(injectTurnTemporalMarkers(messages)).toBe(messages);
  });

  it("handles multiple turns with different gap durations", () => {
    const t0 = Date.parse("2026-04-01T10:00:00Z");
    const t1 = t0 + 1000; // assistant reply 1s later
    const t2 = t1 + 5 * 60_000; // 5 minutes after assistant reply
    const t3 = t2 + 1000; // assistant reply 1s later
    const t4 = t3 + 2 * 24 * 3_600_000; // 2 days after assistant reply
    const messages = [
      msg("user", "first", t0),
      msg("assistant", "reply1", t1),
      msg("user", "second", t2),
      msg("assistant", "reply2", t3),
      msg("user", "third", t4),
    ];
    const result = injectTurnTemporalMarkers(messages);
    // First user message: no marker (no previous turn)
    expect((result[0] as { content: string }).content).toBe("first");
    // Second user message: 5 minute gap -> marker
    expect((result[2] as { content: string }).content).toContain(
      "[5 minutes since last interaction]",
    );
    // Third user message: 2 day gap -> marker
    expect((result[4] as { content: string }).content).toContain("[2 days since last interaction]");
  });

  it("respects custom minGapMs", () => {
    const t0 = Date.parse("2026-04-01T10:00:00Z");
    const t1 = t0 + 1000;
    const t2 = t0 + 5 * 60_000; // 5 minutes later
    const messages = [msg("user", "hello", t0), msg("assistant", "hi", t1), msg("user", "ok", t2)];
    // With 10 minute threshold, 5 min gap should not trigger marker
    expect(injectTurnTemporalMarkers(messages, { minGapMs: 10 * 60_000 })).toBe(messages);
    // With 1 minute threshold, 5 min gap should trigger marker
    const result = injectTurnTemporalMarkers(messages, { minGapMs: 60_000 });
    expect(result).not.toBe(messages);
    expect((result[2] as { content: string }).content).toContain("since last interaction");
  });
});

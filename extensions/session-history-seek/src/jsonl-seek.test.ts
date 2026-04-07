import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMessagesForward, seekFromEnd, seekToTimestamp } from "./jsonl-seek.js";

function makeLine(role: string, text: string, timestamp?: number): string {
  const message: Record<string, unknown> = { role, content: text };
  if (timestamp !== undefined) message.timestamp = timestamp;
  return JSON.stringify({ message, timestamp });
}

function makeHeader(sessionId: string): string {
  return JSON.stringify({ type: "session", version: 1, id: sessionId });
}

function makeCompaction(timestamp?: string): string {
  return JSON.stringify({ type: "compaction", ...(timestamp ? { timestamp } : {}) });
}

function writeJsonl(dir: string, name: string, lines: string[]): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

function openAndSize(filePath: string): { fd: number; size: number } {
  const fd = fs.openSync(filePath, "r");
  const size = fs.fstatSync(fd).size;
  return { fd, size };
}

describe("jsonl-seek", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-seek-test-"));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readMessagesForward", () => {
    it("reads messages from start of file, skipping non-message lines", () => {
      const filePath = writeJsonl(tmpDir, "forward-basic.jsonl", [
        makeHeader("s1"),
        makeLine("user", "hello", 1000),
        makeLine("assistant", "hi", 2000),
        makeCompaction(),
        makeLine("user", "how are you", 3000),
      ]);
      const { fd, size } = openAndSize(filePath);
      try {
        const { messages } = readMessagesForward(fd, 0, size, 10);
        expect(messages).toHaveLength(3);
        expect((messages[0] as Record<string, unknown>).content).toBe("hello");
        expect((messages[2] as Record<string, unknown>).content).toBe("how are you");
      } finally {
        fs.closeSync(fd);
      }
    });

    it("respects limit parameter", () => {
      const filePath = writeJsonl(tmpDir, "forward-limit.jsonl", [
        makeLine("user", "m1", 1000),
        makeLine("assistant", "m2", 2000),
        makeLine("user", "m3", 3000),
      ]);
      const { fd, size } = openAndSize(filePath);
      try {
        const { messages } = readMessagesForward(fd, 0, size, 2);
        expect(messages).toHaveLength(2);
        expect((messages[0] as Record<string, unknown>).content).toBe("m1");
        expect((messages[1] as Record<string, unknown>).content).toBe("m2");
      } finally {
        fs.closeSync(fd);
      }
    });

    it("returns empty array for empty file", () => {
      const filePath = path.join(tmpDir, "forward-empty.jsonl");
      fs.writeFileSync(filePath, "", "utf-8");
      const { fd, size } = openAndSize(filePath);
      try {
        const { messages } = readMessagesForward(fd, 0, size, 10);
        expect(messages).toHaveLength(0);
      } finally {
        fs.closeSync(fd);
      }
    });

    it("skips malformed JSON lines", () => {
      const filePath = writeJsonl(tmpDir, "forward-malformed.jsonl", [
        makeLine("user", "good", 1000),
        "not valid json {{{",
        makeLine("assistant", "also good", 2000),
      ]);
      const { fd, size } = openAndSize(filePath);
      try {
        const { messages } = readMessagesForward(fd, 0, size, 10);
        expect(messages).toHaveLength(2);
      } finally {
        fs.closeSync(fd);
      }
    });
  });

  describe("seekToTimestamp", () => {
    it.each([
      {
        name: "finds first message at target time",
        timestamps: [1000, 2000, 3000, 4000, 5000],
        targetMs: 3000,
        expectedFirstContent: "m3",
      },
      {
        name: "returns start of file when target is before all messages",
        timestamps: [1000, 2000, 3000],
        targetMs: 500,
        expectedFirstContent: "m1",
      },
      {
        name: "returns near end when target is between last two",
        timestamps: [1000, 2000, 3000],
        targetMs: 2500,
        expectedFirstContent: "m3",
      },
    ])("$name", ({ timestamps, targetMs, expectedFirstContent }) => {
      const lines = timestamps.map((ts, i) => makeLine("user", `m${i + 1}`, ts));
      const filePath = writeJsonl(tmpDir, `ts-${targetMs}.jsonl`, lines);
      const { fd, size } = openAndSize(filePath);
      try {
        const offset = seekToTimestamp(fd, size, targetMs);
        const { messages } = readMessagesForward(fd, offset, size, 1);
        expect(messages).toHaveLength(1);
        expect((messages[0] as Record<string, unknown>).content).toBe(expectedFirstContent);
      } finally {
        fs.closeSync(fd);
      }
    });

    it("returns start of file for empty file", () => {
      const filePath = path.join(tmpDir, "ts-empty.jsonl");
      fs.writeFileSync(filePath, "", "utf-8");
      const { fd, size } = openAndSize(filePath);
      try {
        expect(seekToTimestamp(fd, size, 1000)).toBe(0);
      } finally {
        fs.closeSync(fd);
      }
    });

    it("handles file with non-message lines mixed in", () => {
      const lines = [
        makeHeader("s1"),
        makeLine("user", "m1", 1000),
        makeCompaction("2025-01-01T00:00:00.000Z"),
        makeLine("assistant", "m2", 2000),
        makeLine("user", "m3", 3000),
      ];
      const filePath = writeJsonl(tmpDir, "ts-mixed.jsonl", lines);
      const { fd, size } = openAndSize(filePath);
      try {
        const offset = seekToTimestamp(fd, size, 2000);
        const { messages } = readMessagesForward(fd, offset, size, 10);
        expect(messages.length).toBeGreaterThanOrEqual(1);
        // Should include m2 (timestamp 2000) onward
        const contents = messages.map((m) => (m as Record<string, unknown>).content);
        expect(contents).toContain("m2");
      } finally {
        fs.closeSync(fd);
      }
    });
  });

  describe("seekFromEnd", () => {
    it.each([
      {
        name: "offset 0 returns fileSize (no skip)",
        messageCount: 5,
        offset: 0,
        expectedFirstMsg: null, // readMessagesForward from fileSize returns nothing
      },
      {
        name: "offset 3 skips 3 messages from end, starts at m3",
        messageCount: 5,
        offset: 3,
        expectedFirstMsg: "m3",
      },
      {
        name: "offset exceeding total returns start of file",
        messageCount: 3,
        offset: 100,
        expectedFirstMsg: "m1",
      },
      {
        name: "offset equal to total returns start",
        messageCount: 3,
        offset: 3,
        expectedFirstMsg: "m1",
      },
    ])("$name", ({ messageCount, offset, expectedFirstMsg }) => {
      const lines = Array.from({ length: messageCount }, (_, i) =>
        makeLine("user", `m${i + 1}`, (i + 1) * 1000),
      );
      const filePath = writeJsonl(tmpDir, `end-${messageCount}-${offset}.jsonl`, lines);
      const { fd, size } = openAndSize(filePath);
      try {
        const seekPos = seekFromEnd(fd, size, offset);
        const { messages } = readMessagesForward(fd, seekPos, size, messageCount);
        if (expectedFirstMsg === null) {
          expect(messages).toHaveLength(0);
        } else {
          expect(messages.length).toBeGreaterThan(0);
          expect((messages[0] as Record<string, unknown>).content).toBe(expectedFirstMsg);
        }
      } finally {
        fs.closeSync(fd);
      }
    });

    it("handles file with header and compaction lines", () => {
      const lines = [
        makeHeader("s1"),
        makeLine("user", "m1", 1000),
        makeCompaction(),
        makeLine("assistant", "m2", 2000),
        makeLine("user", "m3", 3000),
      ];
      const filePath = writeJsonl(tmpDir, "end-mixed.jsonl", lines);
      const { fd, size } = openAndSize(filePath);
      try {
        const seekPos = seekFromEnd(fd, size, 2);
        const { messages } = readMessagesForward(fd, seekPos, size, 10);
        // offset=2 with 3 messages: [total-offset] = [1] = m2
        expect((messages[0] as Record<string, unknown>).content).toBe("m2");
      } finally {
        fs.closeSync(fd);
      }
    });

    it("returns 0 for empty file", () => {
      const filePath = path.join(tmpDir, "end-empty.jsonl");
      fs.writeFileSync(filePath, "", "utf-8");
      const { fd, size } = openAndSize(filePath);
      try {
        expect(seekFromEnd(fd, size, 5)).toBe(0);
      } finally {
        fs.closeSync(fd);
      }
    });
  });
});

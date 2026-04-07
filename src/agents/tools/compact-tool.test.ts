import { describe, expect, it, vi } from "vitest";

vi.mock("../pi-embedded-runner/compact.runtime.js", () => ({
  compactEmbeddedPiSessionDirect: vi.fn(),
}));

vi.mock("../../plugins/memory-state.js", () => ({
  resolveMemoryFlushPlan: vi.fn(() => null),
}));

vi.mock("../../auto-reply/reply/memory-flush.js", () => ({
  hasAlreadyFlushedForCurrentCompaction: vi.fn(() => false),
}));

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  resolveStorePath: vi.fn(() => "/tmp/store"),
}));

vi.mock("../../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
}));

const { compactEmbeddedPiSessionDirect } = await import("../pi-embedded-runner/compact.runtime.js");
const { createCompactTool } = await import("./compact-tool.js");

const baseOpts = {
  sessionId: "test-session-id",
  sessionKey: "agent:main:test",
  sessionFile: "/tmp/session.jsonl",
  workspaceDir: "/tmp/workspace",
};

describe("createCompactTool", () => {
  it("has correct tool metadata", () => {
    const tool = createCompactTool(baseOpts);
    expect(tool.name).toBe("compact");
    expect(tool.label).toBe("Compact");
    expect(tool.ownerOnly).toBeUndefined();
  });

  it("returns compacted status with token counts on success", async () => {
    vi.mocked(compactEmbeddedPiSessionDirect).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 150000,
        tokensAfter: 50000,
        summary: "Summary",
        firstKeptEntryId: "e1",
      },
    });

    const tool = createCompactTool(baseOpts);
    const result = await tool.execute("call-1", {});

    expect(result.details).toEqual({
      status: "compacted",
      tokensBefore: 150000,
      tokensAfter: 50000,
      memoryFlushed: false,
    });
    expect(compactEmbeddedPiSessionDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "test-session-id",
        trigger: "manual",
      }),
    );
  });

  it("returns skipped when nothing to compact", async () => {
    vi.mocked(compactEmbeddedPiSessionDirect).mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "Nothing to compact",
    });

    const tool = createCompactTool(baseOpts);
    const result = await tool.execute("call-2", {});

    expect(result.details).toEqual({
      status: "skipped",
      reason: "Nothing to compact",
      memoryFlushed: false,
    });
  });

  it("returns failed on compaction error", async () => {
    vi.mocked(compactEmbeddedPiSessionDirect).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "Below threshold",
    });

    const tool = createCompactTool(baseOpts);
    const result = await tool.execute("call-3", {});

    expect(result.details).toEqual({
      status: "failed",
      reason: "Below threshold",
      memoryFlushed: false,
    });
  });

  it("passes custom instructions to compaction", async () => {
    vi.mocked(compactEmbeddedPiSessionDirect).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 100000,
        tokensAfter: 40000,
        summary: "Summary",
        firstKeptEntryId: "e2",
      },
    });

    const tool = createCompactTool(baseOpts);
    await tool.execute("call-4", { instructions: "Preserve the database schema" });

    expect(compactEmbeddedPiSessionDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        customInstructions: "Preserve the database schema",
      }),
    );
  });

  it("catches thrown errors gracefully", async () => {
    vi.mocked(compactEmbeddedPiSessionDirect).mockRejectedValueOnce(
      new Error("Connection refused"),
    );

    const tool = createCompactTool(baseOpts);
    const result = await tool.execute("call-5", {});

    expect(result.details).toEqual({
      status: "error",
      reason: "Connection refused",
      memoryFlushed: false,
    });
  });
});

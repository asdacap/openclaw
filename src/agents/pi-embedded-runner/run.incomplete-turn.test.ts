import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  extractPlanningOnlyPlanDetails,
  isLikelyExecutionAckPrompt,
  resolveAckExecutionFastPathInstruction,
  resolvePlanningOnlyRetryInstruction,
  resolveThinkingOnlyRetryInstruction,
} from "./run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent incomplete-turn safety", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("warns before retrying when an incomplete turn already sent a message", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          stopReason: "toolUse",
          errorMessage: "internal retry interrupted tool execution",
          provider: "openai",
          model: "mock-1",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-incomplete-turn-messaging-warning",
    });

    expect(mockedClassifyFailoverReason).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("verify before retrying");
  });

  it("detects replay-safe planning-only GPT turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("does not retry planning-only detection after tool activity", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
        toolMetas: [{ toolName: "bash", meta: "ls" }],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not retry planning-only detection after an item has started", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 0,
          activeCount: 1,
        },
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("detects short execution approval prompts", () => {
    expect(isLikelyExecutionAckPrompt("ok do it")).toBe(true);
    expect(isLikelyExecutionAckPrompt("go ahead")).toBe(true);
    expect(isLikelyExecutionAckPrompt("Can you do it?")).toBe(false);
  });

  it("detects short execution approvals across requested locales", () => {
    expect(isLikelyExecutionAckPrompt("نفذها")).toBe(true);
    expect(isLikelyExecutionAckPrompt("mach es")).toBe(true);
    expect(isLikelyExecutionAckPrompt("進めて")).toBe(true);
    expect(isLikelyExecutionAckPrompt("fais-le")).toBe(true);
    expect(isLikelyExecutionAckPrompt("adelante")).toBe(true);
    expect(isLikelyExecutionAckPrompt("vai em frente")).toBe(true);
    expect(isLikelyExecutionAckPrompt("진행해")).toBe(true);
  });

  it("adds an ack-turn fast-path instruction for GPT action turns", () => {
    const instruction = resolveAckExecutionFastPathInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "go ahead",
    });

    expect(instruction).toContain("Do not recap or restate the plan");
  });

  it("extracts structured steps from planning-only narration", () => {
    expect(
      extractPlanningOnlyPlanDetails(
        "I'll inspect the code. Then I'll patch the issue. Finally I'll run tests.",
      ),
    ).toEqual({
      explanation: "I'll inspect the code. Then I'll patch the issue. Finally I'll run tests.",
      steps: ["I'll inspect the code.", "Then I'll patch the issue.", "Finally I'll run tests."],
    });
  });

  // ── Thinking-only retry detection ──────────────────────────────────────

  it("detects thinking-only turn (reasoning but no text)", () => {
    const instruction = resolveThinkingOnlyRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          stopReason: "stop",
          content: [{ type: "thinking", thinking: "Let me analyze this..." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(instruction).toContain("no visible reply");
  });

  it("does not trigger thinking-only retry when text is present", () => {
    const instruction = resolveThinkingOnlyRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Here is my response."],
        lastAssistant: {
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "Let me analyze this..." },
            { type: "text", text: "Here is my response." },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(instruction).toBeNull();
  });

  it("does not trigger thinking-only retry for empty response without thinking", () => {
    const instruction = resolveThinkingOnlyRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          stopReason: "stop",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(instruction).toBeNull();
  });

  it("does not trigger thinking-only retry after messaging tool sent", () => {
    const instruction = resolveThinkingOnlyRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          stopReason: "stop",
          content: [{ type: "thinking", thinking: "Reasoning..." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(instruction).toBeNull();
  });

  it("retries thinking-only turn in the run loop", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);

    // First attempt: thinking-only (no text).
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          stopReason: "stop",
          content: [{ type: "thinking", thinking: "Let me think about this..." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    // Second attempt: normal response.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Here is the answer."],
        lastAssistant: {
          stopReason: "stop",
          content: [{ type: "text", text: "Here is the answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-thinking-only-retry",
    });

    // The runner retried: two attempt calls instead of one.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry thinking-only turn when config sets max attempts to 0", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          stopReason: "stop",
          content: [{ type: "thinking", thinking: "Reasoning only..." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-thinking-only-disabled",
      config: {
        agents: { defaults: { llm: { thinkingOnlyRetryMaxAttempts: 0 } } },
      } as unknown as typeof overflowBaseRunParams extends { config?: infer C } ? C : never,
    });

    // Should only call the attempt once (no retry).
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    // No visible text → empty payloads.
    expect(result.payloads?.some((p) => p.text?.includes("Here is the answer"))).toBeFalsy();
  });
});

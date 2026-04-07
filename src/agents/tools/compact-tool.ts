import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { logWarn } from "../../logger.js";
import { COMPACT_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const CompactToolSchema = Type.Object({
  instructions: Type.Optional(
    Type.String({
      description: "Optional instructions for what to preserve or focus on during compaction.",
    }),
  ),
  flushMemory: Type.Optional(
    Type.Boolean({
      description:
        "When true, run a memory flush before compacting to persist salient context to disk.",
    }),
  ),
});

export type CompactToolOptions = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfig;
  senderIsOwner?: boolean;
  allowGatewaySubagentBinding?: boolean;
};

/** Default timeout for a memory flush agent run (5 minutes). */
const MEMORY_FLUSH_TIMEOUT_MS = 5 * 60 * 1000;

export function createCompactTool(opts: CompactToolOptions): AnyAgentTool {
  return {
    label: "Compact",
    name: "compact_context",
    displaySummary: COMPACT_TOOL_DISPLAY_SUMMARY,
    description:
      "Trigger context compaction to reduce token usage. " +
      "Use when the context is getting large and you want to proactively free up space. " +
      "Optionally flush memory first to persist important context before compacting. " +
      "Returns token counts before and after compaction.",
    parameters: CompactToolSchema,
    execute: async (_toolCallId, args) => {
      if (!opts.sessionId || !opts.sessionFile) {
        const missing = [!opts.sessionId && "sessionId", !opts.sessionFile && "sessionFile"].filter(
          Boolean,
        );
        return jsonResult({
          status: "error",
          reason: `Compaction is not available: missing ${missing.join(" and ")}.`,
        });
      }

      const params = args as Record<string, unknown>;
      const instructions = readStringParam(params, "instructions");
      const flushMemory = params.flushMemory === true;

      let memoryFlushed = false;
      if (flushMemory) {
        try {
          const { resolveMemoryFlushPlan } = await import("../../plugins/memory-state.js");
          const { hasAlreadyFlushedForCurrentCompaction } =
            await import("../../auto-reply/reply/memory-flush.js");
          const { loadSessionStore, resolveStorePath } = await import("../../config/sessions.js");
          const { resolveAgentIdFromSessionKey } = await import("../../routing/session-key.js");

          const plan = resolveMemoryFlushPlan({ cfg: opts.config });
          if (!plan) {
            logWarn("[compact] memory flush skipped: no flush plan resolved from config");
          } else {
            const agentId = opts.sessionKey
              ? resolveAgentIdFromSessionKey(opts.sessionKey)
              : undefined;
            const storePath = resolveStorePath(opts.config?.session?.store, {
              agentId,
            });
            const store = loadSessionStore(storePath);
            const entry = opts.sessionKey ? store[opts.sessionKey] : undefined;
            const alreadyFlushed = entry != null && hasAlreadyFlushedForCurrentCompaction(entry);

            if (alreadyFlushed) {
              logWarn("[compact] memory flush skipped: already flushed for current compaction");
            } else {
              memoryFlushed = await runMemoryFlush({
                opts,
                plan,
                storePath,
                agentId,
              });
            }
          }
        } catch (err) {
          logWarn(
            `[compact] memory flush failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      try {
        // Resolve the agent's configured model so compaction uses the same
        // provider instead of falling back to the hardcoded default (openai/gpt-5.4).
        let provider: string | undefined;
        let model: string | undefined;
        if (opts.config && opts.sessionKey) {
          const { resolveAgentIdFromSessionKey } = await import("../../routing/session-key.js");
          const { resolveAgentEffectiveModelPrimary } = await import("../agent-scope.js");
          const agentId = resolveAgentIdFromSessionKey(opts.sessionKey);
          const modelRef = resolveAgentEffectiveModelPrimary(opts.config, agentId);
          if (modelRef) {
            const slashIdx = modelRef.indexOf("/");
            if (slashIdx > 0) {
              provider = modelRef.slice(0, slashIdx);
              model = modelRef.slice(slashIdx + 1);
            }
          }
        }

        const { compactEmbeddedPiSessionDirect } =
          await import("../pi-embedded-runner/compact.runtime.js");
        const result = await compactEmbeddedPiSessionDirect({
          sessionId: opts.sessionId,
          sessionKey: opts.sessionKey,
          sessionFile: opts.sessionFile,
          workspaceDir: opts.workspaceDir,
          agentDir: opts.agentDir,
          config: opts.config,
          senderIsOwner: opts.senderIsOwner,
          allowGatewaySubagentBinding: opts.allowGatewaySubagentBinding,
          customInstructions: instructions ?? undefined,
          provider,
          model,
          trigger: "manual",
          bashElevated: {
            enabled: false,
            allowed: false,
            defaultLevel: "off",
          },
        });

        if (!result.ok) {
          return jsonResult({
            status: "failed",
            reason: result.reason ?? "Compaction failed",
            memoryFlushed,
          });
        }
        if (!result.compacted) {
          return jsonResult({
            status: "skipped",
            reason: result.reason ?? "Nothing to compact",
            memoryFlushed,
          });
        }
        return jsonResult({
          status: "compacted",
          tokensBefore: result.result?.tokensBefore,
          tokensAfter: result.result?.tokensAfter,
          memoryFlushed,
        });
      } catch (err) {
        return jsonResult({
          status: "error",
          reason: err instanceof Error ? err.message : String(err),
          memoryFlushed,
        });
      }
    },
  };
}

async function runMemoryFlush(params: {
  opts: CompactToolOptions;
  plan: { prompt: string; systemPrompt: string; relativePath: string };
  storePath: string;
  agentId?: string;
}): Promise<boolean> {
  const { opts, plan } = params;
  if (!opts.sessionId || !opts.sessionFile) {
    logWarn("[compact] memory flush skipped: missing sessionId or sessionFile");
    return false;
  }

  // Resolve the agent's configured model for the flush run.
  let provider: string | undefined;
  let model: string | undefined;
  if (opts.config && opts.sessionKey) {
    const { resolveAgentEffectiveModelPrimary } = await import("../agent-scope.js");
    const { resolveAgentIdFromSessionKey } = await import("../../routing/session-key.js");
    const agentId = resolveAgentIdFromSessionKey(opts.sessionKey);
    const modelRef = resolveAgentEffectiveModelPrimary(opts.config, agentId);
    if (modelRef) {
      const slashIdx = modelRef.indexOf("/");
      if (slashIdx > 0) {
        provider = modelRef.slice(0, slashIdx);
        model = modelRef.slice(slashIdx + 1);
      }
    }
  }

  const { runEmbeddedPiAgent } = await import("../pi-embedded-runner/run.js");
  const { updateSessionStoreEntry } = await import("../../config/sessions/store.runtime.js");

  let memoryCompactionCompleted = false;
  const flushRunId = crypto.randomUUID();

  await runEmbeddedPiAgent({
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    sessionFile: opts.sessionFile,
    workspaceDir: opts.workspaceDir,
    agentDir: opts.agentDir,
    config: opts.config,
    senderIsOwner: opts.senderIsOwner,
    allowGatewaySubagentBinding: opts.allowGatewaySubagentBinding,
    trigger: "memory",
    memoryFlushWritePath: plan.relativePath,
    prompt: plan.prompt,
    extraSystemPrompt: plan.systemPrompt,
    provider,
    model,
    silentExpected: true,
    timeoutMs: MEMORY_FLUSH_TIMEOUT_MS,
    runId: flushRunId,
    onAgentEvent: (evt) => {
      if (evt.stream === "compaction") {
        const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
        if (phase === "end") {
          memoryCompactionCompleted = true;
        }
      }
    },
  });

  // Update session metadata to record the flush.
  if (opts.sessionKey && params.storePath) {
    if (memoryCompactionCompleted) {
      const { incrementCompactionCount } =
        await import("../../auto-reply/reply/session-updates.js");
      await incrementCompactionCount({
        cfg: opts.config,
        sessionKey: opts.sessionKey,
        storePath: params.storePath,
      });
    }
    try {
      const { loadSessionStore } = await import("../../config/sessions.js");
      const store = loadSessionStore(params.storePath);
      const entry = store[opts.sessionKey];
      const memoryFlushCompactionCount = entry?.compactionCount ?? 0;
      await updateSessionStoreEntry({
        storePath: params.storePath,
        sessionKey: opts.sessionKey,
        update: async () => ({
          memoryFlushAt: Date.now(),
          memoryFlushCompactionCount,
        }),
      });
    } catch (err) {
      logWarn(
        `[compact] failed to persist memory flush metadata: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return true;
}

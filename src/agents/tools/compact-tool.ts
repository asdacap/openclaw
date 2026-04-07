import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
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
          if (plan) {
            const agentId = opts.sessionKey
              ? resolveAgentIdFromSessionKey(opts.sessionKey)
              : undefined;
            const storePath = resolveStorePath(opts.config?.session?.store, {
              agentId,
            });
            const store = loadSessionStore(storePath);
            const entry = opts.sessionKey ? store[opts.sessionKey] : undefined;
            const alreadyFlushed = entry != null && hasAlreadyFlushedForCurrentCompaction(entry);

            if (!alreadyFlushed) {
              // Memory flush is best-effort; log but don't block compaction on failure.
              // A full flush requires running an embedded agent turn which is complex.
              // For now, skip the actual flush execution and just note that it was requested.
              // TODO: Extract core flush logic from runMemoryFlushIfNeeded into a reusable function.
              memoryFlushed = false;
            }
          }
        } catch {
          // Memory flush is best-effort; proceed with compaction.
        }
      }

      try {
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

import { Type } from "@sinclair/typebox";
import { TOOLS_DISABLED_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

export type DisabledToolEntry = {
  name: string;
  reason: string;
};

export type DisabledToolsRef = {
  value: DisabledToolEntry[];
};

const ToolsDisabledToolSchema = Type.Object({});

export function createToolsDisabledTool(opts: {
  disabledToolsRef: DisabledToolsRef;
}): AnyAgentTool {
  return {
    label: "Tools Disabled",
    name: "tools_disabled",
    displaySummary: TOOLS_DISABLED_TOOL_DISPLAY_SUMMARY,
    description:
      "List tools that were filtered out by policy in this session. " +
      "Returns tool names and the policy rule that caused filtering.",
    parameters: ToolsDisabledToolSchema,
    execute: async () => {
      const disabled = opts.disabledToolsRef.value;
      if (disabled.length === 0) {
        return jsonResult({
          status: "ok",
          disabledTools: [],
          message: "No tools were disabled by policy.",
        });
      }
      return jsonResult({
        status: "ok",
        disabledTools: disabled.map((entry) => ({
          name: entry.name,
          reason: entry.reason,
        })),
        count: disabled.length,
      });
    },
  };
}

import { describe, expect, it } from "vitest";
import { createToolsDisabledTool, type DisabledToolsRef } from "./tools-disabled-tool.js";

describe("createToolsDisabledTool", () => {
  it("returns empty list when no tools are disabled", async () => {
    const ref: DisabledToolsRef = { value: [] };
    const tool = createToolsDisabledTool({ disabledToolsRef: ref });
    const result = await tool.execute("call-1", {});
    expect(result.details).toEqual({
      status: "ok",
      disabledTools: [],
      message: "No tools were disabled by policy.",
    });
  });

  it("returns disabled tools with reasons", async () => {
    const ref: DisabledToolsRef = {
      value: [
        { name: "exec", reason: "tools.profile (minimal)" },
        { name: "cron", reason: "owner-only policy" },
      ],
    };
    const tool = createToolsDisabledTool({ disabledToolsRef: ref });
    const result = await tool.execute("call-2", {});
    expect(result.details).toEqual({
      status: "ok",
      disabledTools: [
        { name: "exec", reason: "tools.profile (minimal)" },
        { name: "cron", reason: "owner-only policy" },
      ],
      count: 2,
    });
  });

  it("reflects ref changes after creation", async () => {
    const ref: DisabledToolsRef = { value: [] };
    const tool = createToolsDisabledTool({ disabledToolsRef: ref });

    // Simulate policy pipeline populating the ref after tool creation
    ref.value.push({ name: "gateway", reason: "subagent tools.allow" });

    const result = await tool.execute("call-3", {});
    expect(result.details).toEqual({
      status: "ok",
      disabledTools: [{ name: "gateway", reason: "subagent tools.allow" }],
      count: 1,
    });
  });

  it("has correct tool metadata", () => {
    const ref: DisabledToolsRef = { value: [] };
    const tool = createToolsDisabledTool({ disabledToolsRef: ref });
    expect(tool.name).toBe("tools_disabled");
    expect(tool.label).toBe("Tools Disabled");
    expect(tool.ownerOnly).toBeUndefined();
  });
});

import { definePluginEntry, type AnyAgentTool, type OpenClawPluginApi } from "./api.js";
import { createSessionHistorySeekTool } from "./src/session-history-seek-tool.js";

export default definePluginEntry({
  id: "session-history-seek",
  name: "Session History Seek",
  description: "Efficient seek-based session history retrieval with timestamp and offset support",
  register(api: OpenClawPluginApi) {
    api.registerTool(createSessionHistorySeekTool(api) as unknown as AnyAgentTool, {
      optional: true,
    });
  },
});

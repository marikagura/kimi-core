// Re-exported from the canonical implementation in @kimi/context-core so the
// gateway and context-core share ONE timezone definition (KIMI_TZ, default
// Asia/Shanghai). These were two hand-copies that drifted (the gateway one gained
// localWeekday/tzOffsetMs; the context-core one lagged) — now there is one source.
// Gateway code keeps importing from "./time.js" as before.
export { DEFAULT_TZ, localDate, localDateTime, localWeekday, tzOffsetMs } from "@kimi/context-core";

import { useSettingsStore } from "@/settings";

export function debug(log: string | LogMessage) {
  if (!useSettingsStore.getState().debugLogging) {
    return;
  }

  const detail = isComplexLog(log) ? `${log.msg}: ${safeSerialize(log.context)}` : log;
  window.dispatchEvent(new CustomEvent("tasks-bridge:debug", { detail }));
}

interface LogMessage {
  msg: string;
  context: object;
}

function isComplexLog(log: string | LogMessage): log is LogMessage {
  return (log as LogMessage).msg !== undefined;
}

const safeSerialize = (value: object): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable context]";
  }
};

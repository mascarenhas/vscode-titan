export const SERVER_LOG_PREFIX = "titan-language-server ";

export type ServerLogRecordLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error";

export interface ServerLogRecord {
  level: ServerLogRecordLevel;
}

const SERVER_LOG_LEVELS = new Set<ServerLogRecordLevel>([
  "trace",
  "debug",
  "info",
  "warn",
  "error"
]);

export function parseServerLogRecord(
  line: string
): ServerLogRecord | undefined {
  if (!line.startsWith(SERVER_LOG_PREFIX)) {
    return undefined;
  }

  try {
    const value = JSON.parse(line.slice(SERVER_LOG_PREFIX.length)) as unknown;
    if (typeof value !== "object" || value === null ||
        !("level" in value) || typeof value.level !== "string" ||
        !SERVER_LOG_LEVELS.has(value.level as ServerLogRecordLevel)) {
      return undefined;
    }
    return { level: value.level as ServerLogRecordLevel };
  } catch {
    return undefined;
  }
}

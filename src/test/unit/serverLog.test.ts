import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SERVER_LOG_PREFIX,
  parseServerLogRecord
} from "../../extension/serverLog";

describe("structured server logs", () => {
  test("recognizes every routed severity", () => {
    for (const level of ["trace", "debug", "info", "warn", "error"]) {
      assert.deepEqual(
        parseServerLogRecord(
          `${SERVER_LOG_PREFIX}${JSON.stringify({
            level,
            event: "test.event",
            generation: 2
          })}`
        ),
        { level }
      );
    }
  });

  test("leaves unstructured or malformed stderr at the error boundary", () => {
    for (const line of [
      "ordinary stderr",
      `${SERVER_LOG_PREFIX}{not-json}`,
      `${SERVER_LOG_PREFIX}${JSON.stringify({ event: "missing.level" })}`,
      `${SERVER_LOG_PREFIX}${JSON.stringify({
        level: "verbose",
        event: "unknown.level"
      })}`
    ]) {
      assert.equal(parseServerLogRecord(line), undefined, line);
    }
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  IndexingStatusModel,
  parseIndexingStatus
} from "../../extension/indexingProtocol";

describe("indexing status protocol", () => {
  test("accepts a bounded typed lifecycle message", () => {
    assert.deepEqual(parseIndexingStatus({
      state: "indexing",
      initial: true,
      epoch: 4,
      generation: 9
    }), {
      state: "indexing",
      initial: true,
      epoch: 4,
      generation: 9
    });
    assert.deepEqual(parseIndexingStatus({
      state: "failed",
      initial: false,
      epoch: 5,
      message: "compiler unavailable"
    }), {
      state: "failed",
      initial: false,
      epoch: 5,
      message: "compiler unavailable"
    });
  });

  test("rejects malformed and unbounded values", () => {
    for (const value of [
      null,
      {},
      { state: "busy", initial: true, epoch: 0 },
      { state: "ready", initial: "yes", epoch: 0 },
      { state: "ready", initial: true, epoch: -1 },
      { state: "ready", initial: true, epoch: 1.5 },
      { state: "failed", initial: false, epoch: 2, message: {} }
    ]) {
      assert.equal(parseIndexingStatus(value), undefined);
    }
  });

  test("drives busy, failure, ready, stale, and restart lifecycle", () => {
    const model = new IndexingStatusModel();
    assert.deepEqual(model.update({
      state: "indexing", initial: true, epoch: 2
    }), { kind: "busy", initial: true });
    assert.deepEqual(model.update({
      state: "failed", initial: true, epoch: 2, message: "bad config"
    }), { kind: "failed", message: "bad config" });
    assert.equal(model.update({
      state: "ready", initial: true, epoch: 1
    }), undefined);
    assert.deepEqual(model.update({
      state: "ready", initial: true, epoch: 2, generation: 7
    }), { kind: "hidden" });

    model.reset();
    assert.deepEqual(model.update({
      state: "indexing", initial: false, epoch: 0
    }), { kind: "busy", initial: false });
  });
});

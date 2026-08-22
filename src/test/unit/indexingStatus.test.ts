import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  IndexingStatusModel,
  parseIndexingStatus,
  presentBusyIndexing
} from "../../extension/indexingProtocol";

describe("indexing status protocol", () => {
  test("accepts a bounded typed lifecycle message", () => {
    assert.deepEqual(parseIndexingStatus({
      state: "indexing",
      initial: true,
      epoch: 4,
      generation: 9,
      completed_files: 3,
      total_files: 11
    }), {
      state: "indexing",
      initial: true,
      epoch: 4,
      generation: 9,
      completed_files: 3,
      total_files: 11
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
      { state: "failed", initial: false, epoch: 2, message: {} },
      {
        state: "indexing", initial: true, epoch: 0,
        completed_files: 0
      },
      {
        state: "indexing", initial: true, epoch: 0,
        completed_files: -1, total_files: 2
      },
      {
        state: "indexing", initial: true, epoch: 0,
        completed_files: 3, total_files: 2
      },
      {
        state: "indexing", initial: true, epoch: 0,
        completed_files: Number.MAX_SAFE_INTEGER + 1,
        total_files: Number.MAX_SAFE_INTEGER + 1
      },
      {
        state: "ready", initial: true, epoch: 0,
        completed_files: 2, total_files: 2
      }
    ]) {
      assert.equal(parseIndexingStatus(value), undefined);
    }
  });

  test("drives busy, failure, ready, stale, and restart lifecycle", () => {
    const model = new IndexingStatusModel();
    assert.deepEqual(model.update({
      state: "indexing", initial: true, epoch: 2,
      completed_files: 4, total_files: 9
    }), {
      kind: "busy",
      initial: true,
      progress: { completedFiles: 4, totalFiles: 9 }
    });
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

  test("presents initial and refresh progress in the status bar", () => {
    assert.deepEqual(presentBusyIndexing({
      kind: "busy",
      initial: true,
      progress: { completedFiles: 7, totalFiles: 12 }
    }, "Titan Workspace"), {
      text: "$(sync~spin) Titan indexing 7/12 files",
      detail: "Building saved-file project state for Titan Workspace — 7/12 files"
    });
    assert.deepEqual(presentBusyIndexing({
      kind: "busy",
      initial: false,
      progress: { completedFiles: 12, totalFiles: 12 }
    }, "Titan Workspace"), {
      text: "$(sync~spin) Titan indexing 12/12 files",
      detail: "Refreshing saved-file project state for Titan Workspace — 12/12 files"
    });
    assert.deepEqual(presentBusyIndexing({
      kind: "busy",
      initial: false
    }, "Titan Workspace"), {
      text: "$(sync~spin) Titan indexing",
      detail: "Refreshing saved-file project state for Titan Workspace"
    });
  });
});

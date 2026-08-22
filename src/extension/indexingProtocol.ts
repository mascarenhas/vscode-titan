export const INDEXING_STATUS_NOTIFICATION = "titan/indexingStatus";

export type IndexingState = "indexing" | "ready" | "failed";

export interface IndexingStatus {
  state: IndexingState;
  initial: boolean;
  epoch: number;
  generation?: number;
  message?: string;
}

export type IndexingDisplay =
  | { kind: "hidden" }
  | { kind: "busy"; initial: boolean }
  | { kind: "failed"; message?: string };

export class IndexingStatusModel {
  private latestEpoch = -1;

  public update(value: unknown): IndexingDisplay | undefined {
    const status = parseIndexingStatus(value);
    if (status === undefined || status.epoch < this.latestEpoch) {
      return undefined;
    }
    this.latestEpoch = status.epoch;
    if (status.state === "ready") {
      return { kind: "hidden" };
    }
    if (status.state === "failed") {
      return status.message === undefined
        ? { kind: "failed" }
        : { kind: "failed", message: status.message };
    }
    return { kind: "busy", initial: status.initial };
  }

  public reset(): void {
    this.latestEpoch = -1;
  }
}

export function parseIndexingStatus(value: unknown): IndexingStatus | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if ((candidate.state !== "indexing" &&
       candidate.state !== "ready" &&
       candidate.state !== "failed") ||
      typeof candidate.initial !== "boolean" ||
      !isNonNegativeInteger(candidate.epoch) ||
      (candidate.generation !== undefined &&
       !isNonNegativeInteger(candidate.generation)) ||
      (candidate.message !== undefined &&
       typeof candidate.message !== "string")) {
    return undefined;
  }
  return {
    state: candidate.state,
    initial: candidate.initial,
    epoch: candidate.epoch,
    ...(candidate.generation === undefined
      ? {}
      : { generation: candidate.generation }),
    ...(candidate.message === undefined
      ? {}
      : { message: candidate.message })
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) && value >= 0;
}

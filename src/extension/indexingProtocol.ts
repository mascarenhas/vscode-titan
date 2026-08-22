export const INDEXING_STATUS_NOTIFICATION = "titan/indexingStatus";

export type IndexingState = "indexing" | "ready" | "failed";

export interface IndexingStatus {
  state: IndexingState;
  initial: boolean;
  epoch: number;
  generation?: number;
  message?: string;
  completed_files?: number;
  total_files?: number;
}

export interface IndexingProgress {
  completedFiles: number;
  totalFiles: number;
}

export type IndexingDisplay =
  | { kind: "hidden" }
  | { kind: "busy"; initial: boolean; progress?: IndexingProgress }
  | { kind: "failed"; message?: string };

type BusyIndexingDisplay = Extract<IndexingDisplay, { kind: "busy" }>;

export interface BusyIndexingPresentation {
  text: string;
  detail: string;
}

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
    return {
      kind: "busy",
      initial: status.initial,
      ...(status.completed_files === undefined
        ? {}
        : {
            progress: {
              completedFiles: status.completed_files,
              totalFiles: status.total_files as number
            }
          })
    };
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
  const hasCompletedFiles = candidate.completed_files !== undefined;
  const hasTotalFiles = candidate.total_files !== undefined;
  if (hasCompletedFiles !== hasTotalFiles ||
      (hasCompletedFiles &&
       (candidate.state !== "indexing" ||
        !isNonNegativeInteger(candidate.completed_files) ||
        !isNonNegativeInteger(candidate.total_files) ||
        candidate.completed_files > candidate.total_files))) {
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
      : { message: candidate.message }),
    ...(hasCompletedFiles
      ? {
          completed_files: candidate.completed_files as number,
          total_files: candidate.total_files as number
        }
      : {})
  };
}

export function presentBusyIndexing(
  display: BusyIndexingDisplay,
  workspaceName: string
): BusyIndexingPresentation {
  const action = display.initial ? "Building" : "Refreshing";
  const progress = display.progress === undefined
    ? undefined
    : `${display.progress.completedFiles}/${display.progress.totalFiles} files`;
  return {
    text: progress === undefined
      ? "$(sync~spin) Titan indexing"
      : `$(sync~spin) Titan indexing ${progress}`,
    detail: progress === undefined
      ? `${action} saved-file project state for ${workspaceName}`
      : `${action} saved-file project state for ${workspaceName} — ${progress}`
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) && value >= 0;
}

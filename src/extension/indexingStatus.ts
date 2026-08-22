import * as vscode from "vscode";
import {
  IndexingStatusModel,
  presentBusyIndexing
} from "./indexingProtocol";

export { INDEXING_STATUS_NOTIFICATION } from "./indexingProtocol";

export class WorkspaceIndexingStatus implements vscode.Disposable {
  private item: vscode.LanguageStatusItem | undefined;
  private readonly model = new IndexingStatusModel();

  public constructor(
    private readonly id: string,
    private readonly workspaceName: string,
    private readonly selector: vscode.DocumentSelector,
    private readonly showOutputCommand: string
  ) {}

  public update(value: unknown): boolean {
    const display = this.model.update(value);
    if (display === undefined) {
      return false;
    }

    if (display.kind === "hidden") {
      this.clearItem();
      return true;
    }

    const item = this.ensureItem();
    item.busy = display.kind === "busy";
    item.severity = display.kind === "failed"
      ? vscode.LanguageStatusSeverity.Error
      : vscode.LanguageStatusSeverity.Information;
    item.text = display.kind === "failed"
      ? "$(error) Titan indexing failed"
      : presentBusyIndexing(display, this.workspaceName).text;
    if (display.kind === "failed") {
      item.detail = display.message ??
        `Titan could not index ${this.workspaceName}`;
    } else {
      item.detail = presentBusyIndexing(display, this.workspaceName).detail;
    }
    return true;
  }

  public reset(): void {
    this.model.reset();
    this.clearItem();
  }

  public dispose(): void {
    this.clearItem();
  }

  private ensureItem(): vscode.LanguageStatusItem {
    if (this.item === undefined) {
      this.item = vscode.languages.createLanguageStatusItem(
        this.id,
        this.selector
      );
      this.item.name = `Titan indexing (${this.workspaceName})`;
      this.item.command = {
        command: this.showOutputCommand,
        title: "Show Titan Language Server Output"
      };
    }
    return this.item;
  }

  private clearItem(): void {
    this.item?.dispose();
    this.item = undefined;
  }
}

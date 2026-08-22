import * as vscode from "vscode";
import { parseServerLogRecord } from "./serverLog";

const TRACE_CONFIGURATION_SECTION = "titan";
const TRACE_CONFIGURATION_KEY = "trace.server";

type ProtocolTraceSetting = "off" | "messages" | "verbose";

export class ProtocolTraceController implements vscode.Disposable {
  private readonly logLevelEmitter = new vscode.EventEmitter<vscode.LogLevel>();
  private readonly configurationSubscription: vscode.Disposable;

  public readonly onDidChangeLogLevel = this.logLevelEmitter.event;

  public constructor() {
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration(
          `${TRACE_CONFIGURATION_SECTION}.${TRACE_CONFIGURATION_KEY}`
        )) {
          this.logLevelEmitter.fire(this.logLevel);
        }
      }
    );
  }

  public get enabled(): boolean {
    return this.setting !== "off";
  }

  public get logLevel(): vscode.LogLevel {
    // vscode-languageclient 10 first gates protocol tracing on the trace
    // output channel's log level. The conventional titan.trace.server setting
    // remains the user-facing switch, so present Trace only while it is on.
    return this.enabled ? vscode.LogLevel.Trace : vscode.LogLevel.Info;
  }

  public dispose(): void {
    this.configurationSubscription.dispose();
    this.logLevelEmitter.dispose();
  }

  private get setting(): ProtocolTraceSetting {
    const configured = vscode.workspace.getConfiguration(
      TRACE_CONFIGURATION_SECTION
    ).get<unknown>(TRACE_CONFIGURATION_KEY, "off");
    return configured === "messages" || configured === "verbose"
      ? configured
      : "off";
  }
}

export class WorkspaceLogOutputChannel implements vscode.LogOutputChannel {
  public constructor(
    private readonly shared: vscode.LogOutputChannel,
    private readonly workspaceName: string,
    private readonly protocolTrace: ProtocolTraceController
  ) {}

  public get name(): string {
    return this.shared.name;
  }

  public get logLevel(): vscode.LogLevel {
    return this.protocolTrace.logLevel;
  }

  public get onDidChangeLogLevel(): vscode.Event<vscode.LogLevel> {
    return this.protocolTrace.onDidChangeLogLevel;
  }

  public append(value: string): void {
    this.shared.append(this.prefix(value));
  }

  public appendLine(value: string): void {
    this.shared.appendLine(this.prefix(value));
  }

  public replace(value: string): void {
    // Replacing the shared channel would erase other workspace roots. The
    // language client does not currently call replace(), but keep the proxy's
    // behavior isolated if that changes.
    this.shared.appendLine(this.prefix(value));
  }

  public clear(): void {
    // One workspace must never clear diagnostics from another workspace's
    // view of this intentionally shared channel.
  }

  public show(preserveFocus?: boolean): void;
  public show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  public show(
    columnOrPreserveFocus?: vscode.ViewColumn | boolean,
    preserveFocus?: boolean
  ): void {
    if (typeof columnOrPreserveFocus === "boolean" ||
        columnOrPreserveFocus === undefined) {
      this.shared.show(columnOrPreserveFocus);
    } else {
      this.shared.show(columnOrPreserveFocus, preserveFocus);
    }
  }

  public hide(): void {
    this.shared.hide();
  }

  public dispose(): void {
    // The extension context owns the shared channel and trace controller.
  }

  public trace(message: string, ...args: unknown[]): void {
    if (this.protocolTrace.enabled) {
      // A LogOutputChannel normally drops trace() calls unless its UI log
      // level is also Trace. titan.trace.server is the explicit opt-in here,
      // so append protocol traces after vscode-languageclient has selected
      // messages versus verbose detail.
      this.shared.appendLine(this.prefix(withArguments(message, args)));
    }
  }

  public debug(message: string, ...args: unknown[]): void {
    this.shared.debug(this.prefix(message), ...args);
  }

  public info(message: string, ...args: unknown[]): void {
    this.shared.info(this.prefix(message), ...args);
  }

  public warn(message: string, ...args: unknown[]): void {
    this.shared.warn(this.prefix(message), ...args);
  }

  public error(error: string | Error, ...args: unknown[]): void {
    if (typeof error === "string") {
      const record = parseServerLogRecord(error);
      if (record !== undefined) {
        const message = this.prefix(error);
        switch (record.level) {
          case "trace":
            this.shared.trace(message, ...args);
            return;
          case "debug":
            this.shared.debug(message, ...args);
            return;
          case "info":
            this.shared.info(message, ...args);
            return;
          case "warn":
            this.shared.warn(message, ...args);
            return;
          case "error":
            this.shared.error(message, ...args);
            return;
        }
      }
      this.shared.error(this.prefix(error), ...args);
      return;
    }

    this.shared.error(this.prefix(error.message), error, ...args);
  }

  private prefix(value: string): string {
    const prefix = `[${this.workspaceName}] `;
    return prefix + value.replace(/\r?\n/g, `\n${prefix}`);
  }
}

function withArguments(message: string, args: readonly unknown[]): string {
  if (args.length === 0) {
    return message;
  }
  return `${message} ${args.map(formatArgument).join(" ")}`;
}

function formatArgument(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

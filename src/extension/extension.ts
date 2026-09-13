import * as vscode from "vscode";
import type { ChildProcess } from "node:child_process";
import {
  CloseAction,
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  ServerOptions,
  State
} from "vscode-languageclient/node";
import {
  DEFAULT_SERVER_LOG_LEVEL,
  createServerLaunchOptions,
  ensureServerExecutable,
  formatServerStartup,
  formatStartupError,
  readCompilerDiscoveryConfiguration,
  readServerConfiguration,
  resolvePhysicalWorkspaceRoot,
  resolveServerExecutable
} from "./clientConfig";
import {
  ProtocolTraceController,
  WorkspaceLogOutputChannel
} from "./outputChannel";
import {
  INDEXING_STATUS_NOTIFICATION,
  WorkspaceIndexingStatus
} from "./indexingStatus";
import {
  createWorkspaceDocumentSelector,
  createWorkspaceMiddleware,
  createWorkspaceUriConverters
} from "./workspaceUris";

const LANGUAGE_SERVER_CONFIGURATION_SECTION = "titan.languageServer";
const COMPILER_CONFIGURATION_SECTION = "titan.compiler";
const LANGUAGE_CLIENT_ID = "titan";
const SHOW_LANGUAGE_SERVER_OUTPUT_COMMAND =
  "titan.showLanguageServerOutput";
const CLIENT_START_TIMEOUT_MILLISECONDS = 30_000;
const FAILED_START_TERMINATION_TIMEOUT_MILLISECONDS = 2_000;

let clientManager: TitanClientManager | undefined;

class TitanLanguageClient extends LanguageClient {
  private cleaningFailedStart = false;

  public constructor(
    id: string,
    name: string,
    serverOptions: ServerOptions,
    clientOptions: LanguageClientOptions
  ) {
    super(id, name, serverOptions, clientOptions);
    const defaultErrorHandler = this.clientOptions.errorHandler;
    if (defaultErrorHandler === undefined) {
      throw new Error("language client did not install its default error handler");
    }
    this.clientOptions.errorHandler = {
      error: (error, message, count) =>
        defaultErrorHandler.error(error, message, count),
      closed: () => (this.cleaningFailedStart ||
          this.state === State.Starting ||
          this.state === State.StartFailed)
        ? {
            action: CloseAction.DoNotRestart,
            handled: true
          }
        : defaultErrorHandler.closed()
    };
  }

  public prepareFailedStartCleanup(): void {
    this.cleaningFailedStart = true;
  }

  public override start(): Promise<void> {
    const operation = super.start();
    // v10's first start() call owns initialization before it returns the
    // internal _onStart deferred. A second call immediately adopts that
    // deferred, ensuring its rejection is observed when a timed-out pending
    // initialize request is disposed. The primary operation still propagates
    // the same failure to TitanClientManager.
    void super.start().catch(() => undefined);
    return operation;
  }

  public override stop(timeout?: number): Promise<void> {
    // vscode-languageclient 10 calls stop() from its initialize-error handler
    // before start() has transitioned out of Starting. The base stop rejects in
    // that state, and NodeLanguageClient.shutdown() then clears serverProcess in
    // a finally block. Leave that child handle with TitanClientManager, which
    // owns the bounded failed-start cleanup below.
    if (this.state === State.Starting || this.state === State.StartFailed) {
      return Promise.resolve();
    }
    return super.stop(timeout);
  }
}

class TitanClientManager {
  private readonly clients = new Map<string, TitanLanguageClient>();
  private readonly indexingStatuses =
    new Map<string, WorkspaceIndexingStatus>();
  private readonly indexingSubscriptions =
    new Map<string, vscode.Disposable>();
  private operation: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.LogOutputChannel,
    private readonly protocolTrace: ProtocolTraceController
  ) {}

  public start(): Promise<void> {
    return this.enqueue(async () => this.synchronizeClients());
  }

  public scheduleSynchronize(): void {
    void this.enqueue(async () => this.synchronizeClients());
  }

  public scheduleRestart(event: vscode.ConfigurationChangeEvent): void {
    const affected = new Set(
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) =>
          event.affectsConfiguration(
            LANGUAGE_SERVER_CONFIGURATION_SECTION,
            folder.uri
          ) || event.affectsConfiguration(
            COMPILER_CONFIGURATION_SECTION,
            folder.uri
          )
        )
        .map((folder) => folder.uri.toString())
    );
    if (affected.size === 0) {
      return;
    }

    void this.enqueue(async () => {
      for (const [key, client] of [...this.clients]) {
        if (affected.has(key)) {
          await this.stopClient(key, client);
        }
      }
      await this.synchronizeClients();
    });
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    await this.enqueue(async () => this.stopAllClients(), true);
  }

  private enqueue(
    task: () => Promise<void>,
    allowWhenDisposed = false
  ): Promise<void> {
    const run = async (): Promise<void> => {
      if (!this.disposed || allowWhenDisposed) {
        await task();
      }
    };

    this.operation = this.operation.then(run, run);
    return this.operation;
  }

  private async synchronizeClients(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const expected = new Set(
      workspaceFolders.map((folder) => folder.uri.toString())
    );

    for (const [key, client] of this.clients) {
      if (!expected.has(key)) {
        await this.stopClient(key, client);
      }
    }

    if (workspaceFolders.length === 0) {
      this.outputChannel.appendLine(
        "Titan language support requires an open workspace folder."
      );
      return;
    }

    // One broken workspace must not hold the lifecycle queue or prevent other
    // roots from acquiring their own clients. Each start is independently
    // bounded and owns its cleanup before this synchronization completes.
    await Promise.all(workspaceFolders.map(async (folder) => {
      const key = folder.uri.toString();
      if (!this.clients.has(key)) {
        await this.startClient(folder, key);
      }
    }));
  }

  private async startClient(
    folder: vscode.WorkspaceFolder,
    key: string
  ): Promise<void> {
    const workspaceOutput = new WorkspaceLogOutputChannel(
      this.outputChannel,
      folder.name,
      this.protocolTrace
    );
    let command = "<unresolved>";
    let client: TitanLanguageClient | undefined;
    try {
      const configuration = vscode.workspace.getConfiguration(
        LANGUAGE_SERVER_CONFIGURATION_SECTION,
        folder.uri
      );
      const compilerConfiguration = vscode.workspace.getConfiguration(
        COMPILER_CONFIGURATION_SECTION,
        folder.uri
      );
      const serverConfiguration = readServerConfiguration(
        configuration.get<unknown>("path", ""),
        configuration.get<unknown>("arguments", []),
        configuration.get<unknown>("logLevel", DEFAULT_SERVER_LOG_LEVEL)
      );
      const compilerDiscovery = readCompilerDiscoveryConfiguration(
        compilerConfiguration.get<unknown>("luaPath", ""),
        compilerConfiguration.get<unknown>("luaCPath", ""),
        this.context.extensionPath
      );
      command = resolveServerExecutable(
        serverConfiguration.configuredPath,
        folder.uri.fsPath,
        this.context.extensionPath
      );
      await ensureServerExecutable(command);
      const physicalWorkspaceRoot = await resolvePhysicalWorkspaceRoot(
        folder.uri.fsPath
      );
      await vscode.workspace.fs.createDirectory(this.context.storageUri || this.context.globalStorageUri);

      const serverOptions: ServerOptions = createServerLaunchOptions(
        command,
        serverConfiguration.arguments,
        physicalWorkspaceRoot,
        process.env,
        compilerDiscovery,
        serverConfiguration.logLevel,
        (this.context.storageUri || this.context.globalStorageUri).fsPath
      );
      const documentSelector = createWorkspaceDocumentSelector(folder);
      const clientOptions: LanguageClientOptions = {
        diagnosticCollectionName: diagnosticCollectionName(folder),
        documentSelector,
        middleware: createWorkspaceMiddleware(folder),
        outputChannel: workspaceOutput,
        revealOutputChannelOn: RevealOutputChannelOn.Error,
        traceOutputChannel: workspaceOutput,
        uriConverters: createWorkspaceUriConverters(
          folder,
          physicalWorkspaceRoot
        ),
        workspaceFolder: folder
      };
      client = new TitanLanguageClient(
        LANGUAGE_CLIENT_ID,
        `Titan Language Server (${folder.name})`,
        serverOptions,
        clientOptions
      );

      const status = new WorkspaceIndexingStatus(
        `${diagnosticCollectionName(folder)}.indexing`,
        folder.name,
        [
          {
            language: "titan",
            scheme: "file",
            pattern: new vscode.RelativePattern(folder, "**/*")
          }
        ],
        SHOW_LANGUAGE_SERVER_OUTPUT_COMMAND
      );
      const statusSubscription = vscode.Disposable.from(
        client.onNotification(
          INDEXING_STATUS_NOTIFICATION,
          (params: unknown) => {
            if (!status.update(params)) {
              workspaceOutput.warn(
                `Ignored invalid ${INDEXING_STATUS_NOTIFICATION} notification.`
              );
            }
          }
        ),
        client.onDidChangeState((event) => {
          if (event.newState !== State.Running) {
            status.reset();
          }
        })
      );

      // Own the client before start() spawns its process. vscode-languageclient
      // v10 enters StartFailed when initialize rejects, and stop() refuses that
      // state even though the Node client can still own a live child process.
      this.clients.set(key, client);
      this.indexingStatuses.set(key, status);
      this.indexingSubscriptions.set(key, statusSubscription);
      workspaceOutput.info(formatServerStartup(
        command,
        serverConfiguration.logLevel
      ));
      await withTimeout(
        client.start(),
        CLIENT_START_TIMEOUT_MILLISECONDS,
        `Titan language server did not initialize within ${
          CLIENT_START_TIMEOUT_MILLISECONDS / 1_000} seconds`
      );
      workspaceOutput.info(
        `Started Titan language server: ${command}`
      );
    } catch (cause) {
      if (client !== undefined) {
        await this.stopClient(key, client);
      }
      const message = formatStartupError(folder.name, cause);
      workspaceOutput.error(message.replace(`[${folder.name}] `, ""));
      void vscode.window.showErrorMessage(
        `${message} See the Titan Language Server output for details.`
      );
    }
  }

  private async stopClient(
    key: string,
    client: TitanLanguageClient
  ): Promise<void> {
    // NodeLanguageClient clears serverProcess in shutdown()'s finally block,
    // including when the protocol shutdown times out. Retain our owned handle
    // so the failure path can still reap the old process before replacement.
    const serverProcess = client.serverProcess;
    try {
      if (client.state === State.StartFailed ||
          client.state === State.Starting) {
        await disposeUnstartedClient(client);
      } else {
        await client.stop();
      }
    } catch (cause) {
      client.outputChannel.error(
        `Titan language server failed to stop cleanly: ${String(cause)}`
      );
      if (serverProcess !== undefined) {
        try {
          await terminateChildProcess(serverProcess);
        } catch (terminationCause) {
          client.outputChannel.error(
            "Titan language server failed forced termination: " +
              String(terminationCause)
          );
        }
      }
    } finally {
      if (this.clients.get(key) === client) {
        this.clients.delete(key);
        this.indexingSubscriptions.get(key)?.dispose();
        this.indexingSubscriptions.delete(key);
        this.indexingStatuses.get(key)?.dispose();
        this.indexingStatuses.delete(key);
      }
    }
  }

  private async stopAllClients(): Promise<void> {
    for (const [key, client] of [...this.clients]) {
      await this.stopClient(key, client);
    }
  }
}

async function disposeUnstartedClient(
  client: TitanLanguageClient
): Promise<void> {
  client.prepareFailedStartCleanup();
  const serverProcess = client.serverProcess;
  if (serverProcess !== undefined) {
    await terminateChildProcess(serverProcess);
  }

  // Closing the child transports normally moves StartFailed to Stopped via
  // the client's connection-close handler. Give that handler a turn, then
  // dispose the client object as well. dispose() marks the client unusable even
  // if v10 still rejects its internal stop operation in StartFailed.
  await waitForClientState(
    client,
    State.Stopped,
    FAILED_START_TERMINATION_TIMEOUT_MILLISECONDS
  );
  try {
    await client.dispose(0);
  } catch (cause) {
    // After the child has exited there is nothing left for shutdown() to
    // negotiate. Depending on whether the connection-close callback has run,
    // v10 can still expose either of these non-stoppable states here.
    if (client.state !== State.StartFailed &&
        client.state !== State.Starting) {
      throw cause;
    }
  }
  // A spawn-time StartFailed can occur before there is a transport whose
  // close handler would run cleanUp(). Dispose the one public resource that
  // start() creates before attempting the transport.
  client.diagnostics?.dispose();
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
  return Promise.race([operation, expired]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) {
    return;
  }

  child.kill();
  if (await waitForChildExit(
    child,
    FAILED_START_TERMINATION_TIMEOUT_MILLISECONDS
  )) {
    return;
  }

  child.kill("SIGKILL");
  if (!await waitForChildExit(
    child,
    FAILED_START_TERMINATION_TIMEOUT_MILLISECONDS
  )) {
    throw new Error(
      `language-server process ${child.pid ?? "<unknown>"} did not exit`
    );
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMilliseconds: number
): Promise<boolean> {
  if (childHasExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = (): void => finish(true);
    const timeout = setTimeout(() => finish(childHasExited(child)),
      timeoutMilliseconds);
    const finish = (exited: boolean): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
  });
}

function waitForClientState(
  client: LanguageClient,
  expected: State,
  timeoutMilliseconds: number
): Promise<boolean> {
  if (client.state === expected) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const subscription = client.onDidChangeState((event) => {
      if (event.newState === expected) {
        finish(true);
      }
    });
    const timeout = setTimeout(() => finish(client.state === expected),
      timeoutMilliseconds);
    const finish = (matched: boolean): void => {
      clearTimeout(timeout);
      subscription.dispose();
      resolve(matched);
    };
  });
}

function diagnosticCollectionName(folder: vscode.WorkspaceFolder): string {
  return `titan-${Buffer.from(folder.uri.toString()).toString("base64url")}`;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel(
    "Titan Language Server",
    { log: true }
  );
  const protocolTrace = new ProtocolTraceController();
  context.subscriptions.push(outputChannel, protocolTrace);

  clientManager = new TitanClientManager(context, outputChannel, protocolTrace);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      SHOW_LANGUAGE_SERVER_OUTPUT_COMMAND,
      () => outputChannel.show()
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clientManager?.scheduleSynchronize();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(LANGUAGE_SERVER_CONFIGURATION_SECTION) ||
          event.affectsConfiguration(COMPILER_CONFIGURATION_SECTION)) {
        clientManager?.scheduleRestart(event);
      }
    }),
    {
      dispose: () => {
        void clientManager?.dispose();
      }
    }
  );

  await clientManager.start();
}

export async function deactivate(): Promise<void> {
  const manager = clientManager;
  clientManager = undefined;
  await manager?.dispose();
}

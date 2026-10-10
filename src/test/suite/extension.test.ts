import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  ensureServerExecutable,
  resolveServerExecutable
} from "../../extension/clientConfig";
import {
  createWorkspaceDocumentSelector,
  createWorkspaceMiddleware,
  createWorkspaceUriConverters
} from "../../extension/workspaceUris";

interface FixtureEvent {
  event: "initialize" | "shutdown" | "exit" | "terminate";
  pid: number;
  cwd: string;
  arguments: string[];
  luaPath?: string;
  luaCPath?: string;
  compilerCachePrefix?: string;
  serverLogLevel?: string;
  rootPath?: string | null;
  rootUri?: string | null;
  workspaceFolders?: Array<{ uri: string; name: string }> | null;
  trace?: string;
  initializationOptions?: { insertCallSnippets: boolean };
  signal?: string;
}

// Windows child.kill() terminates the process without delivering a catchable
// SIGTERM. The child PID must still disappear on every platform.
const forcedTerminationEvents: FixtureEvent["event"][] =
  process.platform === "win32" ? [] : ["terminate"];

interface TraceFixtureEvent {
  event: "trace";
  pid: number;
  value: string;
}

interface SemanticFixtureEvent {
  event: "semantic";
  pid: number;
  cwd: string;
  arguments: string[];
  method: string;
  uri: string;
}

interface CapturedSyntaxToken {
  c: string;
  t: string;
}

suite("Titan extension", () => {
  const extensionIdentifier = "mascarenhas.titan";
  const configuredLuaPath = "/fixture/compiler/?.lua";
  const configuredLuaCPath = "/fixture/compiler/?.so";
  let alpha: vscode.WorkspaceFolder;
  let beta: vscode.WorkspaceFolder;
  let alphaMarkerPath: string;
  let betaMarkerPath: string;
  let alphaTraceMarkerPath: string;
  let betaTraceMarkerPath: string;
  let alphaSettingsPath: string;
  let originalAlphaSettings: string;

  suiteSetup(async function () {
    this.timeout(20_000);
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    assert.equal(workspaceFolders.length, 2, "the multi-root fixture should be open");
    alpha = findWorkspaceFolder(workspaceFolders, "alpha");
    beta = findWorkspaceFolder(workspaceFolders, "beta");

    alphaMarkerPath = path.join(
      alpha.uri.fsPath,
      ".titan-lsp-test",
      "events.jsonl"
    );
    betaMarkerPath = path.join(
      beta.uri.fsPath,
      ".titan-lsp-test",
      "events.jsonl"
    );
    alphaTraceMarkerPath = `${alphaMarkerPath}.trace`;
    betaTraceMarkerPath = `${betaMarkerPath}.trace`;
    await Promise.all([
      resetMarker(alphaMarkerPath),
      resetMarker(betaMarkerPath)
    ]);

    alphaSettingsPath = path.join(
      alpha.uri.fsPath,
      ".vscode",
      "settings.json"
    );
    originalAlphaSettings = await readFile(alphaSettingsPath, "utf8");

    const nodeExecutable = process.env.npm_node_execpath;
    assert.ok(nodeExecutable, "npm_node_execpath should identify Node");

    await vscode.workspace.getConfiguration("titan.languageServer").update(
      "path",
      nodeExecutable,
      vscode.ConfigurationTarget.Global
    );
    await vscode.workspace.getConfiguration("titan.languageServer").update(
      "logLevel",
      "info",
      vscode.ConfigurationTarget.Global
    );
    await vscode.workspace.getConfiguration("titan").update(
      "trace.server",
      "off",
      vscode.ConfigurationTarget.Global
    );
    await vscode.workspace.getConfiguration("titan.compiler").update(
      "luaPath",
      configuredLuaPath,
      vscode.ConfigurationTarget.Global
    );
    await vscode.workspace.getConfiguration("titan.compiler").update(
      "luaCPath",
      configuredLuaCPath,
      vscode.ConfigurationTarget.Global
    );

    const extension = vscode.extensions.getExtension(extensionIdentifier);
    assert.ok(extension, `${extensionIdentifier} should be installed`);
    await extension.activate();
    assert.equal(extension.isActive, true);

    await Promise.all([
      waitForEventSequence(alphaMarkerPath, ["initialize"], 10_000),
      waitForEventSequence(betaMarkerPath, ["initialize"], 10_000)
    ]);
  });

  suiteTeardown(async () => {
    // The scoped configuration test edits this checked-in fixture through the
    // VS Code API. Restore its exact text even if a later assertion fails.
    if (originalAlphaSettings !== undefined) {
      await writeFile(alphaSettingsPath, originalAlphaSettings);
    }
  });

  test("isolates multi-root clients and their lifecycle", async function () {
    this.timeout(30_000);

    const alphaDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(alpha.uri, "sample.titan")
    );
    const betaDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(beta.uri, "sample.titan")
    );
    assert.equal(alphaDocument.languageId, "titan");
    assert.equal(betaDocument.languageId, "titan");

    const [alphaInitial] = await assertStableEventSequence(
      alphaMarkerPath,
      ["initialize"]
    );
    const [betaInitial] = await assertStableEventSequence(
      betaMarkerPath,
      ["initialize"]
    );
    assert.notEqual(alphaInitial.pid, betaInitial.pid);
    await assertInitialization(
      alphaInitial,
      alpha,
      "alpha",
      configuredLuaPath,
      configuredLuaCPath
    );
    await assertInitialization(
      betaInitial,
      beta,
      "beta",
      configuredLuaPath,
      configuredLuaCPath
    );

    await updateWorkspaceFolders(1, 1);
    const betaRemoved = await assertStableEventSequence(
      betaMarkerPath,
      ["initialize", "shutdown", "exit"]
    );
    assert.equal(new Set(betaRemoved.map((event) => event.pid)).size, 1);
    await assertStableEventSequence(alphaMarkerPath, ["initialize"]);

    await updateWorkspaceFolders(1, 0, { uri: beta.uri, name: beta.name });
    const betaReadded = await assertStableEventSequence(
      betaMarkerPath,
      ["initialize", "shutdown", "exit", "initialize"]
    );
    assert.notEqual(betaReadded[3].pid, betaInitial.pid);
    await assertInitialization(
      betaReadded[3],
      beta,
      "beta",
      configuredLuaPath,
      configuredLuaCPath
    );
    await assertStableEventSequence(alphaMarkerPath, ["initialize"]);

    await vscode.workspace.getConfiguration(
      "titan.languageServer",
      alpha.uri
    ).update(
      "arguments",
      [
        "../fake-lsp-server.cjs",
        ".titan-lsp-test/events.jsonl",
        "--fixture-token",
        "alpha-reconfigured"
      ],
      vscode.ConfigurationTarget.WorkspaceFolder
    );

    const alphaReconfigured = await assertStableEventSequence(
      alphaMarkerPath,
      ["initialize", "shutdown", "exit", "initialize"]
    );
    assert.notEqual(alphaReconfigured[3].pid, alphaInitial.pid);
    assert.deepEqual(
      alphaReconfigured[3].arguments,
      ["--fixture-token", "alpha-reconfigured"]
    );
    await assertStableEventSequence(
      betaMarkerPath,
      ["initialize", "shutdown", "exit", "initialize"]
    );

    const globalLuaPath = "/fixture/compiler/reconfigured/?.lua";
    await vscode.workspace.getConfiguration("titan.compiler").update(
      "luaPath",
      globalLuaPath,
      vscode.ConfigurationTarget.Global
    );

    const alphaGloballyReconfigured = await assertStableEventSequence(
      alphaMarkerPath,
      [
        "initialize",
        "shutdown",
        "exit",
        "initialize",
        "shutdown",
        "exit",
        "initialize"
      ]
    );
    const betaGloballyReconfigured = await assertStableEventSequence(
      betaMarkerPath,
      [
        "initialize",
        "shutdown",
        "exit",
        "initialize",
        "shutdown",
        "exit",
        "initialize"
      ]
    );
    assert.equal(alphaGloballyReconfigured[6].luaPath, globalLuaPath);
    assert.equal(betaGloballyReconfigured[6].luaPath, globalLuaPath);
    assert.notEqual(
      alphaGloballyReconfigured[6].pid,
      alphaReconfigured[3].pid
    );
    assert.notEqual(
      betaGloballyReconfigured[6].pid,
      betaReadded[3].pid
    );

    await vscode.workspace.getConfiguration(
      "titan.languageServer",
      alpha.uri
    ).update(
      "logLevel",
      "trace",
      vscode.ConfigurationTarget.WorkspaceFolder
    );

    const alphaLogReconfigured = await assertStableEventSequence(
      alphaMarkerPath,
      [
        "initialize",
        "shutdown",
        "exit",
        "initialize",
        "shutdown",
        "exit",
        "initialize",
        "shutdown",
        "exit",
        "initialize"
      ]
    );
    assert.equal(alphaLogReconfigured[9].serverLogLevel, "trace");
    assert.notEqual(
      alphaLogReconfigured[9].pid,
      alphaGloballyReconfigured[6].pid
    );
    await assertStableEventSequence(
      betaMarkerPath,
      [
        "initialize",
        "shutdown",
        "exit",
        "initialize",
        "shutdown",
        "exit",
        "initialize"
      ]
    );

    await vscode.workspace.getConfiguration(
      "titan.languageServer",
      alpha.uri
    ).update(
      "logLevel",
      undefined,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
    const alphaLogRestored = await assertStableEventSequence(
      alphaMarkerPath,
      [
        "initialize",
        "shutdown",
        "exit",
        "initialize",
        "shutdown",
        "exit",
        "initialize",
        "shutdown",
        "exit",
        "initialize",
        "shutdown",
        "exit",
        "initialize"
      ]
    );
    assert.equal(alphaLogRestored[12].serverLogLevel, "info");
  });

  test("enables protocol tracing without restarting workspace clients",
    async function () {
      this.timeout(20_000);
      await Promise.all([
        rm(alphaTraceMarkerPath, { force: true }),
        rm(betaTraceMarkerPath, { force: true })
      ]);
      const [alphaBefore, betaBefore] = await Promise.all([
        readEvents(alphaMarkerPath),
        readEvents(betaMarkerPath)
      ]);
      const traceConfiguration = vscode.workspace.getConfiguration("titan");

      try {
        await traceConfiguration.update(
          "trace.server",
          "messages",
          vscode.ConfigurationTarget.Global
        );
        await Promise.all([
          waitForTraceValue(alphaTraceMarkerPath, "messages", 10_000),
          waitForTraceValue(betaTraceMarkerPath, "messages", 10_000)
        ]);

        await traceConfiguration.update(
          "trace.server",
          "verbose",
          vscode.ConfigurationTarget.Global
        );
        await Promise.all([
          waitForTraceValue(alphaTraceMarkerPath, "verbose", 10_000),
          waitForTraceValue(betaTraceMarkerPath, "verbose", 10_000)
        ]);

        await vscode.commands.executeCommand(
          "titan.showLanguageServerOutput"
        );
      } finally {
        await traceConfiguration.update(
          "trace.server",
          "off",
          vscode.ConfigurationTarget.Global
        );
      }

      await Promise.all([
        waitForTraceValue(alphaTraceMarkerPath, "off", 10_000),
        waitForTraceValue(betaTraceMarkerPath, "off", 10_000)
      ]);
      const [alphaAfter, betaAfter] = await Promise.all([
        readEvents(alphaMarkerPath),
        readEvents(betaMarkerPath)
      ]);
      assert.deepEqual(alphaAfter, alphaBefore);
      assert.deepEqual(betaAfter, betaBefore);
    });

  test("loads Titan highlighting in the Extension Host", async function () {
    this.timeout(10_000);
    const documentUri = vscode.Uri.joinPath(alpha.uri, "sample.titan");
    const document = await vscode.workspace.openTextDocument(documentUri);
    assert.equal(document.languageId, "titan");

    // This built-in test command runs VS Code's registered TextMate tokenizer,
    // so it verifies the installed grammar contribution rather than merely
    // loading the JSON with the repository's standalone tokenizer test.
    const tokens = await vscode.commands.executeCommand<CapturedSyntaxToken[]>(
      "_workbench.captureSyntaxTokens",
      documentUri
    );
    assert.ok(Array.isArray(tokens) && tokens.length > 0,
      "the Extension Host did not return Titan syntax tokens");
    assert.ok(
      tokens.some((token) =>
        token.c === "function" &&
        token.t.includes("storage.type.function.titan")
      ),
      "the Extension Host did not apply Titan's function-keyword scope"
    );
    assert.ok(
      tokens.some((token) =>
        token.c.includes("A long comment") &&
        token.t.includes("comment.block.titan")
      ),
      "the Extension Host did not apply Titan's long-comment scope"
    );
  });

  test("surfaces saved diagnostics and clears them when the client reloads",
    async function () {
      this.timeout(30_000);
      await resetMarker(alphaMarkerPath);
      const diagnosticArguments = [
        "../fake-lsp-server.cjs",
        ".titan-lsp-test/events.jsonl",
        "--diagnostics",
        "--fixture-token",
        "alpha-diagnostics"
      ];
      await vscode.workspace.getConfiguration(
        "titan.languageServer",
        alpha.uri
      ).update(
        "arguments",
        diagnosticArguments,
        vscode.ConfigurationTarget.WorkspaceFolder
      );
      await waitForInitializationToken(
        alphaMarkerPath,
        "alpha-diagnostics",
        10_000
      );

      const documentUri = vscode.Uri.joinPath(alpha.uri, "sample.titan");
      const published = await waitForDocumentDiagnostics(
        documentUri,
        (items) => items.length === 1,
        10_000
      );
      assert.equal(published[0].message, "fixture saved-source type error");
      assert.equal(published[0].source, "Titan");
      assert.equal(published[0].code, "type");
      assert.equal(published[0].severity, vscode.DiagnosticSeverity.Error);
      assert.equal(published[0].range.start.line, 1);
      assert.equal(published[0].range.start.character, 2);
      assert.equal(published[0].range.end.line, 1);
      assert.equal(published[0].range.end.character, 2);

      await vscode.workspace.getConfiguration(
        "titan.languageServer",
        alpha.uri
      ).update(
        "arguments",
        [
          "../fake-lsp-server.cjs",
          ".titan-lsp-test/events.jsonl",
          "--fixture-token",
          "alpha-after-diagnostics"
        ],
        vscode.ConfigurationTarget.WorkspaceFolder
      );
      await waitForInitializationToken(
        alphaMarkerPath,
        "alpha-after-diagnostics",
        10_000
      );
      await waitForDocumentDiagnostics(
        documentUri,
        (items) => items.length === 0,
        10_000
      );
    }
  );

  test("maps a remote workspace across the stdio URI boundary", () => {
    const remoteFolder: vscode.WorkspaceFolder = {
      index: 0,
      name: "remote",
      uri: vscode.Uri.parse(
        "vscode-remote://ssh-remote+fixture/workspace/titan-project"
      )
    };
    const [selector] = createWorkspaceDocumentSelector(remoteFolder);
    assert.equal(selector.language, "titan");
    assert.equal(selector.scheme, "vscode-remote");
    assert.equal(
      selector.pattern.baseUri,
      remoteFolder.uri.toString()
    );
    assert.equal(selector.pattern.pattern, "**/*.titan");

    const converters = createWorkspaceUriConverters(remoteFolder);
    assert.equal(
      converters.code2Protocol(remoteFolder.uri),
      "file:///workspace/titan-project"
    );
    const remoteDocument = vscode.Uri.parse(
      "vscode-remote://ssh-remote+fixture/workspace/titan-project/src/main.titan"
    );
    assert.equal(
      converters.code2Protocol(remoteDocument),
      "file:///workspace/titan-project/src/main.titan"
    );
    assert.equal(
      converters.protocol2Code(
        "file:///workspace/titan-project/src/library.titan"
      ).toString(),
      remoteFolder.uri.with({
        path: "/workspace/titan-project/src/library.titan"
      }).toString()
    );
    assert.equal(
      converters.protocol2Code("file:///opt/titan/stdlib/string.titan")
        .toString(),
      remoteFolder.uri.with({
        path: "/opt/titan/stdlib/string.titan"
      }).toString()
    );

    const otherRemote = vscode.Uri.parse(
      "vscode-remote://ssh-remote+other/workspace/elsewhere.titan"
    );
    assert.equal(
      converters.code2Protocol(otherRemote),
      otherRemote.toString(),
      "a client must not rewrite another remote authority"
    );
    assert.equal(
      converters.protocol2Code("https://example.test/library.titan")
        .toString(),
      "https://example.test/library.titan"
    );
  });

  test("leaves local workspace URIs unchanged", () => {
    const converters = createWorkspaceUriConverters(alpha);
    const localDocument = vscode.Uri.joinPath(alpha.uri, "sample.titan");
    assert.equal(
      converters.code2Protocol(localDocument),
      localDocument.toString()
    );
    assert.equal(
      converters.protocol2Code(localDocument.toString()).toString(),
      localDocument.toString()
    );
  });

  test("converts completion call snippets and restarts only the opted-out workspace",
    async function () {
      this.timeout(30_000);
      const configuration = vscode.workspace.getConfiguration("titan.languageServer", alpha.uri);
      const completionConfiguration = vscode.workspace.getConfiguration("titan.completion", alpha.uri);
      const previousArguments = configuration.inspect<string[]>("arguments")?.workspaceFolderValue;
      const previousSnippets = completionConfiguration.inspect<boolean>("insertCallSnippets")?.workspaceFolderValue;
      const fakeServer = path.resolve(__dirname, "../../../../test/fixtures/fake-lsp-server.cjs");
      const betaBefore = (await readEvents(betaMarkerPath)).filter((event) => event.event === "initialize").at(-1);
      let document: vscode.TextDocument | undefined;
      try {
        await completionConfiguration.update("insertCallSnippets", true, vscode.ConfigurationTarget.WorkspaceFolder);
        await configuration.update("arguments", [fakeServer, alphaMarkerPath, "--semantic", "--completion",
          "--call-completion", "--fixture-token", "call-snippets"], vscode.ConfigurationTarget.WorkspaceFolder);
        const initialization = await waitForInitializationToken(alphaMarkerPath, "call-snippets", 10_000);
        assert.deepEqual(initialization.initializationOptions, { insertCallSnippets: true });
        document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(alpha.uri, "sample.titan"));
        await replaceDocumentText(document, "method");
        const item = await waitForNamedCompletion(
          document, new vscode.Position(0, 3), "method", 10_000);
        assert.ok(item, "call completion did not reach the editor");
        assert.ok(item.insertText instanceof vscode.SnippetString);
        assert.equal(item.insertText.value, "method(${1:count}, ${2:label})$0");
        assert.equal(item.detail, "method(count: integer, label: string): boolean");
        assert.notEqual(typeof item.label, "string");
        const label = item.label as vscode.CompletionItemLabel;
        assert.equal(label.label, "method");
        assert.equal(label.detail, "(count: integer, label: string): boolean");
        assert.ok(item.range instanceof vscode.Range);
        assert.equal(item.range.start.character, 0);
        assert.equal(item.range.end.character, 6);

        await completionConfiguration.update("insertCallSnippets", false, vscode.ConfigurationTarget.WorkspaceFolder);
        const optedOut = await waitForInitializationToken(alphaMarkerPath, "call-snippets", 10_000, initialization.pid);
        assert.notEqual(optedOut.pid, initialization.pid);
        assert.deepEqual(optedOut.initializationOptions, { insertCallSnippets: false });
        const reference = await waitForNamedCompletion(
          document, new vscode.Position(0, 3), "method", 10_000);
        assert.ok(reference, "name-only completion did not reach the editor");
        assert.equal(reference.insertText, "method");
        const betaAfter = (await readEvents(betaMarkerPath)).filter((event) => event.event === "initialize").at(-1);
        assert.equal(betaAfter?.pid, betaBefore?.pid, "alpha completion preference restarted beta");
      } finally {
        if (document?.isDirty) {
          await vscode.window.showTextDocument(document);
          await vscode.commands.executeCommand("workbench.action.files.revert");
          await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        }
        const previousEventCount = (await readEvents(alphaMarkerPath)).length;
        await completionConfiguration.update("insertCallSnippets", previousSnippets, vscode.ConfigurationTarget.WorkspaceFolder);
        await configuration.update("arguments", previousArguments, vscode.ConfigurationTarget.WorkspaceFolder);
        const previousToken = previousArguments?.at(-1);
        if (previousToken !== undefined) {
          await waitForInitializationToken(alphaMarkerPath, previousToken, 10_000, undefined, previousEventCount);
        }
      }
    }
  );

  test("routes nested-root semantics only to the most-specific workspace",
    async function () {
      this.timeout(30_000);
      const repositoryRoot = path.resolve(__dirname, "../../../..");
      const fakeServer = path.join(
        repositoryRoot,
        "test",
        "fixtures",
        "fake-lsp-server.cjs"
      );
      const nestedRoot = path.join(alpha.uri.fsPath, "nested-project");
      const nestedLifecycleMarker = path.join(
        alpha.uri.fsPath,
        ".titan-lsp-test",
        "nested-events.jsonl"
      );
      const nestedSemanticMarker = path.join(
        alpha.uri.fsPath,
        ".titan-lsp-test",
        "nested-semantic.jsonl"
      );
      const outerSemanticMarker = path.join(
        alpha.uri.fsPath,
        ".titan-lsp-test",
        "semantic.jsonl"
      );
      const nestedArguments = [
        fakeServer,
        nestedLifecycleMarker,
        "--semantic",
        "--completion",
        "--semantic-marker",
        nestedSemanticMarker,
        "--fixture-token",
        "nested-inner"
      ];
      let nestedFolder: vscode.WorkspaceFolder | undefined;
      let document: vscode.TextDocument | undefined;

      await rm(nestedRoot, { force: true, recursive: true });
      await mkdir(path.join(nestedRoot, ".vscode"), { recursive: true });
      await writeFile(
        path.join(nestedRoot, "sample.titan"),
        "function nested(): integer\n  return 1\nend\n",
        "utf8"
      );
      await writeFile(
        path.join(nestedRoot, ".vscode", "settings.json"),
        `${JSON.stringify({
          "titan.languageServer.arguments": [
            fakeServer,
            nestedLifecycleMarker,
            "--fixture-token",
            "nested-bootstrap"
          ]
        }, null, 2)}\n`,
        "utf8"
      );

      try {
        await resetMarker(alphaMarkerPath);
        await rm(outerSemanticMarker, { force: true });
        await vscode.workspace.getConfiguration(
          "titan.languageServer",
          alpha.uri
        ).update(
          "arguments",
          [
            fakeServer,
            alphaMarkerPath,
            "--semantic",
            "--completion",
            "--semantic-marker",
            outerSemanticMarker,
            "--fixture-token",
            "nested-outer"
          ],
          vscode.ConfigurationTarget.WorkspaceFolder
        );
        const initialEvents = await waitForEventSequence(
          alphaMarkerPath,
          ["shutdown", "exit", "initialize"],
          10_000
        );
        const initialOuterPid = initialEvents[2].pid;
        document = await vscode.workspace.openTextDocument(
          vscode.Uri.file(path.join(nestedRoot, "sample.titan"))
        );
        await replaceDocumentText(document, "local before_nested = 1\n");
        assert.equal(document.isDirty, true);
        assert.equal(await waitForBufferCompletion(document, 10_000),
          initialOuterPid);

        await updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          0,
          { uri: vscode.Uri.file(nestedRoot), name: "nested" }
        );
        nestedFolder = findWorkspaceFolder(
          vscode.workspace.workspaceFolders ?? [],
          "nested"
        );
        await vscode.workspace.getConfiguration(
          "titan.languageServer",
          nestedFolder.uri
        ).update(
          "arguments",
          nestedArguments,
          vscode.ConfigurationTarget.WorkspaceFolder
        );
        const initialization = await waitForInitializationToken(
          nestedLifecycleMarker,
          "nested-inner",
          10_000
        );

        assert.equal(await waitForBufferCompletion(document, 10_000),
          initialization.pid,
          "the new nested client must open the already dirty document");
        await waitForProcessEvents(alphaMarkerPath, initialOuterPid,
          ["shutdown", "exit"], 10_000);
        const outerAfterAdd = (await readEvents(alphaMarkerPath))
          .filter((event) => event.event === "initialize").at(-1)!;
        assert.notEqual(outerAfterAdd.pid, initialOuterPid,
          "adding a nested root must discard the ancestor's old buffer session");
        await replaceDocumentText(document, "local inside_nested = 2\n");
        assert.equal(await waitForBufferCompletion(document, 10_000),
          initialization.pid);
        // Every buffer event and completion belongs to the same most-specific
        // owner as saved-file requests, even while the outer selector matches.
        const outerMiddleware = createWorkspaceMiddleware(alpha);
        const innerMiddleware = createWorkspaceMiddleware(nestedFolder);
        const routed: string[] = [];
        const changed: vscode.TextDocumentChangeEvent = {
          document, contentChanges: [], reason: undefined
        };
        const cancellation = new vscode.CancellationTokenSource();
        try {
          for (const [owner, middleware] of [
            ["outer", outerMiddleware], ["inner", innerMiddleware]
          ] as const) {
            for (const method of ["didOpen", "didSave", "didClose"] as const) {
              await middleware[method]!(document, async () => {
                routed.push(`${owner}:${method}`);
              });
            }
            await middleware.didChange!(changed, async () => {
              routed.push(`${owner}:didChange`);
            });
            await middleware.provideCompletionItem!(
              document, new vscode.Position(0, 0),
              { triggerKind: vscode.CompletionTriggerKind.Invoke, triggerCharacter: undefined },
              cancellation.token, () => {
                routed.push(`${owner}:completion`);
                return [];
              }
            );
          }
        } finally {
          cancellation.dispose();
        }
        assert.deepEqual(routed, [
          "inner:didOpen", "inner:didSave", "inner:didClose",
          "inner:didChange", "inner:completion"
        ]);
        await exerciseSemanticProviders(document.uri);

        const expectedMethods = [
          "textDocument/definition",
          "textDocument/references",
          "textDocument/hover",
          "textDocument/prepareRename",
          // The execute-rename command performs its own preparation after the
          // explicit prepareRename check above.
          "textDocument/prepareRename",
          "textDocument/rename",
          "textDocument/foldingRange"
        ];
        const innerRequests = await waitForSemanticMethods(
          nestedSemanticMarker,
          expectedMethods,
          10_000
        );
        assert.deepEqual(
          innerRequests.map((event) => event.method),
          expectedMethods
        );
        await delay(300);
        const physicalDocumentUri = vscode.Uri.file(
          await realpath(document.uri.fsPath)
        ).toString();
        for (const request of await readSemanticEvents(nestedSemanticMarker)) {
          assert.equal(request.pid, initialization.pid);
          assert.equal(request.uri, physicalDocumentUri);
        }
        assert.deepEqual(
          await readSemanticEvents(outerSemanticMarker),
          [],
          "the outer workspace client received requests for its nested root"
        );

        await updateWorkspaceFolders(nestedFolder.index, 1);
        nestedFolder = undefined;
        await waitForProcessEvents(
          nestedLifecycleMarker,
          initialization.pid,
          ["shutdown", "exit"],
          10_000
        );
        const restoredOuterPid = await waitForBufferCompletion(document, 10_000);
        assert.notEqual(restoredOuterPid, initialization.pid);
        assert.notEqual(restoredOuterPid, outerAfterAdd.pid,
          "removing a nested root must reopen its dirty documents in the ancestor");
        await replaceDocumentText(document, "local after_nested = 3\n");
        assert.equal(await waitForBufferCompletion(document, 10_000),
          restoredOuterPid);
      } finally {
        if (nestedFolder !== undefined) {
          try {
            await updateWorkspaceFolders(nestedFolder.index, 1);
          } catch {
            // Preserve the primary assertion failure during best-effort cleanup.
          }
        }
        if (document?.isDirty) {
          await vscode.window.showTextDocument(document);
          await vscode.commands.executeCommand("workbench.action.files.revert");
          await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        }
        await rm(nestedRoot, { force: true, recursive: true });
      }
    }
  );

  test("maps a lexical symlink workspace to one physical server root",
    async function () {
      this.timeout(30_000);
      const repositoryRoot = path.resolve(__dirname, "../../../..");
      const fakeServer = path.join(
        repositoryRoot,
        "test",
        "fixtures",
        "fake-lsp-server.cjs"
      );
      const physicalRoot = await mkdtemp(
        path.join(tmpdir(), "vscode-titan-physical-")
      );
      const canonicalRoot = await realpath(physicalRoot);
      const lexicalRoot = `${physicalRoot}-link`;
      const lifecycleMarker = `${physicalRoot}-events.jsonl`;
      const semanticMarker = `${physicalRoot}-semantic.jsonl`;
      const symlinkArguments = [
        fakeServer,
        lifecycleMarker,
        "--semantic",
        "--semantic-marker",
        semanticMarker,
        "--fixture-token",
        "symlink"
      ];
      let symlinkFolder: vscode.WorkspaceFolder | undefined;

      try {
        try {
          await symlink(physicalRoot, lexicalRoot, "dir");
        } catch (cause) {
          if (process.platform === "win32" &&
              (cause as NodeJS.ErrnoException).code === "EPERM") {
            this.skip();
          }
          throw cause;
        }
        await mkdir(path.join(physicalRoot, ".vscode"), { recursive: true });
        await writeFile(
          path.join(physicalRoot, "sample.titan"),
          "function linked(): integer\n  return 1\nend\n",
          "utf8"
        );
        await writeFile(
          path.join(physicalRoot, ".vscode", "settings.json"),
          `${JSON.stringify({
            "titan.languageServer.arguments": [
              fakeServer,
              lifecycleMarker,
              "--fixture-token",
              "symlink-bootstrap"
            ]
          }, null, 2)}\n`,
          "utf8"
        );
        await updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          0,
          { uri: vscode.Uri.file(lexicalRoot), name: "symlink" }
        );
        symlinkFolder = findWorkspaceFolder(
          vscode.workspace.workspaceFolders ?? [],
          "symlink"
        );
        assertNativePathEqual(symlinkFolder.uri.fsPath, lexicalRoot);

        await vscode.workspace.getConfiguration(
          "titan.languageServer",
          symlinkFolder.uri
        ).update(
          "arguments",
          symlinkArguments,
          vscode.ConfigurationTarget.WorkspaceFolder
        );
        const initialization = await waitForInitializationToken(
          lifecycleMarker,
          "symlink",
          10_000
        );
        const canonicalUri = vscode.Uri.file(canonicalRoot).toString();
        assertNativePathEqual(initialization.cwd, canonicalRoot);
        // vscode-languageclient keeps the deprecated rootPath lexical, but the
        // authoritative rootUri and every document URI use our converter.
        assertNativePathEqual(initialization.rootPath, lexicalRoot);
        assert.equal(initialization.rootUri, canonicalUri);
        assert.deepEqual(initialization.workspaceFolders, [{
          uri: canonicalUri,
          name: "symlink"
        }]);

        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(symlinkFolder.uri, "sample.titan")
        );
        const definitions = await vscode.commands.executeCommand<
          Array<vscode.Location | vscode.LocationLink>
        >(
          "vscode.executeDefinitionProvider",
          document.uri,
          new vscode.Position(0, 1)
        );
        assert.equal(definitions.length, 1);
        assert.ok(definitions[0] instanceof vscode.Location);
        assert.equal(definitions[0].uri.toString(), document.uri.toString());

        const [request] = await waitForSemanticMethods(
          semanticMarker,
          ["textDocument/definition"],
          10_000
        );
        assert.equal(
          request.uri,
          vscode.Uri.joinPath(
            vscode.Uri.file(canonicalRoot),
            "sample.titan"
          ).toString()
        );

        await updateWorkspaceFolders(symlinkFolder.index, 1);
        symlinkFolder = undefined;
        await waitForProcessEvents(
          lifecycleMarker,
          initialization.pid,
          ["shutdown", "exit"],
          10_000
        );
      } finally {
        if (symlinkFolder !== undefined) {
          try {
            await updateWorkspaceFolders(symlinkFolder.index, 1);
          } catch {
            // Preserve the primary assertion failure during best-effort cleanup.
          }
        }
        await rm(lexicalRoot, { force: true });
        await rm(physicalRoot, { force: true, recursive: true });
        await rm(lifecycleMarker, { force: true });
        await rm(semanticMarker, { force: true });
      }
    }
  );

  test("reaps a server whose initialize request fails before retrying",
    async function () {
      this.timeout(30_000);
      await resetMarker(alphaMarkerPath);

      await vscode.workspace.getConfiguration(
        "titan.languageServer",
        alpha.uri
      ).update(
        "arguments",
        [
          "../fake-lsp-server.cjs",
          ".titan-lsp-test/events.jsonl",
          "--initialize-error-stay-alive",
          "--fixture-token",
          "alpha-initialize-failed"
        ],
        vscode.ConfigurationTarget.WorkspaceFolder
      );

      const failed = await waitForEventSequence(
        alphaMarkerPath,
        ["shutdown", "exit", "initialize", ...forcedTerminationEvents],
        10_000
      );
      const failedPid = failed[2].pid;
      await assertForcedTermination(failed, failedPid, 10_000);

      await vscode.workspace.getConfiguration(
        "titan.languageServer",
        alpha.uri
      ).update(
        "arguments",
        [
          "../fake-lsp-server.cjs",
          ".titan-lsp-test/events.jsonl",
          "--fixture-token",
          "alpha-after-initialize-failure"
        ],
        vscode.ConfigurationTarget.WorkspaceFolder
      );

      const retried = await assertStableEventSequence(
        alphaMarkerPath,
        ["shutdown", "exit", "initialize", ...forcedTerminationEvents,
          "initialize"]
      );
      const retryPid = retried.at(-1)!.pid;
      assert.notEqual(retryPid, failedPid);
      const livingPids = [...new Set(retried.map((event) => event.pid))]
        .filter(isProcessAlive);
      assert.deepEqual(
        livingPids,
        [retryPid],
        "retry should own exactly one living language-server process"
      );
    }
  );

  test("replaces a server after its shutdown request times out",
    async function () {
      this.timeout(30_000);
      const repositoryRoot = path.resolve(__dirname, "../../../..");
      const fakeServer = path.join(
        repositoryRoot,
        "test",
        "fixtures",
        "fake-lsp-server.cjs"
      );
      await resetMarker(alphaMarkerPath);

      await vscode.workspace.getConfiguration(
        "titan.languageServer",
        alpha.uri
      ).update(
        "arguments",
        [
          fakeServer,
          alphaMarkerPath,
          "--ignore-shutdown",
          "--fixture-token",
          "alpha-ignore-shutdown"
        ],
        vscode.ConfigurationTarget.WorkspaceFolder
      );
      const ignoring = await waitForEventSequence(
        alphaMarkerPath,
        ["shutdown", "exit", "initialize"],
        10_000
      );
      const ignoredShutdownPid = ignoring[2].pid;

      await vscode.workspace.getConfiguration(
        "titan.languageServer",
        alpha.uri
      ).update(
        "arguments",
        [
          fakeServer,
          alphaMarkerPath,
          "--fixture-token",
          "alpha-after-shutdown-timeout"
        ],
        vscode.ConfigurationTarget.WorkspaceFolder
      );

      const replaced = await assertStableEventSequence(
        alphaMarkerPath,
        [
          "shutdown",
          "exit",
          "initialize",
          "shutdown",
          ...forcedTerminationEvents,
          "initialize"
        ]
      );
      assert.equal(replaced[3].pid, ignoredShutdownPid);
      const replacementPid = replaced.at(-1)!.pid;
      assert.notEqual(replacementPid, ignoredShutdownPid);
      await assertForcedTermination(replaced, ignoredShutdownPid, 10_000);

      const livingPids = [...new Set(replaced.map((event) => event.pid))]
        .filter(isProcessAlive);
      assert.deepEqual(
        livingPids,
        [replacementPid],
        "shutdown recovery should own exactly one living server process"
      );
    }
  );

  test("does not let a hanging workspace block another workspace",
    async function () {
      this.timeout(50_000);
      const previousAlpha = (await readEvents(alphaMarkerPath))
        .filter((event) => event.event === "initialize").at(-1);
      assert.ok(previousAlpha, "alpha should have a running fixture server");
      await Promise.all([
        resetMarker(alphaMarkerPath),
        resetMarker(betaMarkerPath)
      ]);

      const previousHangRoot = process.env.TITAN_LSP_FIXTURE_HANG_ROOT;
      // The fake server compares this byte-for-byte with process.cwd(). Use
      // its observed native spelling, including the Windows drive letter.
      process.env.TITAN_LSP_FIXTURE_HANG_ROOT = previousAlpha.cwd;
      try {
        const globalLuaCPath = "/fixture/compiler/start-timeout/?.so";
        await vscode.workspace.getConfiguration("titan.compiler").update(
          "luaCPath",
          globalLuaCPath,
          vscode.ConfigurationTarget.Global
        );

        // Alpha deliberately never answers initialize. Beta must nevertheless
        // become ready well before alpha's 30-second startup deadline.
        const [, betaStarted] = await Promise.all([
          waitForEventSequence(
            alphaMarkerPath,
            ["shutdown", "exit", "initialize"],
            10_000
          ),
          waitForEventSequence(
            betaMarkerPath,
            ["shutdown", "exit", "initialize"],
            10_000
          )
        ]);
        const alphaBeforeTimeout = await readEvents(alphaMarkerPath);
        assert.deepEqual(
          alphaBeforeTimeout.map((event) => event.event),
          ["shutdown", "exit", "initialize"],
          "beta should start before alpha reaches its startup timeout"
        );
        assert.equal(isProcessAlive(alphaBeforeTimeout[2].pid), true,
          "hanging alpha should remain alive when beta becomes ready");
        assert.equal(betaStarted[2].luaCPath, globalLuaCPath);
      } finally {
        if (previousHangRoot === undefined) {
          delete process.env.TITAN_LSP_FIXTURE_HANG_ROOT;
        } else {
          process.env.TITAN_LSP_FIXTURE_HANG_ROOT = previousHangRoot;
        }
      }

      const alphaTimedOut = await waitForEventSequence(
        alphaMarkerPath,
        ["shutdown", "exit", "initialize", ...forcedTerminationEvents],
        35_000
      );
      const hangingPid = alphaTimedOut[2].pid;
      await assertForcedTermination(alphaTimedOut, hangingPid, 35_000);

      await vscode.workspace.getConfiguration(
        "titan.languageServer",
        alpha.uri
      ).update(
        "arguments",
        [
          "../fake-lsp-server.cjs",
          ".titan-lsp-test/events.jsonl",
          "--fixture-token",
          "alpha-after-start-timeout"
        ],
        vscode.ConfigurationTarget.WorkspaceFolder
      );

      const alphaRetried = await assertStableEventSequence(
        alphaMarkerPath,
        ["shutdown", "exit", "initialize", ...forcedTerminationEvents,
          "initialize"]
      );
      const betaStable = await assertStableEventSequence(
        betaMarkerPath,
        ["shutdown", "exit", "initialize"]
      );
      const retryPid = alphaRetried.at(-1)!.pid;
      const betaPid = betaStable[2].pid;
      assert.notEqual(retryPid, hangingPid);

      const observedPids = new Set([
        ...alphaRetried.map((event) => event.pid),
        ...betaStable.map((event) => event.pid)
      ]);
      const livingPids = [...observedPids]
        .filter(isProcessAlive)
        .sort((left, right) => left - right);
      assert.deepEqual(
        livingPids,
        [retryPid, betaPid].sort((left, right) => left - right),
        "the retry and beta should be the only living language-server processes"
      );
    }
  );

  test("connects VS Code to the selected native server and closes it", async function () {
    this.timeout(90_000);
    const repositoryRoot = path.resolve(__dirname, "../../../..");
    const server = resolveServerExecutable(
      process.env.TITAN_LSP_TEST_SERVER ?? "",
      repositoryRoot,
      repositoryRoot
    );
    await ensureServerExecutable(server);
    const extension = vscode.extensions.getExtension(extensionIdentifier);
    assert.ok(extension, `${extensionIdentifier} should be installed`);
    const modulePrefix = path.join(extension.extensionPath, "dist", "titan");
    const bundledLuaPath = [
      path.join(modulePrefix, "share", "lua", "5.5", "?.lua"),
      path.join(modulePrefix, "share", "lua", "5.5", "?", "init.lua")
    ].join(";");
    const bundledLuaCPath = path.join(
      modulePrefix, "lib", "lua", "5.5", process.platform === "win32" ? "?.dll" : "?.so"
    );

    const lifecycle = process.env.TITAN_LSP_TEST_LIFECYCLE;
    const selectedLuaPath = process.env.TITAN_LSP_TEST_LUA_PATH;
    const selectedLuaCPath = process.env.TITAN_LSP_TEST_LUA_CPATH;
    assert.equal(selectedLuaPath === undefined, selectedLuaCPath === undefined,
      "selected native compiler discovery requires both Lua paths");
    const betaInitialization = (await readEvents(betaMarkerPath))
      .filter((event) => event.event === "initialize").at(-1);
    assert.ok(betaInitialization, "beta should have a running fixture server");
    const previousInitializeDelayRoot = process.env.TITAN_LSP_FIXTURE_INITIALIZE_DELAY_ROOT;
    // Exercise a slower beta restart. Every global configuration change affects
    // both clients, so neither marker may be reset while beta is still starting.
    process.env.TITAN_LSP_FIXTURE_INITIALIZE_DELAY_ROOT = betaInitialization.cwd;
    try {
      await Promise.all([resetMarker(alphaMarkerPath), resetMarker(betaMarkerPath)]);
      await vscode.workspace.getConfiguration("titan.compiler").update(
        "luaPath", "", vscode.ConfigurationTarget.Global);
      await Promise.all([alphaMarkerPath, betaMarkerPath].map((marker) =>
        waitForEventSequence(marker, ["shutdown", "exit", "initialize"], 10_000)));
      await vscode.workspace.getConfiguration("titan.compiler").update(
        "luaCPath", "", vscode.ConfigurationTarget.Global);
      const defaulted = await Promise.all([alphaMarkerPath, betaMarkerPath].map((marker) =>
        waitForEventSequence(marker, [
          "shutdown", "exit", "initialize", "shutdown", "exit", "initialize"
        ], 10_000)));
      for (const events of defaulted) {
        const initialization = events[5];
        const actualLuaTemplates = initialization.luaPath?.split(";");
        const expectedLuaTemplates = bundledLuaPath.split(";");
        assert.ok(actualLuaTemplates, "bundled Lua path should be present");
        assert.equal(actualLuaTemplates.length, expectedLuaTemplates.length);
        for (const [index, expected] of expectedLuaTemplates.entries()) {
          assertNativePathEqual(actualLuaTemplates[index], expected);
        }
        assertNativePathEqual(initialization.luaCPath, bundledLuaCPath);
        assert.equal(initialization.compilerCachePrefix, process.env.TITAN_PREFIX);
      }
      if (selectedLuaPath !== undefined) {
        assert.ok(selectedLuaCPath !== undefined);
        for (const [name, value] of [
          ["luaPath", selectedLuaPath], ["luaCPath", selectedLuaCPath]
        ]) {
          await Promise.all([resetMarker(alphaMarkerPath), resetMarker(betaMarkerPath)]);
          await vscode.workspace.getConfiguration("titan.compiler").update(
            name, value, vscode.ConfigurationTarget.Global);
          await Promise.all([
            waitForEventSequence(alphaMarkerPath, ["shutdown", "exit", "initialize"], 10_000),
            waitForEventSequence(betaMarkerPath, ["shutdown", "exit", "initialize"], 10_000)
          ]);
        }
      }
    } finally {
      if (previousInitializeDelayRoot === undefined) {
        delete process.env.TITAN_LSP_FIXTURE_INITIALIZE_DELAY_ROOT;
      } else {
        process.env.TITAN_LSP_FIXTURE_INITIALIZE_DELAY_ROOT = previousInitializeDelayRoot;
      }
    }
    const nodeExecutable = process.env.npm_node_execpath;
    assert.ok(nodeExecutable, "npm_node_execpath should identify Node");
    const previousArguments = [alpha, beta].map((folder) =>
      vscode.workspace.getConfiguration("titan.languageServer", folder.uri)
        .inspect<string[]>("arguments")?.workspaceFolderValue);
    try {
      if (lifecycle !== undefined) {
        // Coverage keeps the selected executable in its own immutable build.
        // The proxy records native close after its counters flush; it forwards
        // stdio directly and does not replace the LSP transport.
        for (const folder of [alpha, beta]) {
          await vscode.workspace.getConfiguration("titan.languageServer", folder.uri)
            .update("arguments", [
              path.join(repositoryRoot, "scripts", "run-extension-host-tests.mjs"),
              "--native-server", server, path.join(lifecycle, `${folder.name}.jsonl`)
            ], vscode.ConfigurationTarget.WorkspaceFolder);
        }
        for (const folder of [alpha, beta]) {
          await waitForNativeServerStart(path.join(lifecycle, `${folder.name}.jsonl`),
            server, 10_000);
        }
      } else {
        await vscode.workspace.getConfiguration("titan.languageServer").update(
          "path", server, vscode.ConfigurationTarget.Global);
      }

      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(alpha.uri, "sample.titan")
      );
      const useOffset = document.getText().lastIndexOf("render");
      assert.ok(useOffset >= 0, "native-server fixture has no render use");
      const definitions = await waitForDefinitions(
        document.uri, document.positionAt(useOffset + 1), 20_000);
      assert.equal(definitions.length, 1);
      const definition = definitions[0];
      assert.ok(definition instanceof vscode.Location);
      assert.equal(definition.uri.toString(), document.uri.toString());
      assert.equal(definition.range.start.line, 13);
      assert.equal(definition.range.start.character, 15);
      assert.equal(definition.range.end.character, 21);
    } finally {
      // Starting the ordinary fixtures again negotiates shutdown/exit with both
      // native servers while the Extension Host is still alive. Do not rely on
      // Electron teardown to flush coverage from a detached native process.
      await Promise.all([resetMarker(alphaMarkerPath), resetMarker(betaMarkerPath)]);
      if (lifecycle !== undefined) {
        for (const [index, folder] of [alpha, beta].entries()) {
          await vscode.workspace.getConfiguration("titan.languageServer", folder.uri)
            .update("arguments", previousArguments[index],
              vscode.ConfigurationTarget.WorkspaceFolder);
        }
      } else {
        await vscode.workspace.getConfiguration("titan.languageServer").update(
          "path", nodeExecutable, vscode.ConfigurationTarget.Global);
      }
      await Promise.all([
        waitForEventSequence(alphaMarkerPath, ["initialize"], 10_000),
        waitForEventSequence(betaMarkerPath, ["initialize"], 10_000)
      ]);
      if (lifecycle !== undefined) {
        for (const folder of [alpha, beta]) {
          await assertNativeServerClosed(path.join(lifecycle, `${folder.name}.jsonl`),
            server, 10_000);
        }
      }
    }
  });
});

async function nativeServerEvents(receipt: string): Promise<Array<{
  event: string; pid: number; server?: string; code?: number; signal?: string | null;
}>> {
  const contents = await readFile(receipt, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "ENOENT") throw cause;
    return "";
  });
  return contents.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForNativeServerStart(
  receipt: string,
  server: string,
  timeoutMilliseconds: number
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const events = await nativeServerEvents(receipt);
    if (events.length > 0) {
      assert.equal(events[0].event, "spawn");
      assert.equal(events[0].server, server);
      assert.equal(events.length, 1, "native server exited during startup");
      return;
    }
    await delay(50);
  }
  assert.fail(`native server did not start: ${receipt}`);
}

async function assertNativeServerClosed(
  receipt: string,
  server: string,
  timeoutMilliseconds: number
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const events = await nativeServerEvents(receipt);
    if (events.some((event) => event.event === "close")) {
      assert.equal(events.length, 2, "native server lifecycle has extra events");
      assert.equal(events[0].event, "spawn");
      assert.equal(events[0].server, server);
      assert.deepEqual(events[1], {
        event: "close", pid: events[0].pid, code: 0, signal: null
      }, "native server was terminated before graceful exit");
      await assertProcessExited(events[0].pid, timeoutMilliseconds);
      return;
    }
    await delay(50);
  }
  assert.fail(`native server did not close: ${receipt}`);
}

function findWorkspaceFolder(
  folders: readonly vscode.WorkspaceFolder[],
  name: string
): vscode.WorkspaceFolder {
  const folder = folders.find((candidate) => candidate.name === name);
  assert.ok(folder, `workspace folder ${name} should be open`);
  return folder;
}

async function replaceDocumentText(
  document: vscode.TextDocument,
  text: string
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(
    document.positionAt(0), document.positionAt(document.getText().length)
  ), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

async function waitForBufferCompletion(
  document: vscode.TextDocument,
  timeoutMilliseconds: number
): Promise<number> {
  const deadline = Date.now() + timeoutMilliseconds;
  let labels: string[] = [];
  while (Date.now() < deadline) {
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider", document.uri,
      document.positionAt(document.getText().length)
    );
    labels = (result?.items ?? []).map((item) =>
      typeof item.label === "string" ? item.label : item.label.label);
    const item = result?.items.find((item) =>
      item.label === document.getText().trim());
    if (item !== undefined) return Number(item.detail);
    await delay(50);
  }
  assert.fail(`completion did not receive current dirty text; labels: ${labels}`);
}

async function waitForNamedCompletion(
  document: vscode.TextDocument,
  position: vscode.Position,
  name: string,
  timeoutMilliseconds: number
): Promise<vscode.CompletionItem> {
  const deadline = Date.now() + timeoutMilliseconds;
  let labels: string[] = [];
  while (Date.now() < deadline) {
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider", document.uri, position);
    const items = result?.items ?? [];
    labels = items.map((item) =>
      typeof item.label === "string" ? item.label : item.label.label);
    const index = labels.indexOf(name);
    if (index >= 0) return items[index];
    await delay(50);
  }
  assert.fail(`completion ${name} did not reach the editor; labels: ${labels}`);
}

async function assertInitialization(
  event: FixtureEvent,
  folder: vscode.WorkspaceFolder,
  token: string,
  luaPath: string,
  luaCPath: string
): Promise<void> {
  const physicalRoot = await realpath(folder.uri.fsPath);
  const physicalUri = vscode.Uri.file(physicalRoot).toString();
  assertNativePathEqual(event.cwd, physicalRoot);
  assert.deepEqual(event.arguments, ["--fixture-token", token]);
  assert.equal(event.luaPath, luaPath);
  assert.equal(event.luaCPath, luaCPath);
  assert.equal(event.compilerCachePrefix, process.env.TITAN_PREFIX,
    "the native server owns the default probe-cache location");
  assert.equal(event.serverLogLevel, "info");
  assert.equal(event.trace, "off");
  assert.deepEqual(event.initializationOptions, { insertCallSnippets: true });
  assertNativePathEqual(event.rootPath, folder.uri.fsPath);
  assert.equal(event.rootUri, physicalUri);
  assert.deepEqual(event.workspaceFolders, [{
    uri: physicalUri,
    name: folder.name
  }]);
}

function assertNativePathEqual(
  actual: string | null | undefined,
  expected: string
): void {
  assert.equal(typeof actual, "string");
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return process.platform === "win32"
      ? normalized.replace(/^[a-z]:/i, (drive) => drive.toUpperCase())
      : normalized;
  };
  assert.equal(normalize(actual as string), normalize(expected));
}

async function resetMarker(markerPath: string): Promise<void> {
  await rm(path.dirname(markerPath), { force: true, recursive: true });
  await mkdir(path.dirname(markerPath), { recursive: true });
}

async function updateWorkspaceFolders(
  start: number,
  deleteCount: number,
  ...foldersToAdd: Array<{ uri: vscode.Uri; name?: string }>
): Promise<void> {
  const changed = new Promise<void>((resolve, reject) => {
    const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearTimeout(timeout);
      disposable.dispose();
      resolve();
    });
    const timeout = setTimeout(() => {
      disposable.dispose();
      reject(new Error("timed out waiting for workspace folders to change"));
    }, 10_000);
  });

  assert.equal(
    vscode.workspace.updateWorkspaceFolders(
      start,
      deleteCount,
      ...foldersToAdd
    ),
    true,
    "workspace folder update should start"
  );
  await changed;
}

async function assertStableEventSequence(
  file: string,
  expected: FixtureEvent["event"][]
): Promise<FixtureEvent[]> {
  await waitForEventSequence(file, expected, 10_000);
  await delay(300);
  const observed = await readEvents(file);
  assert.deepEqual(
    observed.map((event) => event.event),
    expected,
    `unexpected process lifecycle in ${file}`
  );
  return observed;
}

async function waitForEventSequence(
  file: string,
  expected: FixtureEvent["event"][],
  timeoutMilliseconds: number
): Promise<FixtureEvent[]> {
  const deadline = Date.now() + timeoutMilliseconds;
  let observed: FixtureEvent[] = [];
  while (Date.now() < deadline) {
    observed = await readEvents(file);
    if (expected.every((event, index) => observed[index]?.event === event)) {
      return observed;
    }
    await delay(50);
  }
  assert.fail(
    `timed out waiting for ${expected.join(", ")} in ${file}; observed ` +
    observed.map((event) => event.event).join(", ")
  );
}

async function waitForInitializationToken(
  file: string,
  token: string,
  timeoutMilliseconds: number,
  previousPid?: number,
  afterEventCount: number = 0
): Promise<FixtureEvent> {
  const deadline = Date.now() + timeoutMilliseconds;
  let observed: FixtureEvent[] = [];
  while (Date.now() < deadline) {
    observed = await readEvents(file);
    const initialization = observed.slice(afterEventCount).find((event) =>
      event.event === "initialize" && event.arguments.includes(token) &&
      event.pid !== previousPid);
    if (initialization !== undefined) {
      return initialization;
    }
    await delay(50);
  }
  assert.fail(
    `timed out waiting for initialization token ${token} in ${file}; ` +
      `observed ${observed.map((event) =>
        `${event.event}:${event.arguments.join(" ")}`).join(", ")}`
  );
}

async function waitForProcessEvents(
  file: string,
  pid: number,
  expected: FixtureEvent["event"][],
  timeoutMilliseconds: number
): Promise<FixtureEvent[]> {
  const deadline = Date.now() + timeoutMilliseconds;
  let observed: FixtureEvent[] = [];
  while (Date.now() < deadline) {
    observed = (await readEvents(file)).filter((event) => event.pid === pid);
    if (expected.every((event) =>
      observed.some((candidate) => candidate.event === event))) {
      return observed;
    }
    await delay(50);
  }
  assert.fail(
    `timed out waiting for ${expected.join(", ")} from process ${pid} in ` +
      `${file}; observed ${observed.map((event) => event.event).join(", ")}`
  );
}

async function readEvents(file: string): Promise<FixtureEvent[]> {
  try {
    const contents = await readFile(file, "utf8");
    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FixtureEvent);
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }
}

async function waitForDocumentDiagnostics(
  uri: vscode.Uri,
  predicate: (items: readonly vscode.Diagnostic[]) => boolean,
  timeoutMilliseconds: number
): Promise<readonly vscode.Diagnostic[]> {
  const deadline = Date.now() + timeoutMilliseconds;
  let observed: readonly vscode.Diagnostic[] = [];
  while (Date.now() < deadline) {
    observed = vscode.languages.getDiagnostics(uri);
    if (predicate(observed)) return observed;
    await delay(50);
  }
  assert.fail(
    `timed out waiting for diagnostics for ${uri.toString()}; observed ` +
      observed.map((item) => item.message).join(", ")
  );
}

async function waitForTraceValue(
  file: string,
  value: string,
  timeoutMilliseconds: number
): Promise<TraceFixtureEvent> {
  const deadline = Date.now() + timeoutMilliseconds;
  let observed: TraceFixtureEvent[] = [];
  while (Date.now() < deadline) {
    observed = await readTraceEvents(file);
    const match = observed.find((event) => event.value === value);
    if (match !== undefined) {
      return match;
    }
    await delay(50);
  }
  assert.fail(
    `timed out waiting for trace ${value} in ${file}; observed ` +
      observed.map((event) => event.value).join(", ")
  );
}

async function readTraceEvents(file: string): Promise<TraceFixtureEvent[]> {
  try {
    const contents = await readFile(file, "utf8");
    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TraceFixtureEvent);
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }
}

async function readSemanticEvents(
  file: string
): Promise<SemanticFixtureEvent[]> {
  try {
    const contents = await readFile(file, "utf8");
    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as SemanticFixtureEvent);
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }
}

async function waitForSemanticMethods(
  file: string,
  expected: string[],
  timeoutMilliseconds: number
): Promise<SemanticFixtureEvent[]> {
  const deadline = Date.now() + timeoutMilliseconds;
  let observed: SemanticFixtureEvent[] = [];
  while (Date.now() < deadline) {
    observed = await readSemanticEvents(file);
    const requested: SemanticFixtureEvent[] = [];
    for (const event of observed) {
      // The editor can request folding automatically before or between our
      // explicit commands. Keep one expected folding request and every other
      // method so their counts and order remain checked.
      if (event.method === "textDocument/foldingRange" &&
          expected[requested.length] !== event.method) {
        continue;
      }
      requested.push(event);
    }
    if (expected.every((method, index) =>
      requested[index]?.method === method)) {
      return requested;
    }
    await delay(50);
  }
  assert.fail(
    `timed out waiting for semantic methods ${expected.join(", ")} in ${file}; ` +
      `observed ${observed.map((event) => event.method).join(", ")}`
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertProcessExited(
  pid: number,
  timeoutMilliseconds: number
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await delay(50);
  }
  assert.fail(`language-server process ${pid} remained alive after cleanup`);
}

async function assertForcedTermination(
  events: FixtureEvent[],
  pid: number,
  timeoutMilliseconds: number
): Promise<void> {
  if (process.platform !== "win32") {
    const termination = events.find((event) =>
      event.event === "terminate" && event.pid === pid);
    assert.ok(termination, "the fixture should receive forced SIGTERM");
    assert.equal(termination.signal, "SIGTERM");
  }
  await assertProcessExited(pid, timeoutMilliseconds);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForDefinitions(
  uri: vscode.Uri,
  position: vscode.Position,
  timeoutMilliseconds: number
): Promise<Array<vscode.Location | vscode.LocationLink>> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const definitions = await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink>
      >("vscode.executeDefinitionProvider", uri, position);
      if (definitions?.length > 0) return definitions;
    } catch (cause) {
      lastError = cause;
    }
    await delay(100);
  }
  assert.fail(
    `timed out waiting for native definition provider` +
    (lastError === undefined ? "" : `: ${String(lastError)}`)
  );
}

async function exerciseSemanticProviders(uri: vscode.Uri): Promise<void> {
  const position = new vscode.Position(0, 1);
  const definitions = await vscode.commands.executeCommand<
    Array<vscode.Location | vscode.LocationLink>
  >("vscode.executeDefinitionProvider", uri, position);
  assert.equal(definitions.length, 1);

  const references = await vscode.commands.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    uri,
    position
  );
  assert.equal(references.length, 1);

  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    uri,
    position
  );
  assert.equal(hovers.length, 1);

  const prepared = await vscode.commands.executeCommand<unknown>(
    "_executePrepareRename",
    uri,
    position
  );
  assert.ok(prepared, "prepareRename should resolve for the owning workspace");

  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
    "_executeDocumentRenameProvider",
    uri,
    position,
    "renamed"
  );
  assert.ok(edit, "rename should resolve for the owning workspace");

  const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
    "vscode.executeFoldingRangeProvider",
    uri
  );
  assert.equal(ranges.length, 1);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT";
}

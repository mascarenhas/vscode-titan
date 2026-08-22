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
  createWorkspaceDocumentSelector,
  createWorkspaceUriConverters
} from "../../extension/workspaceUris";

interface FixtureEvent {
  event: "initialize" | "shutdown" | "exit" | "terminate";
  pid: number;
  cwd: string;
  arguments: string[];
  luaPath?: string;
  luaCPath?: string;
  serverLogLevel?: string;
  rootPath?: string | null;
  rootUri?: string | null;
  workspaceFolders?: Array<{ uri: string; name: string }> | null;
  trace?: string;
  signal?: string;
}

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
  const configuredLuaPath = "/fixture/compiler/?.lua;;";
  const configuredLuaCPath = "/fixture/compiler/?.so;;";
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
    assertInitialization(
      alphaInitial,
      alpha,
      "alpha",
      configuredLuaPath,
      configuredLuaCPath
    );
    assertInitialization(
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
    assertInitialization(
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

    const globalLuaPath = "/fixture/compiler/reconfigured/?.lua;;";
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
        "--semantic-marker",
        nestedSemanticMarker,
        "--fixture-token",
        "nested-inner"
      ];
      let nestedFolder: vscode.WorkspaceFolder | undefined;

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
            "--semantic-marker",
            outerSemanticMarker,
            "--fixture-token",
            "nested-outer"
          ],
          vscode.ConfigurationTarget.WorkspaceFolder
        );
        await waitForEventSequence(
          alphaMarkerPath,
          ["shutdown", "exit", "initialize"],
          10_000
        );

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

        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(nestedFolder.uri, "sample.titan")
        );
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
      } finally {
        if (nestedFolder !== undefined) {
          try {
            await updateWorkspaceFolders(nestedFolder.index, 1);
          } catch {
            // Preserve the primary assertion failure during best-effort cleanup.
          }
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

      await symlink(physicalRoot, lexicalRoot, "dir");
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

      try {
        await updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          0,
          { uri: vscode.Uri.file(lexicalRoot), name: "symlink" }
        );
        symlinkFolder = findWorkspaceFolder(
          vscode.workspace.workspaceFolders ?? [],
          "symlink"
        );
        assert.equal(symlinkFolder.uri.fsPath, lexicalRoot);

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
        assert.equal(initialization.cwd, canonicalRoot);
        // vscode-languageclient keeps the deprecated rootPath lexical, but the
        // authoritative rootUri and every document URI use our converter.
        assert.equal(initialization.rootPath, lexicalRoot);
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
        ["shutdown", "exit", "initialize", "terminate"],
        10_000
      );
      const failedPid = failed[2].pid;
      assert.equal(failed[3].pid, failedPid);
      assert.equal(failed[3].signal, "SIGTERM");
      await assertProcessExited(failedPid, 10_000);

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
        ["shutdown", "exit", "initialize", "terminate", "initialize"]
      );
      const retryPid = retried[4].pid;
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
          "terminate",
          "initialize"
        ]
      );
      assert.equal(replaced[3].pid, ignoredShutdownPid);
      assert.equal(replaced[4].pid, ignoredShutdownPid);
      assert.equal(replaced[4].signal, "SIGTERM");
      const replacementPid = replaced[5].pid;
      assert.notEqual(replacementPid, ignoredShutdownPid);
      await assertProcessExited(ignoredShutdownPid, 10_000);

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
      await Promise.all([
        resetMarker(alphaMarkerPath),
        resetMarker(betaMarkerPath)
      ]);

      process.env.TITAN_LSP_FIXTURE_HANG_ROOT = alpha.uri.fsPath;
      try {
        const globalLuaCPath = "/fixture/compiler/start-timeout/?.so;;";
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
        assert.equal(betaStarted[2].luaCPath, globalLuaCPath);
      } finally {
        delete process.env.TITAN_LSP_FIXTURE_HANG_ROOT;
      }

      const alphaTimedOut = await waitForEventSequence(
        alphaMarkerPath,
        ["shutdown", "exit", "initialize", "terminate"],
        35_000
      );
      const hangingPid = alphaTimedOut[2].pid;
      assert.equal(alphaTimedOut[3].pid, hangingPid);
      assert.equal(alphaTimedOut[3].signal, "SIGTERM");
      await assertProcessExited(hangingPid, 10_000);

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
        ["shutdown", "exit", "initialize", "terminate", "initialize"]
      );
      const betaStable = await assertStableEventSequence(
        betaMarkerPath,
        ["shutdown", "exit", "initialize"]
      );
      const retryPid = alphaRetried[4].pid;
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

  test("connects VS Code to the packaged native server", async function () {
    this.timeout(30_000);
    const repositoryRoot = path.resolve(__dirname, "../../../..");
    const server = path.join(repositoryRoot, "bin", "titan-language-server");
    const titanPrefix = path.join(repositoryRoot, ".titan");
    const luaPath = [
      path.join(titanPrefix, "share", "lua", "5.5", "?.lua"),
      path.join(titanPrefix, "share", "lua", "5.5", "?", "init.lua"),
      ""
    ].join(";");
    const luaCPath = [
      path.join(titanPrefix, "lib", "titan", "0.26", "?.so"),
      path.join(titanPrefix, "lib", "lua", "5.5", "?.so"),
      ""
    ].join(";");

    await vscode.workspace.getConfiguration("titan.languageServer").update(
      "path",
      server,
      vscode.ConfigurationTarget.Global
    );
    await vscode.workspace.getConfiguration("titan.compiler").update(
      "luaPath",
      luaPath,
      vscode.ConfigurationTarget.Global
    );
    await vscode.workspace.getConfiguration("titan.compiler").update(
      "luaCPath",
      luaCPath,
      vscode.ConfigurationTarget.Global
    );

    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(alpha.uri, "sample.titan")
    );
    const useOffset = document.getText().lastIndexOf("render");
    assert.ok(useOffset >= 0, "native-server fixture has no render use");
    const definitions = await waitForDefinitions(
      document.uri,
      document.positionAt(useOffset + 1),
      20_000
    );
    assert.equal(definitions.length, 1);
    const definition = definitions[0];
    assert.ok(definition instanceof vscode.Location);
    assert.equal(definition.uri.toString(), document.uri.toString());
    assert.equal(definition.range.start.line, 13);
    assert.equal(definition.range.start.character, 15);
    assert.equal(definition.range.end.character, 21);
  });
});

function findWorkspaceFolder(
  folders: readonly vscode.WorkspaceFolder[],
  name: string
): vscode.WorkspaceFolder {
  const folder = folders.find((candidate) => candidate.name === name);
  assert.ok(folder, `workspace folder ${name} should be open`);
  return folder;
}

function assertInitialization(
  event: FixtureEvent,
  folder: vscode.WorkspaceFolder,
  token: string,
  luaPath: string,
  luaCPath: string
): void {
  assert.equal(event.cwd, folder.uri.fsPath);
  assert.deepEqual(event.arguments, ["--fixture-token", token]);
  assert.equal(event.luaPath, luaPath);
  assert.equal(event.luaCPath, luaCPath);
  assert.equal(event.serverLogLevel, "info");
  assert.equal(event.trace, "off");
  assert.equal(event.rootPath, folder.uri.fsPath);
  assert.equal(event.rootUri, folder.uri.toString());
  assert.deepEqual(event.workspaceFolders, [{
    uri: folder.uri.toString(),
    name: folder.name
  }]);
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
  timeoutMilliseconds: number
): Promise<FixtureEvent> {
  const deadline = Date.now() + timeoutMilliseconds;
  let observed: FixtureEvent[] = [];
  while (Date.now() < deadline) {
    observed = await readEvents(file);
    const initialization = observed.find((event) =>
      event.event === "initialize" && event.arguments.includes(token));
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
    if (expected.every((method, index) =>
      observed[index]?.method === method)) {
      return observed;
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

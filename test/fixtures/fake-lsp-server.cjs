#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const markerPath = process.argv[2];
const traceMarkerPath = markerPath ? `${markerPath}.trace` : undefined;
const fixtureArguments = process.argv.slice(3);
const rejectInitializeAndStayAlive = fixtureArguments.includes(
  "--initialize-error-stay-alive"
);
const ignoreShutdown = fixtureArguments.includes("--ignore-shutdown");
const ignoreTerminate = fixtureArguments.includes("--ignore-terminate");
const provideSemantics = fixtureArguments.includes("--semantic");
const provideCompletion = fixtureArguments.includes("--completion");
const provideCallCompletion = fixtureArguments.includes("--call-completion");
let completionInitialization = {};
const documents = new Map();
const hangSemantic = fixtureArguments.includes("--hang-semantic");
const omitIndexingGeneration = fixtureArguments.includes(
  "--omit-indexing-generation"
);
const emitIndexingProgress = fixtureArguments.includes("--indexing-progress");
const emitDiagnostics = fixtureArguments.includes("--diagnostics");
const semanticMarkerPath = argumentValue("--semantic-marker");
const indexingDelayMs = Number(argumentValue("--indexing-delay-ms") ?? 0);
const hangInitializeAndStayAlive =
  process.env.TITAN_LSP_FIXTURE_HANG_ROOT === process.cwd();
const initializeDelayMilliseconds =
  process.env.TITAN_LSP_FIXTURE_INITIALIZE_DELAY_ROOT === process.cwd() ? 500 : 0;
let input = Buffer.alloc(0);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    recordEvent("terminate", { signal });
    if (!ignoreTerminate) process.exit(0);
  });
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  drainMessages();
});

process.stdin.on("end", () => process.exit(0));

function drainMessages() {
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    const header = input.subarray(0, headerEnd).toString("ascii");
    const lengthMatch = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
    if (!lengthMatch) {
      console.error("fixture server received a frame without Content-Length");
      process.exit(2);
    }

    const contentLength = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (input.length < bodyEnd) {
      return;
    }

    const message = JSON.parse(
      input.subarray(bodyStart, bodyEnd).toString("utf8")
    );
    input = input.subarray(bodyEnd);
    handleMessage(message);
  }
}

function handleMessage(message, initializeDelayElapsed = false) {
  if (message.method === "initialize") {
    if (initializeDelayMilliseconds > 0 && !initializeDelayElapsed) {
      // Delay the marker as well as the response so the host test observes a
      // pending workspace restart when another workspace has already started.
      setTimeout(() => handleMessage(message, true), initializeDelayMilliseconds);
      return;
    }
    completionInitialization = message.params;
    recordEvent("initialize", {
      rootPath: message.params.rootPath,
      rootUri: message.params.rootUri,
      workspaceFolders: message.params.workspaceFolders,
      trace: message.params.trace,
      initializationOptions: message.params.initializationOptions
    });
    if (rejectInitializeAndStayAlive) {
      respondError(message.id, -32603, "fixture initialize failure");
      return;
    }
    if (hangInitializeAndStayAlive) {
      return;
    }
    respond(message.id, {
      capabilities: provideSemantics ? {
        ...(provideCompletion ? {
          textDocumentSync: { openClose: true, change: 1, save: {} },
          completionProvider: {
            triggerCharacters: [".", ":"],
            completionItem: { labelDetailsSupport: true }
          }
        } : {}),
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        renameProvider: { prepareProvider: true },
        foldingRangeProvider: true
      } : {},
      serverInfo: {
        name: "vscode-titan-fixture",
        version: "0"
      }
    });
  } else if (message.method === "shutdown") {
    recordEvent("shutdown");
    if (ignoreShutdown) {
      return;
    }
    if (emitDiagnostics) publishFixtureDiagnostics([]);
    respond(message.id, null);
  } else if (message.method === "exit") {
    recordEvent("exit");
    process.exit(0);
  } else if (message.method === "initialized") {
    if (emitDiagnostics) {
      publishFixtureDiagnostics([{
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 2 }
        },
        severity: 1,
        code: "type",
        source: "Titan",
        message: "fixture saved-source type error"
      }]);
    }
    if (provideSemantics) {
      notify("titan/indexingStatus", {
        state: "indexing",
        initial: true,
        epoch: 0
      });
      if (emitIndexingProgress) {
        notify("titan/indexingStatus", {
          state: "indexing", initial: true, epoch: 0,
          completed_files: 0, total_files: 2
        });
        notify("titan/indexingStatus", {
          state: "indexing", initial: true, epoch: 0,
          completed_files: 2, total_files: 2
        });
        notify("titan/indexingStatus", {
          state: "indexing", initial: true, epoch: 1
        });
        notify("titan/indexingStatus", {
          state: "indexing", initial: true, epoch: 1,
          completed_files: 0, total_files: 1
        });
        notify("titan/indexingStatus", {
          state: "indexing", initial: true, epoch: 1,
          completed_files: 1, total_files: 1
        });
      }
      const readyStatus = {
        state: "ready",
        initial: true,
        epoch: emitIndexingProgress ? 1 : 0
      };
      if (!omitIndexingGeneration) readyStatus.generation = 1;
      const ready = () => notify("titan/indexingStatus", readyStatus);
      if (indexingDelayMs > 0) {
        setTimeout(ready, indexingDelayMs);
      } else {
        ready();
      }
    }
  } else if (message.method === "$/setTrace") {
    appendEvent(traceMarkerPath, {
      event: "trace",
      value: message.params?.value
    });
  } else if (provideCompletion && message.method === "textDocument/didOpen") {
    documents.set(message.params.textDocument.uri, message.params.textDocument);
  } else if (provideCompletion && message.method === "textDocument/didChange") {
    const document = documents.get(message.params.textDocument.uri);
    if (document) {
      document.text = message.params.contentChanges.at(-1).text;
      document.version = message.params.textDocument.version;
    }
  } else if (provideCompletion && message.method === "textDocument/didClose") {
    documents.delete(message.params.textDocument.uri);
  } else if (provideCompletion && message.method === "textDocument/completion") {
    if (provideCallCompletion) {
      const itemCapabilities = completionInitialization.capabilities
        ?.textDocument?.completion?.completionItem;
      const insertCall = itemCapabilities?.snippetSupport === true &&
        completionInitialization.initializationOptions?.insertCallSnippets !== false;
      respond(message.id, {
        isIncomplete: false,
        items: [{
          label: "method",
          kind: 2,
          detail: "method(count: integer, label: string): boolean",
          ...(itemCapabilities?.labelDetailsSupport ? {
            labelDetails: { detail: "(count: integer, label: string): boolean" }
          } : {}),
          filterText: "method",
          insertTextFormat: insertCall ? 2 : 1,
          textEdit: {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 6 }
            },
            newText: insertCall ? "method(${1:count}, ${2:label})$0" : "method"
          }
        }]
      });
      return;
    }
    const document = documents.get(message.params.textDocument.uri);
    respond(message.id, {
      isIncomplete: false,
      items: [{ label: document?.text.trim() ?? "<missing didOpen>",
        detail: String(process.pid) }]
    });
  } else if (provideSemantics && isSemanticMethod(message.method)) {
    recordSemanticRequest(message);
    if (!hangSemantic) respondToSemanticRequest(message);
  }
}

function publishFixtureDiagnostics(diagnostics) {
  notify("textDocument/publishDiagnostics", {
    uri: pathToFileURL(path.join(process.cwd(), "sample.titan")).href,
    diagnostics
  });
}

function recordEvent(event, details = {}) {
  appendEvent(markerPath, { event, ...details });
}

function recordSemanticRequest(message) {
  appendEvent(semanticMarkerPath, {
    event: "semantic",
    method: message.method,
    uri: message.params?.textDocument?.uri,
    position: message.params?.position,
    context: message.params?.context,
    newName: message.params?.newName
  });
}

function appendEvent(targetPath, details) {
  if (!targetPath) {
    return;
  }

  try {
    fs.appendFileSync(targetPath, `${JSON.stringify({
      pid: process.pid,
      cwd: process.cwd(),
      arguments: fixtureArguments,
      luaPath: process.env.TITAN_LS_LUA_PATH,
      luaCPath: process.env.TITAN_LS_LUA_CPATH,
      titanRoot: process.env.TITAN_ROOT,
      compilerCachePrefix: process.env.TITAN_PREFIX,
      serverLogLevel: process.env.TITAN_LANGUAGE_SERVER_LOG_LEVEL,
      ...details
    })}\n`);
  } catch (error) {
    // The Extension Host removes its temporary fixture directory before final
    // process teardown. Missing cleanup markers must not pollute LSP stdout.
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function argumentValue(flag) {
  const index = fixtureArguments.indexOf(flag);
  return index >= 0 ? fixtureArguments[index + 1] : undefined;
}

function isSemanticMethod(method) {
  return method === "textDocument/definition" ||
    method === "textDocument/references" ||
    method === "textDocument/hover" ||
    method === "textDocument/prepareRename" ||
    method === "textDocument/rename" ||
    method === "textDocument/foldingRange";
}

function respondToSemanticRequest(message) {
  const uri = message.params.textDocument.uri;
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 }
  };
  const location = { uri, range };

  if (message.method === "textDocument/definition") {
    respond(message.id, location);
  } else if (message.method === "textDocument/references") {
    respond(message.id, [location]);
  } else if (message.method === "textDocument/hover") {
    respond(message.id, {
      contents: { kind: "plaintext", value: "fixture hover" },
      range
    });
  } else if (message.method === "textDocument/prepareRename") {
    respond(message.id, { range, placeholder: "fixture" });
  } else if (message.method === "textDocument/rename") {
    respond(message.id, {
      changes: {
        [uri]: [{ range, newText: message.params.newName }]
      }
    });
  } else if (message.method === "textDocument/foldingRange") {
    respond(message.id, [{ startLine: 0, endLine: 1 }]);
  }
}

function respond(id, result) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function respondError(id, code, message) {
  const body = Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function notify(method, params) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

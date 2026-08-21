#!/usr/bin/env node

"use strict";

const fs = require("node:fs");

const markerPath = process.argv[2];
const fixtureArguments = process.argv.slice(3);
const rejectInitializeAndStayAlive = fixtureArguments.includes(
  "--initialize-error-stay-alive"
);
const ignoreShutdown = fixtureArguments.includes("--ignore-shutdown");
const ignoreTerminate = fixtureArguments.includes("--ignore-terminate");
const provideSemantics = fixtureArguments.includes("--semantic");
const hangSemantic = fixtureArguments.includes("--hang-semantic");
const semanticMarkerPath = argumentValue("--semantic-marker");
const hangInitializeAndStayAlive =
  process.env.TITAN_LSP_FIXTURE_HANG_ROOT === process.cwd();
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

function handleMessage(message) {
  if (message.method === "initialize") {
    recordEvent("initialize", {
      rootPath: message.params.rootPath,
      rootUri: message.params.rootUri,
      workspaceFolders: message.params.workspaceFolders
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
    respond(message.id, null);
  } else if (message.method === "exit") {
    recordEvent("exit");
    process.exit(0);
  } else if (provideSemantics && isSemanticMethod(message.method)) {
    recordSemanticRequest(message);
    if (!hangSemantic) respondToSemanticRequest(message);
  }
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
      luaPath: process.env.LUA_PATH,
      luaCPath: process.env.LUA_CPATH,
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

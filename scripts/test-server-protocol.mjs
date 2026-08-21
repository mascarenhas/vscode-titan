import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const server = process.argv[2];
if (!server) {
  console.error("usage: node scripts/test-server-protocol.mjs PATH-TO-SERVER");
  process.exit(2);
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body
  ]);
}

function withTimeout(promise, description, milliseconds = 5_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${description}`)),
      milliseconds
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class FrameReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }

  async read() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd >= 0) {
        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const lines = header.split("\r\n");
        assert.equal(lines.length, 1, `unexpected response headers: ${header}`);
        const match = /^Content-Length: ([0-9]+)$/.exec(lines[0]);
        assert.ok(match, `stdout is not an LSP frame: ${header}`);
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (this.buffer.length >= bodyEnd) {
          const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
          this.buffer = this.buffer.subarray(bodyEnd);
          return JSON.parse(body);
        }
      }

      const next = await withTimeout(
        this.iterator.next(),
        "a framed server response"
      );
      if (next.done) {
        throw new Error(`server stdout ended with ${this.buffer.length} pending bytes`);
      }
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
  }

  async finish() {
    while (true) {
      const next = await withTimeout(
        this.iterator.next(),
        "server stdout to close"
      );
      if (next.done) return;
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
  }
}

function collect(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

function launch(cwd = process.cwd()) {
  return spawn(path.resolve(server), [], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

async function exitOf(child) {
  const [code, signal] = await withTimeout(once(child, "close"), "server exit");
  return { code, signal };
}

async function testLifecycle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-lazy-"));
  // Lifecycle-only sessions must not touch project configuration or load the
  // compiler. This file intentionally fails if the lazy boundary regresses.
  await writeFile(
    path.join(root, "titan-config.lua"),
    "this is not valid Lua and must not be evaluated\n",
    "utf8"
  );
  const child = launch(root);
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    const initialize = frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    });
    child.stdin.write(initialize.subarray(0, 9));
    child.stdin.write(initialize.subarray(9, 27));
    child.stdin.write(initialize.subarray(27));

    const initialized = await responses.read();
    assert.equal(initialized.jsonrpc, "2.0");
    assert.equal(initialized.id, 1);
    assert.deepEqual(initialized.result, {
      capabilities: {
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: true,
        hoverProvider: true,
        foldingRangeProvider: true
      }
    });

    child.stdin.write(Buffer.concat([
      frame({ jsonrpc: "2.0", method: "initialized", params: {} }),
      frame({
        jsonrpc: "2.0",
        method: "$/cancelRequest",
        params: { id: 999 }
      }),
      frame({
        jsonrpc: "2.0",
        id: "shutdown",
        method: "shutdown",
        params: null
      })
    ]));

    const shutdown = await responses.read();
    assert.equal(shutdown.jsonrpc, "2.0");
    assert.equal(shutdown.id, "shutdown");
    assert.equal(shutdown.result, null);

    // The server must stop after exit even while the client side of stdin
    // remains open; teardown cannot wait for another read to reach EOF.
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await exit, { code: 0, signal: null });
    await responses.finish();
    assert.equal(stderr().length, 0, stderr().toString("utf8"));
    assert.equal(responses.buffer.length, 0, "unexpected bytes after responses");
  } catch (cause) {
    const diagnostic = stderr().toString("utf8").trim();
    throw new Error(
      `${cause.message}${diagnostic.length > 0 ? `; stderr: ${diagnostic}` : ""}`,
      { cause }
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function request(child, responses, id, method, params) {
  child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
  const response = await responses.read();
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, id);
  return response;
}

async function testSavedProjectSemantics() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-project-"));
  const filename = path.join(root, "sample.titan");
  const sourceLines = [
    "function answer(item: integer): integer",
    "  return item * 2",
    "end",
    "function use(): integer",
    "  return answer(#\"😀\", answer(21))",
    "end",
    ""
  ];
  await writeFile(filename, sourceLines.join("\n"), "utf8");

  const uri = pathToFileURL(filename).href;
  const firstUse = sourceLines[4].indexOf("answer");
  const unicodeUse = sourceLines[4].lastIndexOf("answer");
  assert.ok(unicodeUse > firstUse);
  assert.ok(
    Buffer.byteLength(sourceLines[4].slice(0, unicodeUse), "utf8") > unicodeUse,
    "fixture position did not cross a multibyte Unicode scalar"
  );

  const child = launch(root);
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    const initialized = await request(child, responses, 1, "initialize", {});
    assert.equal(initialized.result.capabilities.completionProvider, undefined);
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "initialized",
      params: {}
    }));

    const documentPosition = {
      textDocument: { uri },
      position: { line: 4, character: unicodeUse + 1 }
    };

    const definition = await request(
      child,
      responses,
      "definition",
      "textDocument/definition",
      documentPosition
    );
    assert.equal(
      definition.error,
      undefined,
      `definition failed: ${JSON.stringify(definition.error)}`
    );
    assert.deepEqual(definition.result, {
      uri,
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 15 }
      }
    });

    const references = await request(
      child,
      responses,
      "references",
      "textDocument/references",
      {
        ...documentPosition,
        context: { includeDeclaration: true }
      }
    );
    assert.equal(references.result.length, 3);
    assert.ok(references.result.some((location) =>
      location.range.start.line === 4 &&
      location.range.start.character === unicodeUse
    ));

    const hover = await request(
      child,
      responses,
      "hover",
      "textDocument/hover",
      documentPosition
    );
    assert.equal(hover.result.contents.kind, "markdown");
    assert.match(hover.result.contents.value, /integer/);
    assert.deepEqual(hover.result.range, {
      start: { line: 4, character: unicodeUse },
      end: { line: 4, character: unicodeUse + "answer".length }
    });

    const folding = await request(
      child,
      responses,
      "folding",
      "textDocument/foldingRange",
      { textDocument: { uri } }
    );
    assert.ok(folding.result.some((range) =>
      range.startLine === 0 && range.endLine === 1
    ));
    assert.ok(folding.result.some((range) =>
      range.startLine === 3 && range.endLine === 4
    ));

    const rename = await request(
      child,
      responses,
      "rename",
      "textDocument/rename",
      { ...documentPosition, newName: "solution" }
    );
    const edits = rename.result.changes[uri];
    assert.equal(edits.length, 3);
    assert.ok(edits.every((edit) => edit.newText === "solution"));
    assert.ok(edits.some((edit) =>
      edit.range.start.line === 4 &&
      edit.range.start.character === unicodeUse
    ));

    const invalid = await request(
      child,
      responses,
      "invalid",
      "textDocument/definition",
      { textDocument: { uri } }
    );
    assert.equal(invalid.error.code, -32602);

    const unsupported = await request(
      child,
      responses,
      "unsupported",
      "textDocument/completion",
      documentPosition
    );
    assert.equal(unsupported.error.code, -32601);

    // A failed saved generation must not fall back to the previously checked
    // AST. The application refreshes from disk for each semantic request.
    await writeFile(filename, "function answer(\n", "utf8");
    const stale = await request(
      child,
      responses,
      "stale",
      "textDocument/definition",
      documentPosition
    );
    assert.equal(stale.error.code, -32803);
    assert.match(stale.error.message, /current saved generation/);

    const shutdown = await request(
      child,
      responses,
      "shutdown",
      "shutdown",
      null
    );
    assert.equal(shutdown.result, null);
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await exit, { code: 0, signal: null });
    await responses.finish();
    assert.equal(stderr().length, 0, stderr().toString("utf8"));
    assert.equal(responses.buffer.length, 0, "unexpected bytes after responses");
  } catch (cause) {
    const diagnostic = stderr().toString("utf8").trim();
    throw new Error(
      `${cause.message}${diagnostic.length > 0 ? `; stderr: ${diagnostic}` : ""}`,
      { cause }
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function testConfigCannotWriteProtocolStdout() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-config-"));
  const filename = path.join(root, "sample.titan");
  await writeFile(filename, "function answer(): integer return 42 end\n", "utf8");
  await writeFile(
    path.join(root, "titan-config.lua"),
    "print('unframed workspace output')\nreturn {}\n",
    "utf8"
  );

  const child = launch(root);
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    await request(child, responses, 1, "initialize", {});
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "initialized",
      params: {}
    }));
    const rejected = await request(
      child,
      responses,
      "config-output",
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL(filename).href },
        position: { line: 0, character: 10 }
      }
    );
    assert.equal(rejected.error.code, -32803);
    assert.match(rejected.error.message, /cannot evaluate titan-config\.lua/);

    const shutdown = await request(
      child,
      responses,
      "shutdown",
      "shutdown",
      null
    );
    assert.equal(shutdown.result, null);
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await exit, { code: 0, signal: null });
    await responses.finish();
    assert.equal(responses.buffer.length, 0, "config emitted unframed stdout");
    assert.equal(stderr().length, 0, stderr().toString("utf8"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function testCrossModuleFolderAndIncrementalSemantics() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-modules-"));
  const sourceRoot = path.join(root, "src");
  const libraryRoot = path.join(sourceRoot, "library");
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(
    path.join(root, "titan-config.lua"),
    "return { source_modules_root = 'src' }\n",
    "utf8"
  );
  const mainFile = path.join(libraryRoot, "library.titan");
  const partFile = path.join(libraryRoot, "part.titan");
  const consumerFile = path.join(sourceRoot, "consumer.titan");
  await writeFile(
    mainFile,
    "function answer(item: integer): integer return item * 2 end\n",
    "utf8"
  );
  const validPart =
    "function extra(item: integer): integer return item + 1 end\n";
  await writeFile(partFile, validPart, "utf8");
  const consumerLines = [
    "local library = import \"library\"",
    "local strings = import \"string\"",
    "function use(): integer",
    "  return library.extra(library.answer(20)) + #strings.sub(\"x\", 1, 1)",
    "end",
    ""
  ];
  await writeFile(consumerFile, consumerLines.join("\n"), "utf8");

  const consumerUri = pathToFileURL(consumerFile).href;
  const partUri = pathToFileURL(partFile).href;
  const extraColumn = consumerLines[3].indexOf("extra");
  const subColumn = consumerLines[3].indexOf("sub");
  const child = launch(root);
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  const responses = new FrameReader(child.stdout);
  try {
    await request(child, responses, 1, "initialize", {});
    child.stdin.write(frame({
      jsonrpc: "2.0",
      method: "initialized",
      params: {}
    }));

    const extraPosition = {
      textDocument: { uri: consumerUri },
      position: { line: 3, character: extraColumn + 1 }
    };
    const definition = await request(
      child,
      responses,
      "folder-definition",
      "textDocument/definition",
      extraPosition
    );
    assert.equal(
      definition.error,
      undefined,
      `folder definition failed: ${JSON.stringify(definition.error)}`
    );
    assert.deepEqual(definition.result, {
      uri: partUri,
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 14 }
      }
    });

    const references = await request(
      child,
      responses,
      "cross-references",
      "textDocument/references",
      { ...extraPosition, context: { includeDeclaration: true } }
    );
    assert.equal(references.result.length, 2);
    assert.deepEqual(
      new Set(references.result.map((location) => location.uri)),
      new Set([partUri, consumerUri])
    );

    const rename = await request(
      child,
      responses,
      "cross-rename",
      "textDocument/rename",
      { ...extraPosition, newName: "augment" }
    );
    assert.equal(rename.error, undefined, JSON.stringify(rename.error));
    assert.equal(rename.result.changes[partUri].length, 1);
    assert.equal(rename.result.changes[consumerUri].length, 1);
    assert.ok(Object.values(rename.result.changes).flat().every(
      (edit) => edit.newText === "augment"
    ));

    const externalDefinition = await request(
      child,
      responses,
      "external-definition",
      "textDocument/definition",
      {
        textDocument: { uri: consumerUri },
        position: { line: 3, character: subColumn + 1 }
      }
    );
    assert.equal(externalDefinition.result, null);

    // An implementation-only change keeps the public manifest stable, so the
    // clean consumer remains reusable and navigation still succeeds.
    await writeFile(
      partFile,
      "function extra(item: integer): integer return item + 200 end\n",
      "utf8"
    );
    const unchangedManifest = await request(
      child,
      responses,
      "implementation-change",
      "textDocument/definition",
      extraPosition
    );
    assert.equal(unchangedManifest.error, undefined);
    assert.equal(unchangedManifest.result.uri, partUri);

    // A public interface change must invalidate and recheck the consumer in
    // the same refresh fixed point instead of serving its prior annotated AST.
    await writeFile(
      partFile,
      "function extra(item: integer): string return \"broken\" end\n",
      "utf8"
    );
    const changedManifest = await request(
      child,
      responses,
      "interface-change",
      "textDocument/definition",
      extraPosition
    );
    assert.equal(changedManifest.error.code, -32803);
    assert.match(changedManifest.error.message, /current saved generation/);

    await writeFile(partFile, validPart, "utf8");
    const recovered = await request(
      child,
      responses,
      "recovered-generation",
      "textDocument/definition",
      extraPosition
    );
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.result.uri, partUri);

    const shutdown = await request(
      child,
      responses,
      "shutdown",
      "shutdown",
      null
    );
    assert.equal(shutdown.result, null);
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await exit, { code: 0, signal: null });
    await responses.finish();
    assert.equal(responses.buffer.length, 0, "unexpected cross-module stdout");
    assert.equal(stderr().length, 0, stderr().toString("utf8"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function testTruncatedFrame() {
  const child = launch();
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const exit = exitOf(child);
  try {
    child.stdin.end(Buffer.from("Content-Length: 10\r\n\r\n{}", "ascii"));
    assert.deepEqual(await exit, { code: 1, signal: null });
    assert.equal(stdout().length, 0, "truncated input polluted stdout");
    assert.match(
      stderr().toString("utf8"),
      /^titan-language-server: unexpected EOF in LSP frame\n$/
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

await testLifecycle();
await testSavedProjectSemantics();
await testConfigCannotWriteProtocolStdout();
await testCrossModuleFolderAndIncrementalSemantics();
await testTruncatedFrame();
console.log("native server protocol transcript passed");

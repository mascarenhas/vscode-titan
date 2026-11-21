import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  FrameReader, collect, exitOf, frame, launch, makePhysicalTemporaryRoot,
  request, structuredLogRecords, waitForIndexing, withTimeout
} from "./test-server-protocol.mjs";
import { compilerDiscoveryEnvironment, titanCompilerCommand } from "./titan-sdk.mjs";

assert.ok(process.argv[2], "usage: node scripts/test-completion-protocol.mjs PATH-TO-SERVER");
const root = await makePhysicalTemporaryRoot("vscode-titan-completion-");
const filename = path.join(root, "app.titan");
const dependency = path.join(root, "dep.titan");
const foreignFile = path.join(root, "foreigns.titan");
const background = path.join(root, "background.titan");
const folderMain = path.join(root, "box/box.titan");
const acceptedFile = path.join(root, "accepted.titan");
const saved = "local disk_value = 1\nfunction read(): integer\n  return disk_value\nend\n";
const fields = (type = "integer") => Array.from({ length: 800 }, (_, index) =>
  `  field${String(index).padStart(4, "0")}: ${type}`).join("\n");
const largeSaved = (type = "integer") => `record Background\n${fields(type)}\nend\n`;
const header = path.join(root, "types.h");
const foreignPrefix = `foreign import ${JSON.stringify(header)}\n`;
await mkdir(path.dirname(folderMain));
await writeFile(path.join(root, "titan-config.lua"),
  'include = { "." }\nsource_module_roots = { "." }\n');
await writeFile(filename, saved);
await writeFile(dependency, "--- Saved dependency module.\n-- @module dep\n" +
  "function savedOnly(): integer return 1 end\n" +
  "--- Test a saved count.\n-- @param count The number to test.\n-- @return Whether it is positive.\n" +
  "-- @usage functions.md#named-calls\n" +
  "function importedCall(count: integer, label: string): boolean return count > 0 end\n");
await writeFile(header, "typedef struct Widget { int count; } Widget;\nint callable(int argument);\n");
await writeFile(foreignFile, foreignPrefix + "local saved = 1\n");
await writeFile(folderMain, "local saved = 1\n");
await writeFile(acceptedFile, "local diskOnly = 1\n");
await writeFile(background, largeSaved());

const child = launch(root, "debug");
const stderr = collect(child.stderr);
const exit = exitOf(child);
const responses = new FrameReader(child.stdout);
let nextId = 1;
const versions = new Map();
const measurements = [];
const memory = [];
const warmRequests = 30;
const uri = (file) => pathToFileURL(file).href;

async function sampleMemory(label) {
  if (process.platform !== "linux") return;
  const status = await readFile(`/proc/${child.pid}/status`, "utf8");
  const kib = (name) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0);
  memory.push({ label, rss_bytes: kib("VmRSS") * 1024, peak_rss_bytes: kib("VmHWM") * 1024 });
}

function notify(method, params) {
  child.stdin.write(frame({ jsonrpc: "2.0", method, params }));
}

function marked(source) {
  const offset = source.indexOf("@");
  assert.ok(offset >= 0 && source.indexOf("@", offset + 1) < 0, "fixture needs one caret marker");
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return {
    text: source.slice(0, offset) + source.slice(offset + 1),
    position: { line: lines.length - 1, character: lines.at(-1).length }
  };
}

function open(file, text, version = 1) {
  versions.set(file, version);
  notify("textDocument/didOpen", { textDocument: { uri: uri(file), languageId: "titan", version, text } });
}

function change(file, text, version = versions.get(file) + 1) {
  versions.set(file, version);
  notify("textDocument/didChange", {
    textDocument: { uri: uri(file), version }, contentChanges: [{ text }]
  });
}

async function complete(file, position, label, context) {
  const started = performance.now();
  const response = await request(child, responses, nextId++, "textDocument/completion", {
    textDocument: { uri: uri(file) }, position, ...(context ? { context } : {})
  });
  measurements.push({ label, wall_ms: performance.now() - started });
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(typeof response.result.isIncomplete, "boolean");
  assert.ok(Array.isArray(response.result.items));
  const labels = new Set();
  for (const item of response.result.items) {
    assert.ok(item.insertTextFormat === 1 || item.insertTextFormat === 2);
    if (item.insertTextFormat === 2) {
      assert.ok(item.textEdit.newText.startsWith(`${item.label}(`),
        `call snippet lost its name: ${JSON.stringify(item)}`);
      assert.ok(item.textEdit.newText.endsWith("$0"),
        `call snippet omitted its final caret: ${JSON.stringify(item)}`);
    } else {
      assert.equal(item.textEdit.newText, item.label);
    }
    assert.ok(item.textEdit.range.start.line >= 0 && item.textEdit.range.end.line >= 0);
    assert.equal(item.filterText, item.label);
    assert.equal(labels.has(item.label), false, `duplicate candidate ${item.label}`);
    labels.add(item.label);
  }
  return response.result;
}

async function ready(file, position, expected, label, context) {
  const deadline = performance.now() + 30_000;
  let result;
  do {
    result = await complete(file, position, label, context);
    if (result.items.some((item) => item.label === expected)) return result;
    if (!result.isIncomplete) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  assert.fail(`${label}: missing ${expected}: ${JSON.stringify(result)}`);
}

function excludes(result, ...names) {
  for (const name of names) assert.ok(!result.items.some((item) => item.label === name), `unexpected ${name}`);
}

function positionOf(text, token, occurrence = 0) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) offset = text.indexOf(token, offset + 1);
  assert.ok(offset >= 0, `missing hover token ${token}`);
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1).length + 1 };
}

function offsetAt(text, position) {
  const lines = text.split("\n");
  assert.ok(position.line >= 0 && position.line < lines.length);
  assert.ok(position.character >= 0 && position.character <= lines[position.line].length);
  return lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) +
    position.character;
}

function rangeOf(text, token, occurrence = 0) {
  const position = positionOf(text, token, occurrence);
  return {
    start: { line: position.line, character: position.character - 1 },
    end: { line: position.line, character: position.character - 1 + token.length }
  };
}

function acceptCompletion(text, item) {
  assert.ok(item?.textEdit, "completion did not supply an acceptance edit");
  let inserted = item.textEdit.newText;
  if (item.insertTextFormat === 2) {
    // This server emits fixed parameter defaults and a final caret. Apply
    // those defaults just as accepting a call snippet in the editor does.
    inserted = inserted.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\d+/g, "");
    assert.equal(inserted.includes("${"), false, "unsupported call snippet in fixture");
  }
  const start = offsetAt(text, item.textEdit.range.start);
  const finish = offsetAt(text, item.textEdit.range.end);
  return text.slice(0, start) + inserted + text.slice(finish);
}

async function hover(file, position) {
  const response = await request(child, responses, nextId++, "textDocument/hover", {
    textDocument: { uri: uri(file) }, position
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result;
}

async function readyHover(file, text, token, expected, label, occurrence = 0) {
  const deadline = performance.now() + 30_000;
  let result;
  do {
    result = await hover(file, positionOf(text, token, occurrence));
    if (result?.contents?.value && expected.test(result.contents.value)) {
      assert.deepEqual(result.range, rangeOf(text, token, occurrence),
        `${label}: hover did not use the current document's range`);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  assert.fail(`${label}: hover did not converge: ${JSON.stringify(result)}`);
}

function assertCurrentHoverWhenReady(result, text, token, expected, label, occurrence = 0) {
  // Debounced analysis can finish before the first request reaches a busy
  // server. A nonnull result must already belong to the current real token.
  if (result === null) return;
  assert.match(result.contents.value, expected, label);
  assert.deepEqual(result.range, rangeOf(text, token, occurrence), label);
}

async function testContextualBinaryCompletion() {
  const prefix = process.env.TITAN_ROOT;
  assert.ok(prefix, "the completion protocol fixture requires the matched SDK");
  const producer = path.join(root, "contextual-producer");
  const built = path.join(root, "contextual-build");
  const library = path.join(producer, "stock");
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, "quantity.titan"), "record Quantity\n  count: integer\nend\n");
  await writeFile(path.join(library, "rate.titan"), "record Rate\n  percent: integer\nend\n");
  await writeFile(path.join(library, "sleeping.titan"), "const unused = 42\n");
  await writeFile(path.join(producer, "via.titan"),
    'local units = import "stock.quantity"\n' +
    "function measure(): units.Quantity return units.Quantity(7) end\n");
  await writeFile(path.join(producer, "other.titan"),
    'local rates = import "stock.rate"\n' +
    "function read(): rates.Rate return rates.Rate(25) end\n");

  function compile(output, imports, ...modules) {
    const invocation = titanCompilerCommand(prefix,
      ["-q", "--tree", producer, "--output", output, ...modules]);
    const env = { ...compilerDiscoveryEnvironment(), TITAN_ROOT: prefix, TITAN_PROBE_CACHE_DISABLE: "1" };
    if (imports) env.TITAN_PATH_0_6 = imports;
    const result = spawnSync(invocation.command, invocation.args,
      { env, cwd: producer, encoding: "utf8", windowsHide: true, timeout: 120_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${invocation.args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  const owner = path.join(built, "owner");
  compile(owner, undefined, "stock.quantity", "stock.rate", "stock.sleeping");
  const replacement = path.join(built, "replacement");
  await writeFile(path.join(library, "quantity.titan"), "record Quantity\n  amount: integer\nend\n");
  compile(replacement, undefined, "stock.quantity", "stock.rate", "stock.sleeping");
  const via = path.join(built, "via");
  const other = path.join(built, "other");
  // Only stock's compiled output is on the producer's dependency path.
  await rm(library, { recursive: true });
  compile(via, owner, "via");
  compile(other, owner, "other");

  const formats = process.platform === "win32" ? [".dll"] : [".a", ".so"];
  for (const extension of formats) {
    const project = path.join(root, `contextual-${extension.slice(1)}`);
    const src = path.join(project, "src");
    const providers = path.join(project, "providers");
    await mkdir(src, { recursive: true });
    await mkdir(providers);
    const provider = path.join(providers, `stock${extension}`);
    await copyFile(path.join(owner, `stock${extension}`), provider);
    await copyFile(path.join(via, `via${extension}`), path.join(providers, `via${extension}`));
    await copyFile(path.join(other, `other${extension}`), path.join(providers, `other${extension}`));
    async function replaceProvider(output) {
      const staged = path.join(providers, "stock.next");
      await copyFile(path.join(output, `stock${extension}`), staged);
      await rename(staged, provider);
    }
    await writeFile(path.join(project, "titan-config.lua"),
      'include = { "./src" }\nsource_module_roots = { "./src" }\nbinary_modules_root = "./providers"\n');
    const first = path.join(src, "app.titan");
    const second = path.join(src, "report.titan");
    const unrelated = path.join(src, "unrelated.titan");
    const firstSource = 'local via = import "via"\nfunction count(): integer return via.measure().count end\n';
    const secondSource = 'local other = import "other"\nfunction rate(): integer return other.read().percent end\n';
    const unrelatedSource = "function untouched(): integer return 1 end\n";
    const rated = 'local rates = import "stock.rate"\n' +
      "function rate(): integer return rates.Rate(25).percent end\n";
    const measured = 'local units = import "stock.quantity"\n' + rated +
      "function count(): integer return units.Quantity(7).count end\n";
    const touchedFacade = firstSource + "\n-- Recheck the facade after touching the provider.\n";
    await writeFile(first, firstSource);
    await writeFile(second, secondSource);
    await writeFile(unrelated, unrelatedSource);

    async function session(phase = "cold") {
      const server = launch(project, "debug");
      const frames = new FrameReader(server.stdout);
      const diagnostics = collect(server.stderr);
      const exited = exitOf(server);
      let id = 0;
      const send = (method, params) => server.stdin.write(frame({ jsonrpc: "2.0", method, params }));
      async function ask(method, params) {
        const response = await request(server, frames, ++id, method, params, 30_000);
        assert.equal(response.error, undefined, JSON.stringify(response));
        return response.result;
      }
      const document = (file) => ({ uri: uri(file) });
      const pull = (file) => ask("textDocument/diagnostic", { textDocument: document(file) });
      function assertCatalog(names, ordinary = [], forbidden = []) {
        const database = new DatabaseSync(path.join(project, ".titan-ls", "index.sqlite3"), { readOnly: true });
        try {
          const rows = database.prepare("SELECT module_name,provenance,main_file " +
            "FROM completion_descriptors WHERE CAST(module_name AS TEXT) LIKE 'stock.%' ORDER BY module_name").all();
          const actual = rows.map(({ module_name }) => Buffer.from(module_name).toString());
          if (names !== undefined) assert.deepEqual(actual, names);
          for (const name of forbidden) assert.ok(!actual.includes(name), `unexpected ${name} descriptor`);
          for (const row of rows) {
            assert.equal(row.provenance, extension === ".a" ? "static" : "dynamic");
            assert.equal(path.normalize(Buffer.from(row.main_file).toString()), path.normalize(provider));
          }
          if (names !== undefined) {
            const selected = database.prepare("SELECT name FROM external_records " +
              "WHERE CAST(name AS TEXT) LIKE 'stock.%' ORDER BY name").all();
            assert.deepEqual(selected.map(({ name }) => Buffer.from(name).toString()), ordinary,
              "unexpected ordinary stock provider selections");
          }
        } finally {
          database.close();
        }
      }
      async function suggestions(file, caret, expected) {
        const deadline = performance.now() + 30_000;
        let result;
        do {
          result = await ask("textDocument/completion", { textDocument: document(file), position: caret.position });
          if (result.items.some((item) => item.label === expected) || !result.isIncomplete) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (performance.now() < deadline);
        assert.ok(result.items.some((item) => item.label === expected),
          `${extension}: missing ${expected} completion: ${JSON.stringify(result)}`);
        return result;
      }
      async function member(file, contents, name) {
        // Select a token occurring only after the receiver, not the function name.
        const caret = marked(contents.replace(`.${name}`, `.${name[0]}@${name.slice(1)}`));
        send("textDocument/didOpen", {
          textDocument: { ...document(file), languageId: "titan", version: 1, text: caret.text }
        });
        const saved = await ask("textDocument/hover", { textDocument: document(file), position: caret.position });
        assert.match(saved?.contents?.value ?? "", /integer/, `${extension}: saved ${name} hover`);
        const result = await suggestions(file, caret, name);
        assert.equal(result.items.find((item) => item.label === name)?.detail, "integer");
        send("textDocument/didClose", { textDocument: document(file) });
      }
      async function excludesMember(file, contents, name) {
        const caret = marked(contents.replace(`.${name}`, `.${name[0]}@${name.slice(1)}`));
        send("textDocument/didOpen", {
          textDocument: { ...document(file), languageId: "titan", version: 1, text: caret.text }
        });
        const result = await ask("textDocument/completion", {
          textDocument: document(file), position: caret.position
        });
        excludes(result, name);
        send("textDocument/didClose", { textDocument: document(file) });
      }
      async function imports(expected, ...absent) {
        const caret = marked('local item = import "stock.@"\n');
        send("textDocument/didOpen", {
          textDocument: { ...document(unrelated), languageId: "titan", version: 1, text: caret.text }
        });
        excludes(await suggestions(unrelated, caret, expected), ...absent);
        send("textDocument/didClose", { textDocument: document(unrelated) });
      }
      try {
        const initialized = await ask("initialize", {
          rootUri: uri(project),
          workspaceFolders: [{ uri: uri(project), name: "contextual provider" }],
          capabilities: { textDocument: { diagnostic: {} } }
        });
        assert.ok(initialized.capabilities.diagnosticProvider);
        send("initialized", {});
        const firstDiagnostics = await pull(first);
        const secondDiagnostics = await pull(second);
        if (phase !== "replaced" && phase !== "removed") {
          assert.deepEqual(firstDiagnostics.items, []);
          assert.deepEqual(secondDiagnostics.items, []);
        }
        if (phase === "replaced") {
          assert.match(JSON.stringify(secondDiagnostics.items), /count/);
          assertCatalog(["stock.rate"], ["stock.rate"]);
          await excludesMember(second, firstSource, "count");
          const updated = firstSource.replace("().count", "().amount");
          await writeFile(second, updated);
          assert.deepEqual((await pull(second)).items, []);
          assertCatalog(["stock.quantity", "stock.rate"], ["stock.rate"]);
          await member(second, updated, "amount");
          await excludesMember(second, firstSource, "count");
        } else if (phase === "removed") {
          assert.ok(firstDiagnostics.items.length > 0 && secondDiagnostics.items.length > 0);
          assertCatalog(undefined, [], ["stock.quantity", "stock.sleeping"]);
          await excludesMember(second, firstSource.replace("().count", "().amount"), "amount");
        } else if (phase === "warm-touched") {
          assertCatalog(["stock.quantity", "stock.rate"], ["stock.rate"]);
          await member(second, touchedFacade, "count");
          await imports("stock.quantity", "stock.sleeping");
        } else if (phase === "mixed") {
          assertCatalog(["stock.rate"], ["stock.rate"]);
          await member(first, rated, "percent");
          await member(second, secondSource, "percent");
          await imports("stock.rate", "stock.quantity", "stock.sleeping");
        } else if (phase === "contextual-first" || phase === "ordinary-first") {
          const contextual = phase === "contextual-first" ? first : second;
          const ordinary = contextual === first ? second : first;
          assertCatalog(["stock.quantity", "stock.rate"], ["stock.rate"]);
          await member(contextual, firstSource, "count");
          await member(ordinary, rated, "percent");
          const updatedRate = rated.replace("Rate(25)", "Rate(26)");
          await writeFile(ordinary, updatedRate);
          assert.deepEqual((await pull(ordinary)).items, []);
          assertCatalog(["stock.quantity", "stock.rate"], ["stock.rate"]);
          await member(contextual, firstSource, "count");
          await member(ordinary, updatedRate, "percent");
          await imports("stock.quantity", "stock.sleeping");
          console.log(`${extension} ${phase}: contextual and ordinary members completed`);

          if (phase === "ordinary-first") {
            // A failed attempt can capture quantity but cannot authorize it.
            await writeFile(second, firstSource.replace("().count", "().missing"));
            assert.match(JSON.stringify((await pull(second)).items), /missing/);
            assertCatalog(["stock.rate"], ["stock.rate"]);
            await imports("stock.rate", "stock.quantity", "stock.sleeping");

            await writeFile(second, firstSource);
            assert.deepEqual((await pull(second)).items, []);
            assertCatalog(["stock.quantity", "stock.rate"], ["stock.rate"]);

            // No DSO recapture on this refresh: the old SQL row must still
            // retire even though the DSO remains ordinarily selected.
            await writeFile(second, unrelatedSource);
            assert.deepEqual((await pull(second)).items, []);
            assertCatalog(["stock.rate"], ["stock.rate"]);
            await imports("stock.rate", "stock.quantity", "stock.sleeping");

            await writeFile(second, firstSource);
            assert.deepEqual((await pull(second)).items, []);
            assertCatalog(["stock.quantity", "stock.rate"], ["stock.rate"]);

            // Change only the file's timestamp. Each publisher must preserve
            // the already witnessed bytes, including after an unprovable live
            // facade recapture by this still-resident worker.
            const before = await stat(provider);
            await utimes(provider, before.atime, new Date(before.mtimeMs + 5000));
            const after = await stat(provider);
            assert.equal(after.ino, before.ino);
            assert.equal(after.dev, before.dev);
            assert.notEqual(after.mtimeMs, before.mtimeMs);

            await writeFile(unrelated, unrelatedSource.replace("return 1", "return 3"));
            assert.deepEqual((await pull(unrelated)).items, []);
            assertCatalog(["stock.quantity", "stock.rate"], ["stock.rate"]);
            await member(second, firstSource, "count");

            await writeFile(first, rated.replace("Rate(25)", "Rate(27)"));
            assert.deepEqual((await pull(first)).items, []);
            assertCatalog(["stock.quantity", "stock.rate"], ["stock.rate"]);
            await member(second, firstSource, "count");

            await writeFile(second, touchedFacade);
            assert.deepEqual((await pull(second)).items, []);
            assertCatalog(["stock.quantity", "stock.rate"], ["stock.rate"]);
            await member(second, touchedFacade, "count");
          } else if (extension === ".so") {
            // The old image remains resident even though the analyzed path now
            // points to a new provider. It cannot authenticate a saved row.
            await replaceProvider(replacement);
            await pull(contextual);
            assertCatalog(["stock.rate"], ["stock.rate"]);
            await excludesMember(contextual, firstSource, "count");
          }
        } else {
          assertCatalog(["stock.quantity", "stock.rate"]);
          await member(first, firstSource, "count");
          await member(second, secondSource, "percent");
          await imports("stock.quantity", "stock.sleeping");
          if (phase === "cold") {
            await writeFile(unrelated, unrelatedSource.replace("return 1", "return 2"));
            assert.deepEqual((await pull(unrelated)).items, []);
            assertCatalog(["stock.quantity", "stock.rate"]);

            // A failed saved check must not keep the previous owner alive
            // through its old exposer edge. The other owner shares the file.
            await writeFile(first, firstSource.replace("().count", "().missing"));
            assert.match(JSON.stringify((await pull(first)).items), /missing/);
            assertCatalog(["stock.rate"]);
            await imports("stock.rate", "stock.quantity", "stock.sleeping");
            await member(second, secondSource, "percent");

            await writeFile(first, "function count(): integer return 1 end\n");
            assert.deepEqual((await pull(first)).items, []);
            assertCatalog(["stock.rate"]);
            await writeFile(first, firstSource);
            assert.deepEqual((await pull(first)).items, []);
            assertCatalog(["stock.quantity", "stock.rate"]);
            await member(first, firstSource, "count");
          } else if (extension !== ".a") {
            await writeFile(second, "function rate(): integer return 25 end\n");
            await writeFile(first, measured);
            assert.deepEqual((await pull(first)).items, []);
            assert.deepEqual((await pull(second)).items, []);
            assertCatalog(["stock.quantity", "stock.rate"], ["stock.quantity", "stock.rate"]);
            await member(first, measured, "count");
          }
        }
        await ask("shutdown", null);
        send("exit");
        server.stdin.end();
        assert.deepEqual(await withTimeout(exited, "contextual completion shutdown", 10_000),
          { code: 0, signal: null });
      } catch (cause) {
        throw new Error(`${extension} contextual completion (${phase}): ${cause.message}\n` +
          diagnostics().toString("utf8"), { cause });
      } finally {
        if (server.exitCode === null && server.signalCode === null) {
          server.kill();
          await withTimeout(exited, "contextual completion cleanup", 5_000).catch(() => server.kill("SIGKILL"));
        }
      }
    }
    await session();
    await session("warm");
    if (extension !== ".a") {
      // Write both roots between workers so one saved refresh checks the
      // ordinary root (app) before the independent contextual root (report).
      // Both capture rate from the same DSO; neither now selects quantity.
      await writeFile(first, rated);
      await writeFile(second, secondSource);
      await session("mixed");

      // Quantity has left the ordinary graph. Reintroduce it only through
      // the facade. Edit both roots between workers for one saved workset;
      // root names (app, report) determine the analysis order.
      await writeFile(first, firstSource);
      await writeFile(second, rated);
      await session("contextual-first");
      if (extension === ".so") await replaceProvider(owner);
      await writeFile(first, rated);
      await writeFile(second, firstSource);
      await session("ordinary-first");
      await session("warm-touched");
      // Unlike a touch, new bytes on the very same object invalidate the old
      // witness. Do this after shutdown, including on Windows.
      const beforeRewrite = await stat(provider);
      await writeFile(provider, await readFile(path.join(replacement, `stock${extension}`)));
      const afterRewrite = await stat(provider);
      assert.equal(afterRewrite.ino, beforeRewrite.ino);
      assert.equal(afterRewrite.dev, beforeRewrite.dev);
      await session("replaced");
      await rm(provider);
      await session("removed");
    }
    console.log(`contextual completion ${extension}: exact owners, dormancy, retirement, repair and warm reuse passed`);
  }
}

try {
  const initialized = await request(child, responses, nextId++, "initialize", {
    capabilities: { textDocument: { completion: { completionItem: {
      snippetSupport: true, labelDetailsSupport: true
    } } } }
  });
  assert.deepEqual(initialized.result.capabilities.completionProvider,
    { resolveProvider: false, triggerCharacters: [".", ":"],
      completionItem: { labelDetailsSupport: true } });
  assert.deepEqual(initialized.result.capabilities.textDocumentSync,
    { openClose: true, change: 1, save: { includeText: false } });
  notify("initialized", {});
  await waitForIndexing(responses);
  const hoverParams = { textDocument: { uri: uri(filename) }, position: { line: 0, character: 8 } };
  const savedHover = await request(child, responses, nextId++, "textDocument/hover", hoverParams);
  assert.ok(savedHover.result, "saved fixture has no hover");
  const savedDependencyHover = await hover(dependency, positionOf(await readFile(dependency, "utf8"), "importedCall"));
  assert.match(savedDependencyHover.contents.value, /Test a saved count/,
    "saved hover lost compiler declaration documentation");

  let source = marked("function read(): integer\n local unsavedAnswer = 1\n return unsavedA@nswer\nend\n" +
    "function follow(): string local afterHole = \"later\" return afterHole end\n");
  open(filename, source.text, 3);
  const localPosition = positionOf(source.text, "unsavedAnswer");
  assert.equal(await hover(filename, localPosition), null,
    "dirty text borrowed saved offsets before any completion preparation");
  let result = await ready(filename, source.position, "unsavedAnswer", "unsaved lexical");
  const lexical = result.items.find((item) => item.label === "unsavedAnswer");
  assert.deepEqual(lexical.textEdit.range, { start: { line: 2, character: 8 }, end: { line: 2, character: 21 } });
  excludes(result, "disk_value");
  const dirtyHover = await request(child, responses, nextId++, "textDocument/hover", hoverParams);
  assert.equal(dirtyHover.result, null, "dirty text borrowed unrelated saved offsets");
  const ephemeralHover = await hover(filename, localPosition);
  assert.match(ephemeralHover.contents.value, /Type: `integer`/,
    "last completion did not expose the unsaved local declaration");
  assert.deepEqual(ephemeralHover.range, {
    start: { line: 1, character: 7 }, end: { line: 1, character: 20 }
  });
  const afterHole = await hover(filename, positionOf(source.text, "afterHole", 1));
  assert.match(afterHole.contents.value, /Type: `string`/,
    "hover lost an occurrence after the compiler's replacement dummy");
  const holeHover = await hover(filename, source.position);
  assertCurrentHoverWhenReady(holeHover, source.text, "unsavedAnswer", /Type: `integer`/,
    "completion hole exposed another occurrence instead of a fresh real token", 1);
  change(filename, source.text + "-- new buffer version\n");
  assert.deepEqual(await hover(filename, localPosition), ephemeralHover,
    "an unchanged local lost safe hover while refreshed analysis was pending");
  change(filename, source.text);
  notify("textDocument/didSave", { textDocument: { uri: uri(filename) } });
  await ready(filename, source.position, "unsavedAnswer", "didSave retains open text");

  // Duplicate and older versions must not replace the current full buffer.
  const stale = marked("function read(): integer\n local wrong = 1\n return wro@ng\nend\n");
  notify("textDocument/didChange", { textDocument: { uri: uri(filename), version: 3 }, contentChanges: [{ text: stale.text }] });
  await ready(filename, source.position, "unsavedAnswer", "stale version ignored");
  source = marked("function read(): integer\r\n local unsavedAnswer = 1\r\n local marker = \"😀\"; return unsavedA@nswer\r\nend\r\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "unsavedAnswer", "UTF-16 CRLF replacement");
  const unicodeStart = source.text.split("\n")[2].indexOf("unsavedAnswer");
  assert.deepEqual(result.items.find((item) => item.label === "unsavedAnswer").textEdit.range,
    { start: { line: 2, character: unicodeStart }, end: { line: 2, character: unicodeStart + 13 } });
  notify("textDocument/didClose", { textDocument: { uri: uri(filename) } });
  assert.deepEqual(await hover(filename, hoverParams.position), savedHover.result,
    "closed document did not restore ordinary saved hover");
  result = await complete(filename, source.position, "closed document");
  assert.deepEqual(result, { isIncomplete: true, items: [] });
  source = marked("function read(): integer\n local reopened = 1\n return reop@ened\nend\n");
  open(filename, source.text, 3);
  result = await ready(filename, source.position, "reopened", "same version new session");
  excludes(result, "unsavedAnswer");

  const callable = "function combine(count: integer, label: string): boolean return count > 0 end\n" +
    "function nothing(): integer return 1 end\n";
  source = marked(callable + "function read() comb@ine end\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "combine", "named function call snippet");
  const call = result.items.find((item) => item.label === "combine");
  assert.equal(call.detail, "combine(count: integer, label: string): boolean");
  assert.deepEqual(call.labelDetails, { detail: "(count: integer, label: string): boolean" });
  assert.equal(call.insertTextFormat, 2);
  assert.equal(call.textEdit.newText, "combine(${1:count}, ${2:label})$0");
  source = marked(callable + "function read() noth@ing end\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "nothing", "zero parameter call snippet");
  assert.equal(result.items.find((item) => item.label === "nothing").textEdit.newText, "nothing()$0");
  source = marked(callable + "function read() comb@ine { count = 1, label = \"one\" } end\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "combine", "preserved named call arguments");
  assert.equal(result.items.find((item) => item.label === "combine").insertTextFormat, 1);
  assert.equal(result.items.find((item) => item.label === "combine").textEdit.newText, "combine");

  source = marked("function read(callback: function(integer): integer) call@back end\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "callback", "unnamed function value uses positional placeholders");
  assert.equal(result.items.find((item) => item.label === "callback").textEdit.newText, "callback(${1:arg1})$0");
  assert.equal(result.items.find((item) => item.label === "callback").insertTextFormat, 2);

  const record = "record Cat\n field: integer\n callback: function(): integer\nend\nfunction Cat:method(): integer return self.field end\nfunction Cat.static(): integer return 1 end\n";
  source = marked(record + "function read(cat: Cat)\n cat.fi@XYZ\nend\n");
  change(filename, source.text, 9);
  result = await ready(filename, source.position, "field", "dot fields", { triggerKind: 2, triggerCharacter: "." });
  excludes(result, "method", "new", "static");
  const field = result.items.find((item) => item.label === "field");
  assert.equal(field.textEdit.range.end.character - field.textEdit.range.start.character, 5);
  source = marked(record + "function read(cat: Cat)\n cat:meth@od()\nend\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "method", "colon methods", { triggerKind: 2, triggerCharacter: ":" });
  excludes(result, "field", "callback", "new", "static");
  assert.equal(result.items.find((item) => item.label === "method").insertTextFormat, 1,
    "method completion duplicated existing parentheses");
  source = marked(record + "function read(cat: Cat)\n cat:meth@od\nend\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "method", "method placeholder call");
  assert.equal(result.items.find((item) => item.label === "method").textEdit.newText, "method()$0");

  const union = "union Message\n moved(x: integer, text: string, end: integer)\n empty()\nend\n";
  source = marked(union + "function make(): Message return Message.mo@ved(1, \"one\", 2) end\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "moved", "union positional constructor");
  const constructor = result.items.find((item) => item.label === "moved");
  assert.match(constructor.detail, /integer/);
  assert.match(constructor.detail, /string/);
  source = marked(union + "function make(): Message return Message.mo@ved {text = \"one\", end = 2, x = 1} end\n");
  change(filename, source.text);
  await ready(filename, source.position, "moved", "union named constructor");
  source = marked(union + "function read(message: Message): integer\n case message\n when moved(coordinate) then return coord@inate\n else return 0\n end\nend\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "coordinate", "union positional prefix binder");
  assert.match(result.items.find((item) => item.label === "coordinate").detail, /integer/);
  excludes(result, "text");
  source = marked(union + "function read(message: Message): string\n case message\n when moved{body = text; x; finish = end} then return body .. x .. finish\n catch return bo@dy\n else return \"empty\"\n end\nend\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "body", "union named binder in catch");
  assert.match(result.items.find((item) => item.label === "body").detail, /string/);
  source = marked(union + "function read(message: Message): string\n case message\n when moved{body = text} then return body\n else return @\n end\nend\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "message", "union binder outside arm");
  excludes(result, "body");

  source = marked('local imported = import "de@p"\n');
  change(filename, source.text);
  result = await ready(filename, source.position, "dep", "import catalog");
  assert.equal(result.isIncomplete, false);
  assert.equal(result.items.find((item) => item.label === "dep").kind, 9);
  assert.match(result.items.find((item) => item.label === "dep").documentation.value, /Saved dependency module/);
  open(dependency, "function dirtyOnly(): integer return 2 end\n");
  source = marked('local imported = import "dep"\nfunction read() imported.@ end\n');
  change(filename, source.text);
  result = await ready(filename, source.position, "savedOnly", "dirty dependency ignored");
  excludes(result, "dirtyOnly");
  source = marked('local imported = import "dep"\nfunction read() imported.imp@ortedCall end\n');
  change(filename, source.text);
  result = await ready(filename, source.position, "importedCall", "restored dependency callable names");
  const importedCall = result.items.find((item) => item.label === "importedCall");
  assert.equal(importedCall.detail, "importedCall(count: integer, label: string): boolean");
  assert.equal(importedCall.textEdit.newText, "importedCall(${1:count}, ${2:label})$0");
  assert.equal(importedCall.documentation.kind, "markdown");
  assert.match(importedCall.documentation.value, /Test a saved count/);
  assert.match(importedCall.documentation.value, /doc\/language\/functions.md#named-calls/);
  // Hover requires a fresh complete occurrence snapshot. Member completion
  // above may deliberately reuse provisional candidates while the new
  // buffer is incomplete; a new lexical candidate fences this valid buffer.
  source = marked('local imported = import "dep"\n' +
    'function read(): boolean\n local result = imported.importedCall(1, "one")\n return res@ult\nend\n');
  change(filename, source.text);
  await ready(filename, source.position, "result", "fresh imported module hover");
  const importedHover = await hover(filename, positionOf(source.text, "imported", 0));
  assert.match(importedHover.contents.value, /Saved dependency module/, "import alias lost module documentation");

  source = marked("--- Test an unsaved count.\n" +
    "function unsavedDoc(number: integer): integer return number end\n" +
    "function use(): integer return unsavedDoc(1) end\n" +
    "function complete(): integer return unsa@vedDoc(2) end\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "unsavedDoc", "unsaved documentation");
  assert.match(result.items.find((item) => item.label === "unsavedDoc").documentation.value, /Test an unsaved count/);
  const documentedHover = await hover(filename, positionOf(source.text, "unsavedDoc", 1));
  assert.match(documentedHover.contents.value, /Test an unsaved count/);
  const editedDocumentation = source.text.replace("Test an unsaved count", "Changed documentation");
  change(filename, editedDocumentation);
  const retainedDocumentation = await hover(filename, positionOf(editedDocumentation, "unsavedDoc", 1));
  assert.ok(retainedDocumentation, "an unchanged call lost provisional hover after a documentation edit");
  assert.deepEqual(retainedDocumentation.range, rangeOf(editedDocumentation, "unsavedDoc", 1));
  await readyHover(filename, editedDocumentation, "unsavedDoc", /Changed documentation/,
    "documentation refresh without another completion", 1);

  // Exercise actual acceptance, including the newly real occurrence that
  // was deliberately omitted from the completion's synthetic-hole snapshot.
  const acceptedPrefix = "--- Complete a named count.\r\n" +
    "function combine(count: integer, label: string): integer return count end\r\n";
  let accepted = marked(acceptedPrefix +
    "function read(count: integer, label: string): integer\r\n" +
    " local marker = \"😀\"; return comb@ine\r\nend\r\n" +
    "function stable(): integer local keeper = 1 return keeper end\r\n");
  open(acceptedFile, accepted.text);
  const acceptedList = await ready(acceptedFile, accepted.position, "combine", "accept a named function call");
  const acceptedItem = acceptedList.items.find((item) => item.label === "combine");
  assert.equal(acceptedItem.textEdit.newText, "combine(${1:count}, ${2:label})$0");
  const keeperHover = await hover(acceptedFile, positionOf(accepted.text, "keeper", 1));
  assert.match(keeperHover.contents.value, /Type: `integer`/);
  let acceptedText = acceptCompletion(accepted.text, acceptedItem);
  assert.ok(acceptedText.includes("return combine(count, label)"));
  change(acceptedFile, acceptedText);
  assertCurrentHoverWhenReady(await hover(acceptedFile, positionOf(acceptedText, "combine", 1)),
    acceptedText, "combine", /combine\(count: integer, label: string\): integer/,
    "the inserted callee borrowed another token's hover", 1);
  const retainedKeeper = await hover(acceptedFile, positionOf(acceptedText, "keeper", 1));
  assert.match(retainedKeeper.contents.value, /Type: `integer`/,
    "accepting a snippet hid an existing safe local during refresh");
  assert.deepEqual(retainedKeeper.range, rangeOf(acceptedText, "keeper", 1));
  const acceptedHover = await readyHover(acceptedFile, acceptedText, "combine",
    /combine\(count: integer, label: string\): integer/,
    "accepted function callee refresh without another completion", 1);
  assert.match(acceptedHover.contents.value, /Complete a named count/);

  // Accepting default placeholder names usually leaves unresolved arguments
  // until the user fills them. Their type errors must not erase the known
  // callable signature or the following, independently checked local.
  const unresolved = marked(acceptedPrefix +
    "function read(): integer return comb@ine end\r\n" +
    "function stable(): integer local followingLocal = 1 return followingLocal end\r\n");
  change(acceptedFile, unresolved.text);
  const unresolvedList = await ready(acceptedFile, unresolved.position, "combine",
    "accept callable placeholders before filling unresolved arguments");
  const unresolvedText = acceptCompletion(unresolved.text,
    unresolvedList.items.find((item) => item.label === "combine"));
  assert.ok(unresolvedText.includes("function read(): integer return combine(count, label)"));
  change(acceptedFile, unresolvedText);
  await readyHover(acceptedFile, unresolvedText, "combine",
    /combine\(count: integer, label: string\): integer/,
    "unresolved accepted placeholders retain callee hover without another completion", 1);
  await readyHover(acceptedFile, unresolvedText, "followingLocal", /Type: `integer`/,
    "unresolved accepted placeholders preserve a following local", 1);
  change(acceptedFile, acceptedText);
  await readyHover(acceptedFile, acceptedText, "keeper", /Type: `integer`/,
    "valid argument scope restores automatically after unresolved placeholders", 1);

  acceptedText = "-- 😀 shifted UTF-16 positions\r\n" + acceptedText
    .replace("Complete a named count", "Changed accepted documentation")
    .replaceAll("count: integer", "count: float")
    .replaceAll("): integer return count", "): float return count")
    .replace("label: string): integer", "label: string): float");
  change(acceptedFile, acceptedText);
  const shiftedKeeper = await hover(acceptedFile, positionOf(acceptedText, "keeper", 1));
  assert.match(shiftedKeeper.contents.value, /Type: `integer`/);
  assert.deepEqual(shiftedKeeper.range, rangeOf(acceptedText, "keeper", 1),
    "provisional hover did not remap unchanged tokens through CRLF and UTF-16 text");
  const changedCallHover = await readyHover(acceptedFile, acceptedText, "combine",
    /combine\(count: float, label: string\): float/,
    "continued signature edits without another completion", 1);
  assert.match(changedCallHover.contents.value, /Changed accepted documentation/);

  // A parser-invalid tail cannot replace semantic facts, but untouched tokens
  // retain their prior knowledge while rewritten or newly inserted tokens do not.
  const broken = acceptedText + "function pending(\r\n";
  change(acceptedFile, broken);
  assert.deepEqual(await hover(acceptedFile, positionOf(broken, "keeper", 1)), shiftedKeeper,
    "an incomplete declaration hid a safe unchanged occurrence");
  const rewritten = broken.replace("return keeper end", "return other end");
  change(acceptedFile, rewritten);
  assert.equal(await hover(acceptedFile, positionOf(rewritten, "other")), null,
    "a rewritten token borrowed the removed local occurrence's hover");
  const recovered = acceptedText.replaceAll("keeper", "recoveredKeeper");
  change(acceptedFile, recovered);
  await readyHover(acceptedFile, recovered, "recoveredKeeper", /Type: `integer`/,
    "valid text recovers automatically after incomplete typing", 1);
  await readyHover(acceptedFile, recovered, "combine", /combine\(count: float, label: string\): float/,
    "callee hover survives incomplete typing and recovery", 1);

  // didSave itself must not discard current editor knowledge. The subsequent
  // watcher publication replaces the saved baseline, then current hover recovers.
  notify("textDocument/didSave", { textDocument: { uri: uri(acceptedFile) } });
  await readyHover(acceptedFile, recovered, "recoveredKeeper", /Type: `integer`/,
    "save notification before watcher publication", 1);
  const savedEpoch = responses.lastIndexingEpoch;
  await writeFile(acceptedFile, recovered);
  notify("textDocument/didSave", { textDocument: { uri: uri(acceptedFile) } });
  await waitForIndexing(responses, "ready", 1, savedEpoch + 1);
  await readyHover(acceptedFile, recovered, "combine", /combine\(count: float, label: string\): float/,
    "saved watcher handoff retains the current accepted call", 1);

  const retiredText = recovered.replaceAll("recoveredKeeper", "retiredKeeper");
  change(acceptedFile, retiredText);
  notify("textDocument/didClose", { textDocument: { uri: uri(acceptedFile) } });
  const reopenedText = recovered.replace(
    "function stable(): integer local recoveredKeeper = 1 return recoveredKeeper end",
    "function stable(): string local reopenedKeeper = \"new session\" return reopenedKeeper end");
  assert.ok(reopenedText.includes("local reopenedKeeper = \"new session\""));
  open(acceptedFile, reopenedText, 1);
  assertCurrentHoverWhenReady(await hover(acceptedFile, positionOf(reopenedText, "reopenedKeeper", 1)),
    reopenedText, "reopenedKeeper", /Type: `string`/,
    "a reopened session inherited its previous session's local type or coordinates", 1);
  await readyHover(acceptedFile, reopenedText, "reopenedKeeper", /Type: `string`/,
    "same-version reopened session prepares its own hover", 1);
  assert.equal(await readFile(acceptedFile, "utf8"), recovered,
    "automatic hover refresh promoted reopened editor text to disk");

  accepted = marked("record Counter\n value: integer\nend\n" +
    "function Counter:add(amount: integer): integer return self.value + amount end\n" +
    "function read(counter: Counter, amount: integer): integer return counter:a@dd end\n");
  change(acceptedFile, accepted.text);
  const methodList = await ready(acceptedFile, accepted.position, "add", "accept a bound method call");
  const methodItem = methodList.items.find((item) => item.label === "add");
  assert.equal(methodItem.textEdit.newText, "add(${1:amount})$0");
  const methodText = acceptCompletion(accepted.text, methodItem);
  assert.ok(methodText.includes("return counter:add(amount)"));
  change(acceptedFile, methodText);
  assertCurrentHoverWhenReady(await hover(acceptedFile, positionOf(methodText, "add", 1)),
    methodText, "add", /Counter:add\(amount: integer\): integer/,
    "an accepted bound method borrowed another token's hover", 1);
  await readyHover(acceptedFile, methodText, "add", /Counter:add\(amount: integer\): integer/,
    "accepted bound method refresh without another completion", 1);
  notify("textDocument/didClose", { textDocument: { uri: uri(acceptedFile) } });

  source = marked("function read(x: foreign const *unsigned lo@ng long) end\n");
  change(filename, source.text);
  result = await ready(filename, source.position, "unsigned long long", "foreign primitive leaf");
  excludes(result, "integer", "ffi");
  const primitive = result.items.find((item) => item.label === "unsigned long long");
  assert.equal(primitive.textEdit.range.end.character - primitive.textEdit.range.start.character, "unsigned long long".length);
  source = marked(foreignPrefix + "function read(x: foreign Wid@get) end\n");
  open(foreignFile, source.text);
  result = await ready(foreignFile, source.position, "Widget", "foreign typedef leaf");
  excludes(result, "callable", "integer");
  source = marked(foreignPrefix + "function read() ffi.ca@llable end\n");
  change(foreignFile, source.text);
  result = await ready(foreignFile, source.position, "callable", "ffi final namespace");
  excludes(result, "Widget");

  // This header appears only in dirty text, so saved indexing does not own its
  // freshness. Same-context retries must retain useful candidates and still
  // allow private header validation/preparation to converge on changed names.
  const volatileHeader = path.join(root, "volatile.h");
  await writeFile(volatileHeader, "int volatilePriorFunction(int argument);\n");
  source = marked(`foreign import ${JSON.stringify(volatileHeader)}\nfunction read() ffi.volatile@ end\n`);
  change(foreignFile, source.text);
  await ready(foreignFile, source.position, "volatilePriorFunction", "unsaved-only header cold");
  await writeFile(volatileHeader, "int volatileFreshFunction(int argument);\n");
  result = await complete(foreignFile, source.position, "unsaved-only header provisional");
  assert.equal(result.isIncomplete, true);
  assert.ok(result.items.some((item) => item.label === "volatilePriorFunction"),
    "header validation discarded usable prepared candidates");
  result = await ready(foreignFile, source.position, "volatileFreshFunction", "unsaved-only header refreshed");
  excludes(result, "volatilePriorFunction");

  source = marked("function read(): value\n return current.va@lue\nend\n");
  open(folderMain, source.text);
  const contributor = path.join(root, "box/fields.titan");
  open(contributor, "record Box\n value: integer\nend\nlocal current = Box.new(1)\n");
  const folderResult = await ready(folderMain, source.position, "value", "new unsaved folder contributor");
  const folderText = acceptCompletion(source.text, folderResult.items.find((item) => item.label === "value"));
  change(folderMain, folderText);
  await readyHover(folderMain, folderText, "value", /Type: `integer`/,
    "accepted folder member receives current hover", 1);
  change(contributor, "record Box\n value: string\nend\nlocal current = Box.new(\"later\")\n");
  await readyHover(folderMain, folderText, "value", /Type: `string`/,
    "contributor edit refreshes another file's hover without completion", 1);
  const fresh = path.join(root, "fresh.titan");
  source = marked("function read(): integer\n local brandNew = 1\n return brand@New\nend\n");
  open(fresh, source.text);
  await ready(fresh, source.position, "brandNew", "new file-backed module");
  await assert.rejects(readFile(fresh), { code: "ENOENT" });
  await assert.rejects(readFile(contributor), { code: "ENOENT" });
  assert.equal(await readFile(filename, "utf8"), saved, "completion wrote dirty bytes to disk");

  // Measure private preparation independently from repeated SQL selection on
  // a large dirty record, then request while a saved module refresh competes.
  await sampleMemory("before large dirty module");
  source = marked(`record Large\n${fields()}\nend\nfunction read(value: Large) value.field079@XYZ end\n`);
  change(filename, source.text);
  await ready(filename, source.position, "field0790", "large cold");
  for (let attempt = 0; attempt < warmRequests; attempt++) {
    await ready(filename, source.position, "field0790", "large warm");
  }
  // Keep useful compiler candidates while typing schedules replacement work.
  // Both filtering and edits must use this request's current unsaved token.
  const typed = marked(`record Large\n${fields()}\nend\nfunction read(value: Large) value.field0799@LONG_SUFFIX end\n`);
  change(filename, typed.text);
  const provisional = await complete(filename, typed.position, "provisional typing");
  assert.equal(provisional.isIncomplete, true,
    "reused candidates must advertise that fresh preparation is pending");
  const typedField = provisional.items.find((item) => item.label === "field0799");
  assert.ok(typedField, "typing discarded usable prepared candidates");
  excludes(provisional, "field0790", "field0791");
  const typedLine = typed.text.split("\n")[typed.position.line];
  const typedStart = typedLine.indexOf("field0799LONG_SUFFIX");
  assert.deepEqual(typedField.textEdit.range, {
    start: { line: typed.position.line, character: typedStart },
    end: { line: typed.position.line, character: typedStart + "field0799LONG_SUFFIX".length }
  }, "provisional edits retained the previous token's suffix or extent");
  change(filename, source.text);
  await ready(filename, source.position, "field0790", "after provisional typing");
  await sampleMemory("after large dirty module");
  for (let version = 0; version < 8; version++) {
    change(filename, source.text + `-- superseded generation ${version}\n`);
    await ready(filename, source.position, "field0790", "large replacement");
  }
  await sampleMemory("after eight replacements");
  const previousEpoch = responses.lastIndexingEpoch;
  await writeFile(background, largeSaved("float"));
  await complete(filename, source.position, "competing saved refresh");
  await waitForIndexing(responses, "ready", 1, previousEpoch + 1);
  await ready(filename, source.position, "field0790", "after saved refresh");
  notify("textDocument/didClose", { textDocument: { uri: uri(filename) } });
  await complete(filename, source.position, "after large close");
  await sampleMemory("after large close");

  const shutdown = await request(child, responses, nextId++, "shutdown", null);
  assert.equal(shutdown.result, null);
  notify("exit", null);
  child.stdin.end();
  assert.deepEqual(await withTimeout(exit, "completion server shutdown", 10_000), { code: 0, signal: null });
  const logs = structuredLogRecords(stderr());
  const prepare = logs.filter((entry) => entry.event === "completion.prepare");
  const select = logs.filter((entry) => entry.event === "completion.select");
  assert.ok(logs.some((entry) => entry.event === "completion.provisional"),
    "typing did not exercise retained prepared candidates");
  // Header revalidation and cancelled preparations can add prepare events
  // while requests use provisional rows. Their whole-run counts are unrelated.
  // The held-permit service regression proves that repeated ready selection
  // never invokes or decodes the compiler; this transcript measures both paths.
  assert.ok(prepare.length > 0 && select.length >= warmRequests,
    "completion did not exercise preparation and repeated SQL selection");
  for (const entry of [...prepare, ...select]) {
    assert.ok(Number.isFinite(entry.cpu_ms) && entry.cpu_ms >= 0);
    assert.ok(Number.isFinite(entry.wall_ms) && entry.wall_ms >= 0);
  }
  assert.equal(logs.some((entry) => entry.event === "completion.failure" || entry.event === "completion.prepare.failure"), false,
    "completion emitted a failure log");
  console.log(JSON.stringify({ completion: "passed", measurements, memory,
    preparation: prepare.map(({ module, cpu_ms, wall_ms }) => ({ module, cpu_ms, wall_ms })),
    selection: select.map(({ cpu_ms, wall_ms }) => ({ cpu_ms, wall_ms })) }));
  await testContextualBinaryCompletion();
} catch (cause) {
  throw new Error(`${cause.message}\n${stderr().toString("utf8")}`, { cause });
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await withTimeout(exit, "failed completion server cleanup", 5_000).catch(() => child.kill("SIGKILL"));
  }
  await rm(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FrameReader, collect, exitOf, frame, launch, makePhysicalTemporaryRoot,
  request, structuredLogRecords, waitForIndexing, withTimeout
} from "./test-server-protocol.mjs";

assert.ok(process.argv[2], "usage: node scripts/test-completion-protocol.mjs PATH-TO-SERVER");
const root = await makePhysicalTemporaryRoot("vscode-titan-completion-");
const filename = path.join(root, "app.titan");
const dependency = path.join(root, "dep.titan");
const foreignFile = path.join(root, "foreigns.titan");
const background = path.join(root, "background.titan");
const folderMain = path.join(root, "box/box.titan");
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

async function hover(file, position) {
  const response = await request(child, responses, nextId++, "textDocument/hover", {
    textDocument: { uri: uri(file) }, position
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result;
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
  assert.equal(holeHover, null, "dummy completion token acquired an editor hover identity");
  change(filename, source.text + "-- new buffer version\n");
  assert.equal(await hover(filename, localPosition), null,
    "buffer changes did not retire ephemeral hover context");
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
  change(filename, source.text.replace("Test an unsaved count", "Changed documentation"));
  assert.equal(await hover(filename, positionOf(source.text, "unsavedDoc", 1)), null,
    "edited documentation reused an older completion hover");

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

  source = marked("function read(): integer\n return current.va@lue\nend\n");
  open(folderMain, source.text);
  const contributor = path.join(root, "box/fields.titan");
  open(contributor, "record Box\n value: integer\nend\nlocal current = Box.new(1)\n");
  await ready(folderMain, source.position, "value", "new unsaved folder contributor");
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
} catch (cause) {
  throw new Error(`${cause.message}\n${stderr().toString("utf8")}`, { cause });
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await withTimeout(exit, "failed completion server cleanup", 5_000).catch(() => child.kill("SIGKILL"));
  }
  await rm(root, { recursive: true, force: true });
}

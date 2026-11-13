// Client transcripts over framed stdio. Most cases launch the real server;
// controlled lifecycle cases use the production router with a framed test peer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import * as os from "node:os";
import { stripTypeScriptTypes } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FrameReader,
  collect,
  collectNotification,
  exitOf,
  frame,
  launch,
  request,
  withTimeout
} from "./test-server-protocol.mjs";

const QUERY_TIMEOUT_MILLISECONDS = 30_000;
const STATUS_TIMEOUT_MILLISECONDS = 30_000;
const POLL_INTERVAL_MILLISECONDS = 25;

// Exercise the extension's actual model without requiring a separate extension
// build before this server-only gate. This module has no runtime dependencies.
const indexingSource = await readFile(
  new URL("../src/extension/indexingProtocol.ts", import.meta.url), "utf8");
const { IndexingStatusModel } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(indexingSource))
    .toString("base64")}`);

class Session {
  constructor(child) {
    this.child = child;
    this.stderr = collect(child.stderr);
    this.responses = new FrameReader(child.stdout);
    this.exit = exitOf(child);
    this.nextId = 1;
    this.initialized = false;
  }

  async initialize(params) {
    const response = await request(
      this.child, this.responses, this.nextId++, "initialize", params,
      QUERY_TIMEOUT_MILLISECONDS
    );
    assert.equal(response.error, undefined, JSON.stringify(response));
    this.initialized = true;
    return response.result;
  }

  notify(method, params) {
    this.child.stdin.write(frame({ jsonrpc: "2.0", method, params }));
  }

  async send(method, params, milliseconds = QUERY_TIMEOUT_MILLISECONDS) {
    try {
      return await request(
        this.child, this.responses, this.nextId++, method, params, milliseconds
      );
    } catch (cause) {
      throw new Error(
        `${method}: ${cause.message}; server stderr: ${this.stderr().toString("utf8")}`,
        { cause }
      );
    }
  }

  async result(method, params, milliseconds = QUERY_TIMEOUT_MILLISECONDS) {
    const response = await this.send(method, params, milliseconds);
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result;
  }

  async failure(method, params, milliseconds = QUERY_TIMEOUT_MILLISECONDS) {
    const response = await this.send(method, params, milliseconds);
    assert.ok(response.error, `expected a failure, received ${JSON.stringify(response)}`);
    return response.error;
  }

  async status() {
    const result = await this.result("titan/workspaceStatus", {});
    assert.ok(Array.isArray(result.roots), "workspaceStatus did not report roots");
    return result.roots;
  }

  async shutdown() {
    const response = await this.send("shutdown", null);
    assert.equal(response.result, null);
    this.child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));
    assert.deepEqual(await withTimeout(this.exit, "server exit", 30_000),
      { code: 0, signal: null });
    await this.responses.finish();
    assert.equal(this.responses.buffer.length, 0,
      "server left unread protocol bytes after exit");
  }

  async abort() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await withTimeout(this.exit, "aborted server exit", 5_000).catch(() => undefined);
    }
  }
}

const temporaryDirectories = [];

async function makeBase(label) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), `titan-multi-${label}-`)));
  temporaryDirectories.push(base);
  return base;
}

async function removeTemporaryDirectories() {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
}

function uri(filename) {
  return pathToFileURL(filename).href;
}

// The server publishes roots, SDK paths and probe caches in canonical slash
// spelling (roots.canonical); a host path names the same file with the
// platform separators, so comparisons normalise separators, not spelling.
const serverPath = (value) => value.replaceAll("\\", "/");
function samePath(left, right) {
  return typeof left === "string" && typeof right === "string" &&
    serverPath(left) === serverPath(right);
}
function findRoot(roots, rootPath) {
  return roots.find((candidate) => samePath(candidate.root, rootPath));
}

// Creating symbolic links needs SeCreateSymbolicLinkPrivilege or Developer Mode
// on Windows. When the account has neither, the cases that prove symlink
// semantics skip, exactly as the native suite's own symlink cases do.
let symlinkCapability;
async function canCreateSymlinks() {
  if (symlinkCapability !== undefined) return symlinkCapability;
  const probe = await mkdtemp(path.join(os.tmpdir(), "titan-multi-link-"));
  try {
    await symlink(probe, path.join(probe, "link"));
    symlinkCapability = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS", "EINVAL"].includes(error.code)) throw error;
    symlinkCapability = false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
  return symlinkCapability;
}

function positionOf(text, token, occurrence = 0) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = text.indexOf(token, offset + 1);
  }
  assert.ok(offset >= 0, `fixture is missing ${token}`);
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1).length };
}

// Every probe reports the last observation it rejected, so a timeout names the
// server's actual answer instead of only the expectation.
async function poll(description, probe,
                    milliseconds = STATUS_TIMEOUT_MILLISECONDS) {
  const deadline = performance.now() + milliseconds;
  let observation;
  while (performance.now() < deadline) {
    observation = await probe();
    if (observation.accepted !== undefined) return observation.accepted;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MILLISECONDS));
  }
  assert.fail(
    `${description}: last observation ${JSON.stringify(observation?.rejected)}`);
}

async function pollHover(session, filename, text, token, expected, label) {
  const params = {
    textDocument: { uri: uri(filename) },
    position: positionOf(text, token)
  };
  return poll(`${label}: hover did not converge`, async () => {
    const response = await session.send("textDocument/hover", params);
    if (response.error) return { rejected: response.error };
    const value = response.result?.contents?.value;
    if (typeof value === "string" && expected.test(value)) {
      return { accepted: response.result };
    }
    return { rejected: response.result };
  });
}

function endOfToken(text, token, occurrence = 0) {
  const position = positionOf(text, token, occurrence);
  return { line: position.line, character: position.character + token.length };
}

async function pollDefinition(session, filename, position, label) {
  return poll(`${label}: definition did not converge`, async () => {
    const response = await session.send("textDocument/definition", {
      textDocument: { uri: uri(filename) },
      position
    });
    if (response.error) return { rejected: response.error };
    return response.result
      ? { accepted: response.result }
      : { rejected: response.result };
  });
}

async function pollCompletion(session, filename, position, label) {
  return poll(`${label}: completion did not converge`, async () => {
    const response = await session.send("textDocument/completion", {
      textDocument: { uri: uri(filename) },
      position,
      context: { triggerKind: 1 }
    });
    if (response.error) return { rejected: response.error };
    const items = response.result?.items;
    return Array.isArray(items) && items.length > 0
      ? { accepted: items }
      : { rejected: response.result };
  });
}

async function pollFailure(session, method, params, label) {
  return poll(`${label}: no failure arrived`, async () => {
    const response = await session.send(method, params);
    return response.error
      ? { accepted: response.error }
      : { rejected: response.result };
  });
}

async function pollStatus(session, predicate, label) {
  return poll(label, async () => {
    const roots = await session.status();
    return predicate(roots) ? { accepted: roots } : { rejected: roots };
  });
}

function assertReady(roots, rootPath, label) {
  const entry = rootEntry(roots, rootPath);
  assert.equal(entry.state, "ready",
    `${label}: root is ${entry.state}: ${entry.failure ?? ""}`);
  return entry;
}

async function pollSettled(session, count, label) {
  return pollStatus(session, (entries) =>
    entries.length === count &&
    entries.every((entry) => entry.state === "ready" || entry.state === "failed"),
    label);
}

function rootEntry(roots, rootPath) {
  const entry = findRoot(roots, rootPath);
  assert.ok(entry, `workspaceStatus omitted ${rootPath}: ${JSON.stringify(roots)}`);
  return entry;
}

const ROOT_CONFIG = 'include = { "./src" }\nsource_module_roots = { "./src" }\n';

// Each root uses the same module name and the same symbol names. Only the
// bytes differ, so a leaked fact from one root is visible in the other.
const ROOT_A_SOURCE = [
  "local function doubled(value: integer): integer",
  "  return value * 2",
  "end",
  "function answer(): integer",
  "  return doubled(21)",
  "end",
  ""
].join("\n");

const ROOT_B_SOURCE = [
  "local function tripled(value: integer): integer",
  "  return value * 3",
  "end",
  "function answer(): integer",
  "  return tripled(10)",
  "end",
  ""
].join("\n");

async function writeRoot(directory, source, config = ROOT_CONFIG) {
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(path.join(directory, "titan-config.lua"), config, "utf8");
  await writeFile(path.join(directory, "src", "main.titan"), source, "utf8");
  return path.join(directory, "src", "main.titan");
}

// The selected SDK must resolve the standard library from its own archive.
// This source imports one, so a dynamic-first resolution would try to load the
// farm's deliberately broken provider object instead.
const SDK_SOURCE = [
  'local json = import "titan.json"',
  "local function tripled(value: integer): integer",
  "  return value * 3",
  "end",
  "function answer(): integer",
  "  return tripled(10)",
  "end",
  "function encoded(): string",
  "  return json.encode(answer())",
  "end",
  ""
].join("\n");

// A watched file outside every source module root is the cheapest per-root
// diagnostic that leaves the rest of the project analyzable.
const UNMAPPED_CONFIG =
  'include = { "." }\nsource_module_roots = { "./src" }\n';
const STRAY_SOURCE = "function stray(): integer\n  return 1\nend\n";

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
}

// Every file of an installed SDK is a symlink to the session SDK; the files a
// case changes are copied so the session SDK stays immutable.
// Only the trees an installed SDK's compiler reads are farmed; the case copies
// the few files it changes so the session SDK stays immutable.
const SDK_FARM_DIRECTORIES = ["share", "lib", "include", "src"];

async function farmDirectory(source, target) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await farmDirectory(from, to);
    } else if (entry.isFile()) {
      await symlink(from, to);
    }
  }
}

async function farmSdk(source, target) {
  await mkdir(target, { recursive: true });
  for (const name of SDK_FARM_DIRECTORIES) {
    const from = path.join(source, name);
    const info = await stat(from).catch(() => undefined);
    if (info === undefined) continue;
    if (info.isDirectory()) {
      await farmDirectory(from, path.join(target, name));
    } else {
      await symlink(from, path.join(target, name));
    }
  }
}

// A farm write must stay inside the farm. The session SDK is shared and must
// never be modified, so an aliased directory, a copy onto itself, or a path
// that resolves inside the SDK is a hard failure before anything is written.
async function assertFarmedFile(farm, filename) {
  const parent = await realpath(path.dirname(filename));
  const root = await realpath(farm);
  assert.ok(parent.startsWith(root + path.sep),
    `test write would escape the SDK farm: ${filename}`);
  const session = await realpath(sdkRoot());
  assert.ok(parent !== session && !parent.startsWith(session + path.sep),
    `refusing to write inside the session SDK: ${filename}`);
  const info = await lstat(filename);
  assert.equal(info.isFile(), false,
    `${filename} is a real file, not a farm symlink`);
}

async function replaceWithCopy(filename) {
  const contents = await readFile(filename);
  await rm(filename);
  await writeFile(filename, contents);
}

function sdkRoot() {
  const prefix = process.env.TITAN_ROOT;
  assert.ok(prefix && prefix.length > 0,
    "the multi-root suite needs TITAN_ROOT to build a second SDK");
  return prefix;
}

async function testIndependentRoots() {
  const base = await makeBase("roots");
  const rootA = path.join(base, "a");
  const rootB = path.join(base, "b");
  const sourceA = await writeRoot(rootA, ROOT_A_SOURCE);
  const sourceB = await writeRoot(rootB, ROOT_B_SOURCE, UNMAPPED_CONFIG);
  const stray = path.join(rootB, "stray.titan");
  await writeFile(stray, STRAY_SOURCE, "utf8");
  const session = new Session(launch(rootA, "error"));
  try {
    const result = await session.initialize({
      workspaceFolders: [
        { uri: uri(rootA), name: "a" },
        { uri: uri(rootB), name: "b" }
      ],
      initializationOptions: { trustedRoots: [rootA, rootB] }
    });
    assert.deepEqual(result.capabilities.workspace, {
      workspaceFolders: { supported: true, changeNotifications: true }
    }, "the router did not advertise folder changes");
    session.notify("initialized", {});

    const roots = await pollSettled(session, 2, "both roots did not start");
    assertReady(roots, rootA, "root A");
    assertReady(roots, rootB, "root B");
    assert.deepEqual(roots.map((entry) => entry.origin).sort(), ["folder", "folder"]);
    assert.equal(roots[0].compilerRoot, null,
      "a root without compiler_root reported a selected SDK");
    assert.notEqual(roots[0].workerPid, roots[1].workerPid,
      "two roots shared one worker process");
    // Probe caches are raw-C-source keyed, so two roots must never share one.
    const probeA = rootEntry(roots, rootA).probePrefix;
    const probeB = rootEntry(roots, rootB).probePrefix;
    assert.ok(typeof probeA === "string" && probeA.length > 0,
      "a root reported no probe prefix");
    assert.notEqual(probeA, probeB, "two roots shared one probe prefix");
    assert.equal(probeA, serverPath(path.join(await realpath(rootA), ".titan-ls")),
      "a root's probe prefix escaped its own root");
    assert.equal(serverPath(rootEntry(roots, rootA).titanRoot),
      serverPath(process.env.TITAN_ROOT ?? ""),
      "a default root did not inherit the server's own SDK");

    const hoverA = await pollHover(session, sourceA, ROOT_A_SOURCE, "doubled",
      /integer/, "root A");
    assert.match(hoverA.contents.value, /doubled|integer/);
    const hoverB = await pollHover(session, sourceB, ROOT_B_SOURCE, "tripled",
      /integer/, "root B");
    assert.equal(hoverB.contents.value.includes("tripled"), true,
      "root B hover did not describe its own local function");
    assert.equal(hoverA.contents.value.includes("tripled"), false,
      "root A hover described root B's local function");

    const definitionA = await pollDefinition(session, sourceA,
      positionOf(ROOT_A_SOURCE, "doubled", 1), "root A");
    const definitionB = await pollDefinition(session, sourceB,
      positionOf(ROOT_B_SOURCE, "tripled", 1), "root B");
    assert.ok(definitionA && definitionB, "a root lost its definition");
    assert.equal(definitionA.uri ?? definitionA[0].uri, uri(sourceA));
    assert.equal(definitionB.uri ?? definitionB[0].uri, uri(sourceB));

    // Completion consumes the open editor buffer, as a client always opens a
    // document before asking for it.
    session.notify("textDocument/didOpen", {
      textDocument: { uri: uri(sourceA), languageId: "titan", version: 1, text: ROOT_A_SOURCE }
    });
    const itemsA = await pollCompletion(session, sourceA,
      endOfToken(ROOT_A_SOURCE, "doubled", 1), "root A completion");
    assert.ok(itemsA.some((item) => item.label === "doubled"),
      "root A completion missed its own local");
    assert.equal(itemsA.some((item) => item.label === "tripled"), false,
      "root A completion leaked root B's local");

    // Diagnostics are root-owned: root B's unmapped file publishes only in
    // root B, and each root keeps its own database and probe cache.
    const publications = await poll("root B diagnostics", async () => {
      const found = session.responses.diagnosticPublications.filter(
        (publication) => publication.uri === uri(stray));
      return found.some((publication) => publication.diagnostics.length > 0)
        ? { accepted: found }
        : { rejected: found };
    });
    assert.ok(publications.some((publication) =>
      publication.diagnostics.some((diagnostic) => diagnostic.code === "unmapped-source")),
      "root B published no unmapped-source diagnostic");
    assert.equal(
      session.responses.diagnosticPublications.some(
        (publication) => publication.uri === uri(sourceA) &&
          publication.diagnostics.length > 0),
      false,
      "root A received diagnostics for its clean document");
    for (const directory of [rootA, rootB]) {
      assert.ok(await exists(path.join(directory, ".titan-ls", "index.sqlite3")),
        `${directory} wrote no workspace cache`);
    }
    assert.notEqual(
      await realpath(path.join(rootA, ".titan-ls")),
      await realpath(path.join(rootB, ".titan-ls"))
    );
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testFolderChanges() {
  const base = await makeBase("folders");
  const rootA = path.join(base, "a");
  const rootB = path.join(base, "b");
  const sourceA = await writeRoot(rootA, ROOT_A_SOURCE);
  const sourceB = await writeRoot(rootB, ROOT_B_SOURCE);
  const session = new Session(launch(rootA, "error", { TITAN_LS_TRUSTED_ROOTS: rootA + path.delimiter + rootB }));
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(rootA), name: "a" }]
    });
    session.notify("initialized", {});
    await pollStatus(session, (roots) =>
      roots.length === 1 && roots[0].state === "ready", "root A did not start");

    // The omp order: the folder change notification precedes the document.
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(rootB), name: "b" }], removed: [] }
    });
    session.notify("textDocument/didOpen", {
      textDocument: { uri: uri(sourceB), languageId: "titan", version: 1, text: ROOT_B_SOURCE }
    });
    const twoRoots = await pollStatus(session, (roots) =>
      roots.length === 2 && roots.some((entry) => samePath(entry.root, rootB) &&
        entry.state === "ready"),
      "the added folder did not activate");
    assert.equal(rootEntry(twoRoots, rootB).origin, "folder");
    await pollHover(session, sourceB, ROOT_B_SOURCE, "tripled", /integer/,
      "the added root");
    // The omp order: a status request that follows a completed request for a
    // root must report that root.
    const afterServing = await session.status();
    assert.equal(afterServing.filter((entry) => samePath(entry.root, rootB)).length, 1,
      `workspaceStatus omitted a root that just served a request: ${
        JSON.stringify(afterServing.map((entry) => entry.root))}`);

    // Removal releases the root: its warm worker stays for a later re-add.
    const servedPid = rootEntry(twoRoots, rootB).workerPid;
    const servedGeneration = rootEntry(twoRoots, rootB).generation;
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [{ uri: uri(rootB), name: "b" }] }
    });
    const released = await pollStatus(session, (roots) => {
      const entry = findRoot(roots, rootB);
      return entry?.origin === "released" && entry.state === "ready"
        ? { accepted: roots }
        : { rejected: roots };
    }, "the folder removal did not release its root");
    assert.equal(rootEntry(released, rootB).workerPid, servedPid,
      "releasing a folder stopped its worker");
    assert.equal(rootEntry(released, rootA).state, "ready",
      "removing one folder disturbed another root");
    assert.equal(rootEntry(released, rootA).workerPid,
      rootEntry(twoRoots, rootA).workerPid,
      "removing one folder restarted another root");
    await pollHover(session, sourceA, ROOT_A_SOURCE, "doubled",
      /doubled|integer/, "the surviving root");

    // A released root still answers documents that its own configuration
    // claims, through discovery, with the same warm worker.
    await pollHover(session, sourceB, ROOT_B_SOURCE, "tripled", /integer/,
      "the released root's document");
    const rediscovered = await pollStatus(session, (roots) => {
      const entry = findRoot(roots, rootB);
      return entry?.origin === "discovered"
        ? { accepted: roots }
        : { rejected: roots };
    }, "the released root was not reclaimed through discovery");
    assert.equal(rootEntry(rediscovered, rootB).workerPid, servedPid,
      "discovery restarted the released root's worker");
    assert.equal(rootEntry(rediscovered, rootB).generation, servedGeneration,
      "discovery advanced the released root's generation");

    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(rootB), name: "b" }], removed: [] }
    });
    const readded = await pollStatus(session, (roots) =>
      roots.some((entry) => samePath(entry.root, rootB) && entry.origin === "folder"),
      "the re-added folder did not reclaim its root");
    assert.equal(rootEntry(readded, rootB).state, "ready",
      "a re-added root lost its worker");
    assert.equal(rootEntry(readded, rootB).workerPid, servedPid,
      "re-adding a folder restarted its worker");
    assert.equal(rootEntry(readded, rootB).generation, servedGeneration,
      "re-adding a folder advanced the generation");
    await pollHover(session, sourceB, ROOT_B_SOURCE, "tripled", /integer/,
      "the re-added root");

    // A symlinked folder canonicalizes onto the root it names.
    if (await canCreateSymlinks()) {
      const linkPath = path.join(base, "a-link");
      await symlink(rootA, linkPath);
      session.notify("workspace/didChangeWorkspaceFolders", {
        event: { added: [{ uri: uri(linkPath), name: "a-link" }], removed: [] }
      });
      const linked = await pollStatus(session, (roots) => roots.length === 2,
        "a symlinked folder created a third root");
      assert.equal(linked.length, 2,
        "a symlinked folder did not share its physical root");
    } else {
      console.log("multi-root: skipped the symlinked folder case " +
        "(this account cannot create symbolic links)");
    }

    // A nested folder narrows routing to itself without disturbing the outer
    // root that also contains it. An added folder activates on its first routed
    // message, so the query comes first.
    const nestedRoot = path.join(rootA, "inner");
    const nestedSource = await writeRoot(nestedRoot, ROOT_B_SOURCE);
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(nestedRoot), name: "inner" }], removed: [] }
    });
    await pollHover(session, nestedSource, ROOT_B_SOURCE, "tripled", /integer/,
      "the nested root");
    const nestedRoots = await pollStatus(session, (roots) => {
      const entry = findRoot(roots, nestedRoot);
      return entry?.state === "ready" && entry.origin === "folder"
        ? { accepted: roots }
        : { rejected: roots };
    }, "the nested folder did not activate");
    assert.equal(nestedRoots.length, 3,
      "the nested folder did not register exactly one root");
    await pollHover(session, sourceA, ROOT_A_SOURCE, "doubled", /integer/,
      "the outer root after a nested folder was added");
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testLazyDiscovery() {
  const base = await makeBase("discovery");
  const sessionRoot = path.join(base, "session");
  const inner = path.join(base, "slice", "inner");
  const deep = path.join(inner, "deep");
  const loose = path.join(base, "slice", "src");
  const plain = path.join(base, "plain");
  await mkdir(sessionRoot, { recursive: true });
  await mkdir(plain, { recursive: true });
  await mkdir(loose, { recursive: true });
  const innerSource = await writeRoot(inner, ROOT_A_SOURCE);
  const deepSource = await writeRoot(deep, ROOT_B_SOURCE);
  const looseSource = path.join(loose, "other.titan");
  await writeFile(looseSource, ROOT_A_SOURCE, "utf8");
  const plainSource = path.join(plain, "main.titan");
  await writeFile(plainSource, ROOT_A_SOURCE, "utf8");

  // An empty folder list selects nothing, so the deprecated single-root
  // parameters still decide the root before the launch directory does.
  const fallback = new Session(launch(sessionRoot, "error"));
  try {
    await fallback.initialize({ workspaceFolders: [], rootPath: plain });
    fallback.notify("initialized", {});
    const fallbackRoots = await pollStatus(fallback, (roots) =>
      roots.length === 1 && samePath(roots[0].root, plain) && roots[0].state === "ready",
      "an empty folder list did not fall back to rootPath");
    assert.equal(rootEntry(fallbackRoots, plain).origin, "folder");
    await fallback.shutdown();
  } finally {
    await fallback.abort();
  }

  const session = new Session(launch(sessionRoot, "error"));
  try {
    await session.initialize({});
    session.notify("initialized", {});
    await pollStatus(session, (roots) =>
      roots.length === 1 && samePath(roots[0].root, sessionRoot),
      "the launch directory did not become the initial root");

    // No client folder support: the first routed message discovers the nearest
    // configuration ancestor, even when that configuration is nested.
    session.notify("textDocument/didOpen", {
      textDocument: { uri: uri(deepSource), languageId: "titan", version: 1, text: ROOT_B_SOURCE }
    });
    await pollHover(session, deepSource, ROOT_B_SOURCE, "tripled", /integer/,
      "the deepest discovered root");
    const deepest = await pollStatus(session, (roots) => {
      const entry = findRoot(roots, deep);
      return entry?.origin === "discovered"
        ? { accepted: roots }
        : { rejected: roots };
    }, "the nested configuration was not discovered");

    session.notify("textDocument/didOpen", {
      textDocument: { uri: uri(innerSource), languageId: "titan", version: 1, text: ROOT_A_SOURCE }
    });
    await pollHover(session, innerSource, ROOT_A_SOURCE, "doubled", /integer/,
      "the enclosing discovered root");
    const nested = await pollStatus(session, (roots) => {
      const entry = findRoot(roots, inner);
      return entry?.origin === "discovered"
        ? { accepted: roots }
        : { rejected: roots };
    }, "the enclosing configuration was not discovered");
    assert.ok(serverPath(deep).startsWith(`${serverPath(inner)}/`),
      "the deeper discovered root is not inside the enclosing one");
    assert.equal(nested.filter((entry) => entry.origin === "discovered").length, 2,
      "discovery registered an unexpected number of roots");
    assert.equal(nested.some((entry) => samePath(entry.root, path.join(base, "slice"))), false,
      "discovery claimed a directory without its own configuration");

    // The deeper root still owns its own document.
    await pollHover(session, deepSource, ROOT_B_SOURCE, "tripled", /integer/,
      "the nested discovered root after the enclosing one");

    // A file with no configuration ancestor is unowned, not borrowed.
    const looseFailure = await session.failure("textDocument/hover", {
      textDocument: { uri: uri(looseSource) },
      position: positionOf(ROOT_A_SOURCE, "doubled")
    });
    assert.equal(looseFailure.code, -32803, JSON.stringify(looseFailure));
    assert.match(looseFailure.message, /outside every known Titan root/);
    const plainFailure = await session.failure("textDocument/hover", {
      textDocument: { uri: uri(plainSource) },
      position: positionOf(ROOT_A_SOURCE, "doubled")
    });
    assert.equal(plainFailure.code, -32803, JSON.stringify(plainFailure));
    assert.match(plainFailure.message, /titan-config\.lua/);
    assert.equal(deepest.length, 2);
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testSecondSdk() {
  const base = await makeBase("sdk");
  const sdk = path.join(base, "sdk");
  await farmSdk(sdkRoot(), sdk);
  const defaultRoot = path.join(base, "default");
  const sdkRootDir = path.join(base, "selected");
  const defaultSource = await writeRoot(defaultRoot, ROOT_A_SOURCE);
  const sdkSource = await writeRoot(sdkRootDir, SDK_SOURCE,
    `include = { "./src" }\nsource_module_roots = { "./src" }\ncompiler_root = "${sdk}"\n`);
  // A selected SDK reads interfaces from its archive; a broken dynamic
  // provider proves the server never prefers loading native code from it.
  const farmedProvider = path.join(sdk, "lib", "titan", "0.6", "titan.so");
  const farmedParent = await lstat(path.dirname(farmedProvider));
  assert.equal(farmedParent.isSymbolicLink(), false,
    "the SDK farm must not alias the session SDK");
  await assertFarmedFile(sdk, farmedProvider);
  await rm(farmedProvider, { force: true });
  await writeFile(farmedProvider, "not a loadable provider object\n", "utf8");
  const session = new Session(launch(defaultRoot, "error"));
  try {
    await session.initialize({
      workspaceFolders: [
        { uri: uri(defaultRoot), name: "default" },
        { uri: uri(sdkRootDir), name: "selected" }
      ],
      initializationOptions: { trustedRoots: [base] }
    });
    session.notify("initialized", {});
    const roots = await pollSettled(session, 2,
      "both roots did not start with a selected SDK");
    assertReady(roots, defaultRoot, "default SDK root");
    assertReady(roots, sdkRootDir, "selected SDK root");
    assert.equal(rootEntry(roots, defaultRoot).compilerRoot, null);
    assert.equal(rootEntry(roots, sdkRootDir).compilerRoot,
      serverPath(await realpath(sdk)),
      "the selected root did not report its compiler_root");
    assert.equal(rootEntry(roots, sdkRootDir).titanRoot,
      serverPath(await realpath(sdk)),
      "the selected worker did not run the selected SDK");
    assert.notEqual(rootEntry(roots, defaultRoot).workerPid,
      rootEntry(roots, sdkRootDir).workerPid,
      "the selected SDK shared an unselected worker");

    // The selected worker runs the second SDK's own compiler and archive.
    await pollHover(session, sdkSource, SDK_SOURCE, "tripled", /integer/,
      "the selected SDK root");
    await pollHover(session, defaultSource, ROOT_A_SOURCE, "doubled", /integer/,
      "the default SDK root");
    // `encoded` returns what `json.encode` declares, so its hover type proves
    // the standard library resolved from the selected SDK's own archive.
    await pollHover(session, sdkSource, SDK_SOURCE, "encoded", /string/,
      "the selected SDK standard library");
    assert.ok(await exists(path.join(sdkRootDir, ".titan-ls", "index.sqlite3")),
      "the selected root wrote no workspace cache below its own root");
    assert.equal(await exists(path.join(sdk, ".titan-ls")), false,
      "a worker wrote a cache inside the read-only SDK prefix");

    // A configuration reload that leaves the effective selection alone must
    // not restart anything.
    const generated = new Map(roots.map((entry) => [serverPath(entry.root), entry.generation]));
    const localOverride = path.join(sdkRootDir, "titan-config.local.lua");
    await writeFile(localOverride, `compiler_root = "${sdk}"\n`, "utf8");
    session.notify("workspace/didChangeConfiguration", { settings: {} });
    const unchanged = await session.status();
    assert.equal(rootEntry(unchanged, sdkRootDir).generation,
      generated.get(serverPath(sdkRootDir)), "an unchanged local override restarted a worker");
    assert.equal(rootEntry(unchanged, defaultRoot).generation,
      generated.get(serverPath(defaultRoot)), "an unrelated root restarted");

    // A local override that selects a different prefix restarts only its root.
    const secondSdk = path.join(base, "second-sdk");
    await farmSdk(sdkRoot(), secondSdk);
    const beforeSelection = rootEntry(await session.status(), sdkRootDir).generation;
    await writeFile(localOverride, `compiler_root = "${secondSdk}"\n`, "utf8");
    session.notify("workspace/didChangeConfiguration", { settings: {} });
    const reselected = await pollStatus(session, (entries) => {
      const entry = findRoot(entries, sdkRootDir);
      return samePath(entry?.compilerRoot, secondSdk) &&
        entry.generation > beforeSelection && entry.state === "ready"
        ? { accepted: entries }
        : { rejected: entries };
    }, "the local override did not restart the root with the second SDK");
    assert.equal(rootEntry(reselected, sdkRootDir).titanRoot,
      serverPath(secondSdk),
      "the restarted worker did not adopt the second SDK");
    assert.equal(rootEntry(reselected, defaultRoot).generation,
      generated.get(serverPath(defaultRoot)), "a per-root SDK change restarted an unrelated root");
    // The tracked configuration is untouched: only the local override moved.
    const trackedConfig = await readFile(
      path.join(sdkRootDir, "titan-config.lua"), "utf8");
    assert.ok(trackedConfig.includes(`compiler_root = "${sdk}"`),
      "the local override rewrote the tracked configuration");
    await pollHover(session, sdkSource, SDK_SOURCE, "tripled", /integer/,
      "the root with the second SDK");

    // Reinstalling the selected SDK changes its identity, so the router stops
    // and restarts that root's worker on its own and no other root's worker.
    const archive = path.join(secondSdk, "lib", "titan", "0.6", "sdk-digests");
    await assertFarmedFile(secondSdk, archive);
    const beforeReinstall = rootEntry(await session.status(), sdkRootDir).generation;
    await replaceWithCopy(archive);
    await writeFile(archive, "reinstalled digests\n", "utf8");
    const restarted = await pollStatus(session, (entries) => {
      const entry = findRoot(entries, sdkRootDir);
      return entry !== undefined && entry.generation > beforeReinstall &&
        entry.state === "ready" && entry.workerPid !== null
        ? { accepted: entries }
        : { rejected: entries };
    }, "the reinstalled SDK did not restart its worker");
    assert.equal(rootEntry(restarted, defaultRoot).generation,
      generated.get(serverPath(defaultRoot)),
      "an SDK reinstall restarted an unrelated root");
    await pollHover(session, sdkSource, SDK_SOURCE, "tripled", /integer/,
      "the root after the SDK reinstall");

    // A local override exists only to select an SDK, so a broken one refuses an
    // already-ready root instead of quietly serving the router's own SDK.
    await writeFile(localOverride,
      `compiler_root = "${secondSdk}"\ninclude = { "./src" }\n`, "utf8");
    session.notify("workspace/didChangeConfiguration", { settings: {} });
    const broken = await pollStatus(session, (entries) => {
      const entry = findRoot(entries, sdkRootDir);
      return entry?.state === "failed" && entry.workerPid === null
        ? { accepted: entries }
        : { rejected: entries };
    }, "the broken local override did not refuse its root");
    const brokenEntry = rootEntry(broken, sdkRootDir);
    assert.match(brokenEntry.failure ?? "", /titan-config\.local\.lua/,
      "the refusal did not name the local override");
    assert.equal(brokenEntry.compilerRoot, null,
      "a refused root kept a selected SDK");
    assert.equal(brokenEntry.trusted, true,
      "a configuration refusal forgot that the root is trusted");
    assert.equal(rootEntry(broken, defaultRoot).state, "ready",
      "a broken override disturbed an unrelated root");
    const refusedHover = await session.failure("textDocument/hover", {
      textDocument: { uri: uri(sdkSource) },
      position: positionOf(SDK_SOURCE, "tripled")
    });
    assert.equal(refusedHover.code, -32803, JSON.stringify(refusedHover));
    assert.match(refusedHover.message, /titan-config\.local\.lua/);

    // Removing the broken override restores the tracked selection.
    await rm(localOverride, { force: true });
    session.notify("workspace/didChangeConfiguration", { settings: {} });
    const recovered = await pollStatus(session, (entries) => {
      const entry = findRoot(entries, sdkRootDir);
      return entry?.state === "ready" &&
        entry.compilerRoot === path.normalize(sdk)
        ? { accepted: entries }
        : { rejected: entries };
    }, "the root did not recover after the broken override was removed");
    assert.ok(recovered);
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testRootScopedSdkErrors() {
  const base = await makeBase("sdk-errors");
  const marker = path.join(base, "driver-loaded");
  const incompatible = path.join(base, "incompatible");
  await farmSdk(sdkRoot(), incompatible);
  const driver = path.join(incompatible, "share/lua/5.5/titan-compiler/driver.lua");
  await assertFarmedFile(incompatible, driver);
  await replaceWithCopy(driver);
  const source = await readFile(driver, "utf8");
  await writeFile(driver,
    source.replace(/LANGUAGE_SERVER_API_VERSION\s*=\s*1/,
      "LANGUAGE_SERVER_API_VERSION = 2"), "utf8");

  const untrusted = path.join(base, "untrusted");
  await farmSdk(sdkRoot(), untrusted);
  const untrustedDriver = path.join(untrusted, "share/lua/5.5/titan-compiler/driver.lua");
  await assertFarmedFile(untrusted, untrustedDriver);
  await replaceWithCopy(untrustedDriver);
  await writeFile(untrustedDriver, [
    `local handle = io.open(${JSON.stringify(marker)}, "w")`,
    "if handle then handle:write(\"loaded\\n\"); handle:close() end",
    "return { LANGUAGE_SERVER_API_VERSION = 1 }",
    ""
  ].join("\n"), "utf8");

  // A driver that agrees on the language-server API but not on the compiler
  // ABI must fail its own root just as clearly.
  const incompatibleAbi = path.join(base, "incompatible-abi");
  await farmSdk(sdkRoot(), incompatibleAbi);
  const abiDriver = path.join(incompatibleAbi,
    "share/lua/5.5/titan-compiler/driver.lua");
  await assertFarmedFile(incompatibleAbi, abiDriver);
  await replaceWithCopy(abiDriver);
  const abiSource = await readFile(abiDriver, "utf8");
  assert.match(abiSource, /driver\.TITAN_ABI_VERSION = version\.TITAN_ABI_VERSION/,
    "the farmed driver no longer declares its ABI version");
  await writeFile(abiDriver, abiSource.replace(
    "driver.TITAN_ABI_VERSION = version.TITAN_ABI_VERSION",
    'driver.TITAN_ABI_VERSION = "3"'), "utf8");

  const incompatibleRoot = path.join(base, "incompatible-root");
  const abiRoot = path.join(base, "abi-root");
  const missingRoot = path.join(base, "missing-root");
  const untrustedRoot = path.join(base, "untrusted-root");
  const brokenOverrideRoot = path.join(base, "broken-override-root");
  const incompatibleSource = await writeRoot(incompatibleRoot, ROOT_A_SOURCE,
    `include = { "./src" }\nsource_module_roots = { "./src" }\ncompiler_root = "${incompatible}"\n`);
  const abiRootSource = await writeRoot(abiRoot, ROOT_A_SOURCE,
    `include = { "./src" }\nsource_module_roots = { "./src" }\ncompiler_root = "${incompatibleAbi}"\n`);
  const missingSource = await writeRoot(missingRoot, ROOT_A_SOURCE,
    `include = { "./src" }\nsource_module_roots = { "./src" }\ncompiler_root = "${path.join(base, "absent-sdk")}"\n`);
  const untrustedSource = await writeRoot(untrustedRoot, ROOT_A_SOURCE,
    `include = { "./src" }\nsource_module_roots = { "./src" }\ncompiler_root = "${untrusted}"\n`);
  // An untrusted root whose override cannot even be read must still never load
  // the SDK: there is no selection to trust and none to fall back to.
  const brokenOverrideSource = await writeRoot(brokenOverrideRoot, ROOT_A_SOURCE,
    `include = { "./src" }\nsource_module_roots = { "./src" }\ncompiler_root = "${untrusted}"\n`);
  await writeFile(path.join(brokenOverrideRoot, "titan-config.local.lua"),
    `compiler_root = "${untrusted}"\ninclude = { "./src" }\n`, "utf8");

  const session = new Session(launch(incompatibleRoot, "error"));
  try {
    await session.initialize({
      workspaceFolders: [
        { uri: uri(incompatibleRoot), name: "incompatible" },
        { uri: uri(abiRoot), name: "abi" },
        { uri: uri(missingRoot), name: "missing" },
        { uri: uri(untrustedRoot), name: "untrusted" },
        { uri: uri(brokenOverrideRoot), name: "broken-override" }
      ],
      // Only the incompatible, ABI and missing roots are trusted.
      initializationOptions: { trustedRoots: [incompatibleRoot, abiRoot, missingRoot] }
    });
    session.notify("initialized", {});

    const roots = await pollStatus(session, (entries) =>
      entries.length === 5 && entries.every((entry) => entry.state !== "starting"),
      "root-scoped failures did not settle");
    assert.equal(roots.length, 5);
    const brokenOverrideEntry = rootEntry(roots, brokenOverrideRoot);
    assert.equal(brokenOverrideEntry.state, "failed");
    assert.match(brokenOverrideEntry.failure ?? "", /titan-config\.local\.lua/,
      "an unreadable override on an untrusted root did not name the file");
    assert.equal(brokenOverrideEntry.workerPid, null,
      "an untrusted root with an unreadable override started a worker");
    const incompatibleEntry = rootEntry(roots, incompatibleRoot);
    assert.equal(incompatibleEntry.compilerRoot,
      serverPath(await realpath(incompatible)));
    const untrustedEntry = rootEntry(roots, untrustedRoot);
    assert.equal(untrustedEntry.compilerRoot, null,
      "an untrusted root still reported a selected SDK");
    assert.match(untrustedEntry.failure ?? "", /trustedRoots/,
      "the untrusted failure did not name the trust option");
    const untrustedConfig = path.join(untrustedRoot, "titan-config.lua");
    await poll("the trust refusal diagnostic", async () => {
      const found = session.responses.diagnosticPublications.filter(
        (publication) => publication.uri === uri(untrustedConfig) &&
          publication.diagnostics.some((diagnostic) =>
            diagnostic.code === "configuration"));
      return found.length > 0
        ? { accepted: found }
        : { rejected: found };
    });
    assert.equal(await exists(marker), false,
      "an untrusted compiler_root loaded its driver");
    const missingEntry = rootEntry(roots, missingRoot);
    assert.equal(missingEntry.state, "failed");
    assert.match(missingEntry.failure ?? "", /absent-sdk/,
      "the missing SDK failure did not name the prefix");

    const untrustedFailure = await session.failure("textDocument/hover", {
      textDocument: { uri: uri(untrustedSource) },
      position: positionOf(ROOT_A_SOURCE, "doubled")
    });
    assert.equal(untrustedFailure.code, -32803);
    assert.match(untrustedFailure.message, /trustedRoots/);
    assert.equal(await exists(marker), false,
      "a request through an untrusted root loaded its driver");

    const missingFailure = await session.failure("textDocument/hover", {
      textDocument: { uri: uri(missingSource) },
      position: positionOf(ROOT_A_SOURCE, "doubled")
    });
    assert.equal(missingFailure.code, -32803);
    assert.match(missingFailure.message, /absent-sdk/);

    // A selected SDK loads in the worker, so its incompatibility surfaces
    // after that worker's first indexing attempt.
    const incompatibleFailure = await pollFailure(session, "textDocument/hover", {
      textDocument: { uri: uri(incompatibleSource) },
      position: positionOf(ROOT_A_SOURCE, "doubled")
    }, "the incompatible selected SDK");
    assert.equal(incompatibleFailure.code, -32803);
    assert.match(
      incompatibleFailure.message,
      /language-server API|LANGUAGE_SERVER_API_VERSION/,
      incompatibleFailure.message
    );
    const abiFailure = await pollFailure(session, "textDocument/hover", {
      textDocument: { uri: uri(abiRootSource) },
      position: positionOf(ROOT_A_SOURCE, "doubled")
    }, "the incompatible compiler ABI");
    assert.equal(abiFailure.code, -32803);
    assert.match(abiFailure.message, /compiler ABI|TITAN_ABI_VERSION/,
      abiFailure.message);
    const brokenOverrideFailure = await session.failure("textDocument/hover", {
      textDocument: { uri: uri(brokenOverrideSource) },
      position: positionOf(ROOT_A_SOURCE, "doubled")
    });
    assert.equal(brokenOverrideFailure.code, -32803);
    assert.match(brokenOverrideFailure.message, /titan-config\.local\.lua/);
    assert.equal(await exists(marker), false,
      "an unreadable override on an untrusted root loaded its driver");
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testWorkerCrashAndOverlay() {
  const base = await makeBase("crash");
  const root = path.join(base, "slice");
  const saved = await writeRoot(root, ROOT_A_SOURCE);
  const unsavedPath = path.join(root, "src", "draft.titan");
  const overlay = [
    "function overlay_marker(): integer",
    "  return 1",
    "end",
    "function use_overlay(): integer",
    "  return overlay_",
    "end",
    ""
  ].join("\n");
  const session = new Session(launch(root, "error"));
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(root), name: "slice" }],
      initializationOptions: { trustedRoots: [root] }
    });
    session.notify("initialized", {});
    const started = await pollStatus(session, (roots) =>
      roots.length === 1 && roots[0].state === "ready" && roots[0].workerPid !== null,
      "the root did not start");
    assertReady(started, root, "crash fixture root");
    await pollHover(session, saved, ROOT_A_SOURCE, "doubled", /integer/, "saved root");

    session.notify("textDocument/didOpen", {
      textDocument: { uri: uri(unsavedPath), languageId: "titan", version: 1, text: overlay }
    });
    const position = endOfToken(overlay, "overlay_", 1);
    const before = await pollCompletion(session, unsavedPath, position, "overlay before the crash");
    assert.ok(before.some((item) => item.label === "overlay_marker"),
      "the unsaved document did not offer its own local");

    process.kill(started[0].workerPid, "SIGKILL");
    const crashed = await pollStatus(session, (roots) =>
      roots[0].workerPid === null && roots[0].state === "failed",
      "the crashed worker was not observed");
    assert.match(crashed[0].failure ?? "", /exited/);

    const after = await pollCompletion(session, unsavedPath, position, "overlay after the crash");
    assert.ok(after.some((item) => item.label === "overlay_marker"),
      "the respawned worker lost the unsaved overlay");
    const recovered = await pollStatus(session, (roots) =>
      roots[0].state === "ready" && roots[0].workerPid !== null,
      "the crashed root did not respawn");
    assert.equal(recovered[0].generation, 2,
      "the respawned worker did not advance its generation");

    // Crash accounting: one exit counts once, and a root that keeps dying stops
    // being restarted until its settings change. The second crash is still
    // within the limit, which a double-counted first crash would break.
    let current = rootEntry(recovered, root);
    process.kill(current.workerPid, "SIGKILL");
    const second = await pollStatus(session, (roots) =>
      roots[0].workerPid === null && roots[0].state === "failed",
      "the second crash was not observed");
    assert.match(second[0].failure ?? "", /exited/);
    await pollHover(session, saved, ROOT_A_SOURCE, "doubled", /integer/,
      "the root after the second crash");
    current = rootEntry(await session.status(), root);
    assert.equal(typeof current.workerPid, "number",
      "the second crash did not restart the worker");
    process.kill(current.workerPid, "SIGKILL");
    await pollStatus(session, (roots) =>
      roots[0].workerPid === null && roots[0].state === "failed",
      "the third crash was not observed");
    const suppressed = await session.failure("textDocument/hover", {
      textDocument: { uri: uri(saved) },
      position: positionOf(ROOT_A_SOURCE, "doubled")
    });
    assert.equal(suppressed.code, -32803, JSON.stringify(suppressed));
    assert.match(suppressed.message, /restart suppressed/,
      `a crash loop was restarted anyway: ${suppressed.message}`);
    // An explicit reload is the documented recovery.
    session.notify("workspace/didChangeConfiguration", { settings: {} });
    await pollHover(session, saved, ROOT_A_SOURCE, "doubled", /integer/,
      "the root after an explicit reload cleared the crash loop");
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testCapAndIdleEviction() {
  const base = await makeBase("lifecycle");
  const first = path.join(base, "first");
  const second = path.join(base, "second");
  const firstSource = await writeRoot(first, ROOT_A_SOURCE);
  const secondSource = await writeRoot(second, ROOT_B_SOURCE);
  const session = new Session(launch(first, "error"));
  try {
    await session.initialize({
      workspaceFolders: [
        { uri: uri(first), name: "first" },
        { uri: uri(second), name: "second" }
      ],
      initializationOptions: {
        trustedRoots: [base],
        maxWorkers: 1,
        // A fractional timeout keeps the eviction observable in this test.
        idleTimeoutSeconds: 0.5
      }
    });
    session.notify("initialized", {});
    await pollStatus(session, (roots) =>
      roots.filter((entry) => entry.state === "ready").length <= 1,
      "the worker cap was exceeded at activation");

    // An open document keeps its root non-idle, so the second root cannot take
    // the only worker slot.
    session.notify("textDocument/didOpen", {
      textDocument: { uri: uri(firstSource), languageId: "titan", version: 1, text: ROOT_A_SOURCE }
    });
    await pollHover(session, firstSource, ROOT_A_SOURCE, "doubled", /integer/,
      "the capped root");
    const capped = await session.failure("textDocument/hover", {
      textDocument: { uri: uri(secondSource) },
      position: positionOf(ROOT_B_SOURCE, "tripled")
    });
    assert.equal(capped.code, -32803);
    assert.match(capped.message, /cap/i, capped.message);

    // Closing the document makes the root idle; the second root may then take
    // the slot and the first root's worker is evicted.
    session.notify("textDocument/didClose", {
      textDocument: { uri: uri(firstSource) }
    });
    const taken = await pollStatus(session, (roots) =>
      roots.some((entry) => samePath(entry.root, first) && entry.state === "evicted"),
      "the idle worker was not evicted for the new root");
    assert.ok(taken.length > 0);
    await pollHover(session, secondSource, ROOT_B_SOURCE, "tripled", /integer/,
      "the root that reused the slot");

    // Idle eviction also releases a worker no client message refers to.
    session.notify("textDocument/didClose", {
      textDocument: { uri: uri(secondSource) }
    });
    await pollStatus(session, (roots) =>
      roots.every((entry) => entry.state !== "ready"),
      "idle eviction kept a worker alive past its timeout");
    const reactivated = await pollHover(session, secondSource, ROOT_B_SOURCE,
      "tripled", /integer/, "the reactivated root");
    assert.ok(reactivated);
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testCancellation() {
  const base = await makeBase("cancel");
  const root = path.join(base, "slice");
  const source = await writeRoot(root, ROOT_A_SOURCE);
  const session = new Session(launch(root, "error"));
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(root), name: "slice" }],
      initializationOptions: { trustedRoots: [root] }
    });
    session.notify("initialized", {});
    await pollStatus(session, (roots) =>
      roots.length === 1 && roots[0].state === "ready",
      "the root did not start");
    await pollHover(session, source, ROOT_A_SOURCE, "doubled", /integer/,
      "the cancellable root");

    // The router forwards $/cancelRequest to the worker that owns the request
    // id. Whether the request wins or the cancellation does, it must settle and
    // leave the root answering.
    const id = session.nextId;
    const pending = session.send("textDocument/references", {
      textDocument: { uri: uri(source) },
      position: positionOf(ROOT_A_SOURCE, "doubled", 1),
      context: { includeDeclaration: true }
    });
    session.notify("$/cancelRequest", { id });
    const cancelled = await pending;
    assert.ok(cancelled.result !== undefined || cancelled.error?.code === -32800,
      `a cancelled request produced neither a result nor a cancellation: ${
        JSON.stringify(cancelled)}`);
    await pollHover(session, source, ROOT_A_SOURCE, "doubled", /integer/,
      "the root after a cancelled request");
    const healthy = rootEntry(await session.status(), root);
    assert.equal(healthy.state, "ready",
      "a cancelled request disturbed its root");
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

const OVERLAY_SOURCE = [
  "function overlay_marker(): integer",
  "  return 1",
  "end",
  "function use_overlay(): integer",
  "  return overlay_",
  "end",
  ""
].join("\n");

// Buffers belong to the root that owns the document, not to every root whose
// directory happens to contain the path.
async function testOverlayOwnership() {
  const base = await makeBase("overlays");
  const rootA = path.join(base, "a");
  const rootB = path.join(base, "b");
  const sourceA = await writeRoot(rootA, ROOT_A_SOURCE);
  const sourceB = await writeRoot(rootB, ROOT_B_SOURCE);
  const linkPath = path.join(base, "a-link");
  await symlink(rootA, linkPath);
  // The client spells a document through the symlinked folder.
  const linkedDraft = path.join(linkPath, "src", "draft.titan");
  // A buffer inside the physical tree is what a worker can analyse.
  const canonicalDraft = path.join(rootA, "src", "canonical-draft.titan");
  const overlayPosition = endOfToken(OVERLAY_SOURCE, "overlay_", 1);

  const session = new Session(launch(rootA, "error"));
  try {
    await session.initialize({
      workspaceFolders: [
        { uri: uri(linkPath), name: "a" },
        { uri: uri(rootB), name: "b" }
      ],
      initializationOptions: { trustedRoots: [base], maxWorkers: 1 }
    });
    session.notify("initialized", {});
    const first = await pollStatus(session, (roots) =>
      roots.length === 2 && roots.some((entry) =>
        samePath(entry.root, rootA) && entry.state === "ready"),
      "the symlinked folder did not activate its physical root");
    assert.equal(rootEntry(first, rootA).origin, "folder");
    assert.equal(rootEntry(first, rootB).workerPid, null,
      "the worker cap started both roots");

    // A buffer spelled through the symlink still belongs to the physical root,
    // so that root is not idle and the only worker slot stays taken.
    session.notify("textDocument/didOpen", {
      textDocument: {
        uri: uri(linkedDraft), languageId: "titan", version: 1,
        text: OVERLAY_SOURCE
      }
    });
    const capped = await session.failure("textDocument/hover", {
      textDocument: { uri: uri(sourceB) },
      position: positionOf(ROOT_B_SOURCE, "tripled")
    });
    assert.equal(capped.code, -32803, JSON.stringify(capped));
    assert.match(capped.message, /cap/i,
      `a symlink-spelled open buffer did not keep its root busy: ${capped.message}`);

    // Closing it releases the slot, so the other root may now start.
    session.notify("textDocument/didClose", {
      textDocument: { uri: uri(linkedDraft) }
    });
    await pollHover(session, sourceB, ROOT_B_SOURCE, "tripled", /integer/,
      "the root that reused the released slot");
    await pollStatus(session, (roots) =>
      roots.some((entry) => samePath(entry.root, rootA) && entry.workerPid === null),
      "closing the symlink-spelled buffer did not release the root");
    await pollHover(session, sourceA, ROOT_A_SOURCE, "doubled", /integer/,
      "the root that gave up its slot");

    // An unsaved buffer inside the physical root survives a crash: the router
    // replays it into the replacement worker.
    session.notify("textDocument/didOpen", {
      textDocument: {
        uri: uri(canonicalDraft), languageId: "titan", version: 1,
        text: OVERLAY_SOURCE
      }
    });
    const before = await pollCompletion(session, canonicalDraft, overlayPosition,
      "the unsaved buffer in the symlinked root");
    assert.ok(before.some((item) => item.label === "overlay_marker"),
      "the unsaved document offered no overlay symbol");
    const running = rootEntry(await session.status(), rootA);
    assert.equal(typeof running.workerPid, "number",
      "the symlinked root had no worker to crash");
    process.kill(running.workerPid, "SIGKILL");
    await pollStatus(session, (roots) =>
      rootEntry(roots, rootA).workerPid === null,
      "the symlinked worker's exit was not observed");
    const after = await pollCompletion(session, canonicalDraft, overlayPosition,
      "the replayed unsaved buffer");
    assert.ok(after.some((item) => item.label === "overlay_marker"),
      "the respawned worker lost the unsaved buffer");
    await session.shutdown();
  } finally {
    await session.abort();
  }

  // A nested root's open document belongs to the nested root alone.
  const outer = path.join(base, "outer");
  const inner = path.join(outer, "inner");
  const outerSource = await writeRoot(outer, ROOT_A_SOURCE);
  const innerSource = await writeRoot(inner, ROOT_B_SOURCE);
  const nestedSession = new Session(launch(outer, "error"));
  try {
    await nestedSession.initialize({
      workspaceFolders: [
        { uri: uri(outer), name: "outer" },
        { uri: uri(inner), name: "inner" }
      ],
      initializationOptions: { trustedRoots: [base], maxWorkers: 1 }
    });
    nestedSession.notify("initialized", {});
    await pollStatus(nestedSession, (roots) =>
      rootEntry(roots, outer).state === "ready",
      "the outer root did not activate");
    nestedSession.notify("textDocument/didOpen", {
      textDocument: {
        uri: uri(innerSource), languageId: "titan", version: 1,
        text: ROOT_B_SOURCE
      }
    });
    await pollHover(nestedSession, innerSource, ROOT_B_SOURCE, "tripled", /integer/,
      "the nested root with an open document");
    const nested = await pollStatus(nestedSession, (entries) => {
      const innerEntry = rootEntry(entries, inner);
      const outerEntry = rootEntry(entries, outer);
      return innerEntry.state === "ready" && outerEntry.workerPid === null
        ? { accepted: entries }
        : { rejected: entries };
    }, "the nested root's buffer pinned the outer root");
    assert.equal(rootEntry(nested, outer).state, "evicted");
    // The nested root's open document pins it, so the outer root stays out.
    const nestedCap = await nestedSession.failure("textDocument/hover", {
      textDocument: { uri: uri(outerSource) },
      position: positionOf(ROOT_A_SOURCE, "doubled")
    });
    assert.equal(nestedCap.code, -32803, JSON.stringify(nestedCap));
    assert.match(nestedCap.message, /cap/i, nestedCap.message);
    // Closing it releases the slot for the outer root.
    nestedSession.notify("textDocument/didClose", {
      textDocument: { uri: uri(innerSource) }
    });
    await pollHover(nestedSession, outerSource, ROOT_A_SOURCE, "doubled",
      /integer/, "the outer root after the nested buffer closed");
    await pollStatus(nestedSession, (entries) =>
      rootEntry(entries, inner).workerPid === null,
      "closing the nested buffer did not release its worker");
    await nestedSession.shutdown();
  } finally {
    await nestedSession.abort();
  }
}

// A folder root is not a Titan project just because it is a folder: the owner
// of a document is the most specific of the known roots and its nearest
// ancestor titan-config.lua.
async function testNestedProjects() {
  const base = await makeBase("nested");
  const sessionRoot = path.join(base, "session");
  const configlessRoot = path.join(base, "home");
  const projectRoot = path.join(configlessRoot, "project");
  const sessionSource = await writeRoot(sessionRoot, ROOT_A_SOURCE);
  const projectSource = await writeRoot(projectRoot, ROOT_B_SOURCE);
  await mkdir(path.join(configlessRoot, "notes"), { recursive: true });

  const session = new Session(launch(sessionRoot, "error"));
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(sessionRoot), name: "session" }],
      initializationOptions: { trustedRoots: [base] }
    });
    session.notify("initialized", {});
    await pollStatus(session, (roots) =>
      rootEntry(roots, sessionRoot).state === "ready",
      "the session root did not start");

    // omp adds the checkout root it inferred from a stray marker directory; it
    // is not a Titan project.
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(configlessRoot), name: "home" }], removed: [] }
    });
    const added = await pollStatus(session, (roots) =>
      roots.length === 2 && roots.some((entry) => samePath(entry.root, configlessRoot)),
      "the added folder root was not registered");
    assert.equal(rootEntry(added, configlessRoot).workerPid, null,
      "an added folder with no configuration started a worker before a document");
    assert.equal(rootEntry(added, configlessRoot).state, "inactive");

    // A configured project below it answers for its own documents.
    await pollHover(session, projectSource, ROOT_B_SOURCE, "tripled", /integer/,
      "the nested configured project");
    const nested = await pollStatus(session, (entries) => {
      const entry = findRoot(entries, projectRoot);
      return entry?.origin === "discovered" && entry.state === "ready"
        ? { accepted: entries }
        : { rejected: entries };
    }, "the nested configuration did not become its own root");
    assert.equal(rootEntry(nested, configlessRoot).workerPid, null,
      "the folder root without configuration served its nested project");
    await pollHover(session, sessionSource, ROOT_A_SOURCE, "doubled", /integer/,
      "the unrelated session root");
    await session.shutdown();
  } finally {
    await session.abort();
  }

  // The same rule holds when the outer folder root does have its own project.
  const outerRoot = path.join(base, "outer");
  const innerRoot = path.join(outerRoot, "inner");
  const outerSource = await writeRoot(outerRoot, ROOT_A_SOURCE);
  const innerSource = await writeRoot(innerRoot, ROOT_B_SOURCE);
  const nestedSession = new Session(launch(outerRoot, "error"));
  try {
    await nestedSession.initialize({
      workspaceFolders: [{ uri: uri(outerRoot), name: "outer" }],
      initializationOptions: { trustedRoots: [base] }
    });
    nestedSession.notify("initialized", {});
    await pollStatus(nestedSession, (roots) =>
      rootEntry(roots, outerRoot).state === "ready",
      "the outer root did not start");
    await pollHover(nestedSession, outerSource, ROOT_A_SOURCE, "doubled",
      /integer/, "the outer root");
    await pollHover(nestedSession, innerSource, ROOT_B_SOURCE, "tripled",
      /integer/, "the nested project inside a configured folder root");
    const nested = await pollStatus(nestedSession, (entries) => {
      const entry = findRoot(entries, innerRoot);
      return entry?.origin === "discovered" && entry.state === "ready"
        ? { accepted: entries }
        : { rejected: entries };
    }, "the nested project was not its own root");
    assert.equal(rootEntry(nested, outerRoot).origin, "folder");
    // The outer root keeps serving its own tree.
    await pollHover(nestedSession, outerSource, ROOT_A_SOURCE, "doubled",
      /integer/, "the outer root after its nested project became a root");
    await nestedSession.shutdown();
  } finally {
    await nestedSession.abort();
  }
}

// Removal releases a root instead of stopping it: a client that adds a sibling
// checkout for one call and removes it afterwards must not pay a restart and a
// fresh index on every call.
async function testReleasedRoots() {
  const base = await makeBase("released");
  const rootA = path.join(base, "a");
  const rootB = path.join(base, "b");
  const sourceA = await writeRoot(rootA, ROOT_A_SOURCE);
  const sourceB = await writeRoot(rootB, ROOT_B_SOURCE);
  const session = new Session(launch(rootA, "error"));
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(rootA), name: "a" }],
      initializationOptions: { trustedRoots: [base], idleTimeoutSeconds: 1 }
    });
    session.notify("initialized", {});
    await pollStatus(session, (roots) =>
      rootEntry(roots, rootA).state === "ready",
      "the first root did not start");
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(rootB), name: "b" }], removed: [] }
    });
    await pollHover(session, sourceB, ROOT_B_SOURCE, "tripled", /integer/,
      "the sibling root");
    const served = rootEntry(await session.status(), rootB);
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [{ uri: uri(rootB), name: "b" }] }
    });
    await pollStatus(session, (roots) => {
      const entry = findRoot(roots, rootB);
      return entry?.origin === "released" ? { accepted: roots } : { rejected: roots };
    }, "the removed folder did not release its root");

    // Idle eviction is what stops a released root, and the registry drops it
    // once no worker, folder or discovered configuration keeps it alive.
    await pollStatus(session, (roots) =>
      roots.every((entry) => !samePath(entry.root, rootB)),
      "idle eviction kept a released root");
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(rootB), name: "b" }], removed: [] }
    });
    await pollHover(session, sourceB, ROOT_B_SOURCE, "tripled", /integer/,
      "the re-added root after eviction");
    const restarted = rootEntry(await session.status(), rootB);
    // The released root's slot was dropped with its worker, so re-adding it
    // starts a fresh worker (and a fresh generation).
    assert.notEqual(restarted.workerPid, served.workerPid,
      "an evicted released root came back with its old worker pid");
    assert.equal(restarted.generation, 1,
      "an evicted released root kept its old generation");
    await pollHover(session, sourceA, ROOT_A_SOURCE, "doubled", /integer/,
      "the unrelated root");
    await session.shutdown();
  } finally {
    await session.abort();
  }

  // A released root with no configuration of its own owns nothing: it is a
  // known, reported root with a warm worker, not an owner.
  const plainBase = await makeBase("released-unowned");
  const sessionRoot = path.join(plainBase, "session");
  const plainRoot = path.join(plainBase, "plain");
  const sessionSource = await writeRoot(sessionRoot, ROOT_A_SOURCE);
  await mkdir(plainRoot, { recursive: true });
  const plainFile = path.join(plainRoot, "note.titan");
  await writeFile(plainFile, ROOT_B_SOURCE, "utf8");
  const plainSession = new Session(launch(sessionRoot, "error"));
  try {
    await plainSession.initialize({
      workspaceFolders: [{ uri: uri(sessionRoot), name: "session" }],
      initializationOptions: { trustedRoots: [plainBase] }
    });
    plainSession.notify("initialized", {});
    await pollStatus(plainSession, (roots) =>
      rootEntry(roots, sessionRoot).state === "ready",
      "the session root did not start");
    plainSession.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(plainRoot), name: "plain" }], removed: [] }
    });
    await pollStatus(plainSession, (roots) => {
      const entry = findRoot(roots, plainRoot);
      return entry !== undefined && entry.workerPid === null
        ? { accepted: roots } : { rejected: roots };
    }, "the added config-less folder started a worker");
    plainSession.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [{ uri: uri(plainRoot), name: "plain" }] }
    });
    const released = await pollStatus(plainSession, (roots) => {
      const entry = findRoot(roots, plainRoot);
      return entry?.origin === "released"
        ? { accepted: roots } : { rejected: roots };
    }, "the config-less folder was not released");
    assert.equal(rootEntry(released, plainRoot).workerPid, null,
      "a released root without a worker reported one");
    const unowned = await plainSession.failure("textDocument/hover", {
      textDocument: { uri: uri(plainFile) },
      position: positionOf(ROOT_B_SOURCE, "tripled")
    });
    assert.equal(unowned.code, -32803, JSON.stringify(unowned));
    assert.match(unowned.message, /outside every known Titan root|titan-config\.lua/,
      `a released root without configuration claimed a document: ${unowned.message}`);
    await pollHover(plainSession, sessionSource, ROOT_A_SOURCE, "doubled",
      /integer/, "the surviving session root");
    await plainSession.shutdown();
  } finally {
    await plainSession.abort();
  }
}

// Ownership of an open document can move between roots. Its buffer and its
// diagnostics must move with it: one reconciliation step does both.
async function testOwnershipMigration() {
  const base = await makeBase("migrate");
  const outerRoot = path.join(base, "outer");
  const innerRoot = path.join(outerRoot, "inner");
  // The outer project maps the nested directory; the nested folder itself is a
  // config-less folder root, so removing it hands its document back to outer.
  await mkdir(innerRoot, { recursive: true });
  await writeFile(path.join(outerRoot, "titan-config.lua"),
    'include = { "." }\nsource_module_roots = { ".", "./inner" }\n', "utf8");
  const outerSource = path.join(outerRoot, "main.titan");
  const outerText = "function outer_symbol(): integer\n  return 1\nend\n";
  await writeFile(outerSource, outerText, "utf8");
  await mkdir(path.join(innerRoot, "src"), { recursive: true });
  const savedInner = "function saved_symbol(): integer\n  return 1\nend\n" +
    "function use_saved(): integer\n  return saved_\nend\n";
  await writeFile(path.join(innerRoot, "src", "m.titan"), savedInner, "utf8");
  const innerSource = path.join(innerRoot, "src", "m.titan");
  const overlay = "function saved_symbol(): integer\n  return 1\nend\n" +
    "function overlay_marker(): integer\n  return 2\nend\n" +
    "function use_overlay(): integer\n  return overlay_\nend\n";
  const overlayPosition = endOfToken(overlay, "overlay_", 1);

  const session = new Session(launch(outerRoot, "error"));
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(outerRoot), name: "outer" }],
      initializationOptions: { trustedRoots: [base] }
    });
    session.notify("initialized", {});
    await pollStatus(session, (roots) =>
      rootEntry(roots, outerRoot).state === "ready",
      "the outer root did not start");
    const publications = session.responses.diagnosticPublications;
    const reportsInner = (nonEmpty) => (publication) =>
      publication.uri === uri(innerSource) &&
        (publication.diagnostics.length > 0) === nonEmpty;
    await waitNotification(session, publications, 0, reportsInner(true),
      "the enclosing root's saved diagnostic for the nested document");
    const originalOuter = rootEntry(await session.status(), outerRoot);
    const addedAt = publications.length;

    // The nested folder is its own root while it is a folder.
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(innerRoot), name: "inner" }], removed: [] }
    });
    await waitNotification(session, publications, addedAt, reportsInner(false),
      "clearing the enclosing root's diagnostics after nested-folder ownership");
    session.notify("textDocument/didOpen", {
      textDocument: {
        uri: uri(innerSource), languageId: "titan", version: 1, text: overlay
      }
    });
    const inInner = await pollCompletion(session, innerSource, overlayPosition,
      "the unsaved buffer in the nested folder");
    assert.ok(inInner.some((item) => item.label === "overlay_marker"),
      "the nested folder did not see its own unsaved buffer");
    await waitNotification(session, publications, addedAt, reportsInner(true),
      "the nested root's saved diagnostic");
    const releasedAt = publications.length;

    // Removing the folder moves the document to the enclosing root, whose
    // already-running worker must receive the buffer.
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [{ uri: uri(innerRoot), name: "inner" }] }
    });
    await waitNotification(session, publications, releasedAt, reportsInner(false),
      "clearing the released nested root's diagnostics");
    await waitNotification(session, publications, releasedAt, reportsInner(true),
      "the enclosing warm worker's diagnostic after regaining ownership");
    const restoredOuter = rootEntry(await session.status(), outerRoot);
    assert.equal(restoredOuter.workerPid, originalOuter.workerPid,
      "ownership regain restarted the enclosing worker");
    assert.equal(restoredOuter.generation, originalOuter.generation,
      "ownership regain changed the enclosing worker's generation");
    await pollStatus(session, (roots) => {
      const entry = findRoot(roots, innerRoot);
      return entry?.origin === "released" ? { accepted: roots } : { rejected: roots };
    }, "the nested folder was not released");
    const inOuter = await pollCompletion(session, innerSource, overlayPosition,
      "the migrated unsaved buffer");
    assert.ok(inOuter.some((item) => item.label === "overlay_marker"),
      "the enclosing root's worker never received the migrated buffer");
    await pollHover(session, outerSource, outerText, "outer_symbol",
      /integer/, "the enclosing root");
    await session.shutdown();
  } finally {
    await session.abort();
  }

  // A root that loses a document must not leave the diagnostics it published
  // for it in the client.
  const plainBase = await makeBase("migrate-diagnostics");
  const sessionRoot = path.join(plainBase, "session");
  const homeRoot = path.join(plainBase, "home");
  await writeRoot(sessionRoot, ROOT_A_SOURCE);
  await mkdir(path.join(homeRoot, "src"), { recursive: true });
  const brokenFile = path.join(homeRoot, "src", "broken.titan");
  await writeFile(brokenFile, "function broken(: integer\n  return 1\nend\n",
    "utf8");
  const homeText = "function home_symbol(): integer\n  return 1\nend\n";
  const homeSource = path.join(homeRoot, "src", "ok.titan");
  await writeFile(homeSource, homeText, "utf8");
  const plainSession = new Session(launch(sessionRoot, "error"));
  try {
    await plainSession.initialize({
      workspaceFolders: [{ uri: uri(sessionRoot), name: "session" }],
      initializationOptions: { trustedRoots: [plainBase] }
    });
    plainSession.notify("initialized", {});
    await pollStatus(plainSession, (roots) =>
      rootEntry(roots, sessionRoot).state === "ready",
      "the session root did not start");
    plainSession.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(homeRoot), name: "home" }], removed: [] }
    });
    // An added root starts lazily; the first request activates its saved index.
    await pollHover(plainSession, homeSource, homeText, "home_symbol",
      /integer/, "the config-less root");
    await poll("the config-less root's diagnostic", async () => {
      const found = plainSession.responses.diagnosticPublications.filter(
        (publication) => publication.uri === uri(brokenFile) &&
          publication.diagnostics.length > 0);
      return found.length > 0 ? { accepted: found } : { rejected: found };
    });
    const beforeRemoval = plainSession.responses.diagnosticPublications.length;
    plainSession.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [{ uri: uri(homeRoot), name: "home" }] }
    });
    await pollStatus(plainSession, (roots) => {
      const entry = findRoot(roots, homeRoot);
      return entry?.origin === "released" ? { accepted: roots } : { rejected: roots };
    }, "the config-less folder was not released");
    // The document is unowned now, so nobody republishes: the router owes the
    // client an empty set for what the removed root last said.
    const cleared = await poll("cleared diagnostics", async () => {
      const found = plainSession.responses.diagnosticPublications
        .slice(beforeRemoval)
        .filter((publication) => publication.uri === uri(brokenFile) &&
          publication.diagnostics.length === 0);
      return found.length > 0 ? { accepted: found } : { rejected: found };
    });
    assert.ok(cleared.length > 0);
    const unowned = await plainSession.failure("textDocument/hover", {
      textDocument: { uri: uri(brokenFile) },
      position: positionOf("function broken", "broken")
    });
    assert.equal(unowned.code, -32803, JSON.stringify(unowned));
    await pollHover(plainSession, path.join(sessionRoot, "src", "main.titan"),
      ROOT_A_SOURCE, "doubled", /integer/, "the surviving session root");
    await plainSession.shutdown();
  } finally {
    await plainSession.abort();
  }
}

// The router retains editor text under the worker's own limits. A buffer it
// cannot retain is replayed as an unavailable contributor, never as saved bytes.
async function testOverlayLimits() {
  const base = await makeBase("overlay-limits");
  const root = path.join(base, "slice");
  const moduleDirectory = path.join(root, "src", "app");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(path.join(root, "titan-config.lua"),
    'include = { "./src" }\nsource_module_roots = { "./src" }\n', "utf8");
  const appSource = [
    "function app_symbol(): integer",
    "  return 1",
    "end",
    "function use_saved(): integer",
    "  return saved_",
    "end",
    ""
  ].join("\n");
  const appFile = path.join(moduleDirectory, "app.titan");
  await writeFile(appFile, appSource, "utf8");
  const extraFile = path.join(moduleDirectory, "extra.titan");
  await writeFile(extraFile, "function saved_only(): integer\n  return 2\nend\n",
    "utf8");
  const appPosition = endOfToken(appSource, "saved_");
  // Over the per-document limit the worker applies (document_buffers.limits).
  const huge = "function saved_only(): integer\n  return 2\nend\n-- " +
    "y".repeat(4 * 1024 * 1024 + 16) + "\n";
  const hugeVersion = 1;

  const completionAt = async (file, position) => {
    const response = await session.send("textDocument/completion", {
      textDocument: { uri: uri(file) },
      position,
      context: { triggerKind: 1 }
    });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  };

  const session = new Session(launch(root, "info"));
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(root), name: "slice" }],
      initializationOptions: { trustedRoots: [base] }
    });
    session.notify("initialized", {});
    await pollStatus(session, (roots) => rootEntry(roots, root).state === "ready",
      "the root did not start");
    session.notify("textDocument/didOpen", {
      textDocument: { uri: uri(appFile), languageId: "titan", version: 1, text: appSource }
    });
    const usable = await pollCompletion(session, appFile, appPosition,
      "the folder module before the over-limit buffer");
    assert.ok(usable.some((item) => item.label === "saved_only"),
      "the saved contributor offered no completion before the over-limit buffer");

    // Opening an over-limit contributor leaves the document open but
    // unavailable in the worker, so the editor text is never analysed.
    session.notify("textDocument/didOpen", {
      textDocument: {
        uri: uri(extraFile), languageId: "titan", version: hugeVersion, text: huge
      }
    });
    const hugePosition = { line: 0, character: 0 };
    const before = await completionAt(extraFile, hugePosition);
    assert.deepEqual({ incomplete: before.isIncomplete, items: before.items.length },
      { incomplete: true, items: 0 },
      "an over-limit document received semantic completion");

    // The router must not retain the buffer; it records the drop instead.
    await poll("the router's over-limit record", async () => {
      const found = session.stderr().toString("utf8").split("\n").filter(
        (line) => line.includes('"overlay.unavailable"') &&
          line.includes(JSON.stringify(uri(extraFile)).slice(1, -1)));
      return found.length > 0 ? { accepted: found } : { rejected: found };
    });

    const running = rootEntry(await session.status(), root);
    process.kill(running.workerPid, "SIGKILL");
    await pollStatus(session, (roots) =>
      rootEntry(roots, root).workerPid === null,
      "the worker's exit was not observed");
    // The replayed worker must report the same unavailable state, not saved bytes.
    const after = await completionAt(extraFile, hugePosition);
    assert.deepEqual({ incomplete: after.isIncomplete, items: after.items.length },
      { incomplete: true, items: 0 },
      "the replayed over-limit document fell back to its saved bytes");

    // The worker tracks the replayed document: a bounded replacement recovers,
    // exactly as it does for a directly received over-limit open.
    const replacement = "function saved_only(): integer\n  return 3\nend\n" +
      "function use_replacement(): integer\n  return saved_\nend\n";
    const recoveredPosition = endOfToken(replacement, "return saved_");
    session.notify("textDocument/didChange", {
      textDocument: { uri: uri(extraFile), version: hugeVersion + 1 },
      contentChanges: [{ text: replacement }]
    });
    const recovered = await pollCompletion(session, extraFile, recoveredPosition,
      "the recovered over-limit document");
    assert.ok(Array.isArray(recovered) && recovered.length > 0,
      "a bounded replacement of the replayed document was ignored");
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

// The extension has one watermark for the whole session, including replacements
// and roots that begin indexing after another root has advanced several times.
async function testIndexingEpochs() {
  const base = await makeBase("epochs");
  const root = path.join(base, "slice");
  const source = await writeRoot(root, ROOT_A_SOURCE);
  const session = new Session(launch(root, "error"));
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(root), name: "slice" }],
      initializationOptions: { trustedRoots: [root] }
    });
    session.notify("initialized", {});
    await pollStatus(session, (roots) =>
      rootEntry(roots, root).state === "ready",
      "the root did not start");
    await pollHover(session, source, ROOT_A_SOURCE, "doubled", /integer/,
      "the first worker");
    const before = session.responses.indexingStatuses.slice();
    assert.ok(before.length > 0, "the session reported no indexing status");
    let watermark = 0;
    for (const status of before) {
      if (status.epoch > watermark) watermark = status.epoch;
    }
    const running = rootEntry(await session.status(), root);
    process.kill(running.workerPid, "SIGKILL");
    await pollStatus(session, (roots) =>
      rootEntry(roots, root).workerPid === null,
      "the worker's exit was not observed");
    await pollHover(session, source, ROOT_A_SOURCE, "doubled", /integer/,
      "the replacement worker");
    const after = session.responses.indexingStatuses.slice(before.length);
    assert.ok(after.length > 0,
      "the replacement worker reported no indexing status");
    // The client drops an epoch below its watermark, so the first epoch of the
    // replacement worker must clear it; later frames of one indexing pass may
    // repeat that epoch, exactly as the worker's own epochs do.
    let previous = watermark;
    for (let index = 0; index < after.length; index += 1) {
      const epoch = after[index].epoch;
      const accepted = index === 0 ? epoch > watermark : epoch >= previous;
      assert.ok(Number.isInteger(epoch) && accepted,
        `a forwarded epoch restarted below the session watermark: ${
          JSON.stringify(after.map((entry) => entry.epoch))} after ${watermark}`);
      previous = epoch;
    }
    assert.ok(after.some((status) => status.state === "ready"),
      "the replacement worker's ready status was not forwarded");
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

// A cancelled cleanup must never leave a worker owned by nobody: shutdown
// cancels the housekeeping Task that may be restarting or evicting a worker.
async function testShutdownDuringRestart() {
  const base = await makeBase("stop-cancel");
  const sdk = path.join(base, "sdk");
  await farmSdk(sdkRoot(), sdk);
  const digests = path.join(sdk, "lib", "titan", "0.6", "sdk-digests");
  await assertFarmedFile(sdk, digests);
  await replaceWithCopy(digests);
  const root = path.join(base, "slice");
  await writeRoot(root, ROOT_A_SOURCE,
    `include = { "./src" }\nsource_module_roots = { "./src" }\ncompiler_root = "${sdk}"\n`);
  const delays = [0, 40, 90, 150, 240];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const session = new Session(launch(root, "error"));
    const pids = new Set();
    try {
      await session.initialize({
        workspaceFolders: [{ uri: uri(root), name: "slice" }],
        initializationOptions: { trustedRoots: [base] }
      });
      session.notify("initialized", {});
      const started = await pollStatus(session, (roots) => {
        const entry = rootEntry(roots, root);
        return entry.state === "ready" && entry.workerPid !== null
          ? { accepted: roots } : { rejected: roots };
      }, "the selected-SDK root did not start");
      pids.add(rootEntry(started, root).workerPid);
      // A reinstall makes housekeeping restart this root on its next sweep; the
      // shutdown below lands in that restart for at least one delay.
      await writeFile(digests, `reinstalled digests ${attempt}\n`, "utf8");
      if (delays[attempt] > 0) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
      await session.shutdown();
      const stderr = session.stderr().toString("utf8");
      assert.equal(
        /server\.failure|worker\.wait\.failure|root\.worker\.stop_failure/
          .test(stderr), false,
        `a cancelled worker stop reported a failure: ${stderr.slice(0, 600)}`);
      for (const pid of pids) {
        assert.throws(() => process.kill(pid, 0), /ESRCH/,
          `worker ${pid} outlived the router`);
      }
    } finally {
      await session.abort();
    }
  }
}

// Criterion 4: two roots' indexing progress and pulled diagnostics must stay
// separate through the router. Each root's file saves a different type error,
// so a leaked generation or a shared progress period is visible in the report.
const PULL_A_SOURCE = [
  "function source(value: integer): integer",
  '  return "text"',
  "end",
  ""
].join("\n");

const PULL_B_SOURCE = [
  "function source(value: integer): integer",
  "  return true",
  "end",
  ""
].join("\n");

// The client answers the router's remapped work-done requests exactly as an
// editor does. A router that lost a worker's request or its answer leaves that
// worker without progress, which the assertions below detect.
function answerWorkDoneRequests(session) {
  session.responses.serverRequestHandler = (message) => {
    assert.equal(message.method, "window/workDoneProgress/create",
      `unexpected server request ${message.method}`);
    session.child.stdin.write(frame({
      jsonrpc: "2.0", id: message.id, result: null
    }));
  };
}


// Read the next message that is a reply to a client request, collecting any
// notifications that arrive first.
async function nextServerReply(session, milliseconds = QUERY_TIMEOUT_MILLISECONDS) {
  while (true) {
    const message = await session.responses.read(milliseconds);
    if (message.id === undefined && typeof message.method === "string") {
      collectNotification(session.responses, message);
      continue;
    }
    return message;
  }
}

function progressFor(progress, token) {
  return progress.filter((entry) => entry.token === token);
}

function assertOnePeriod(progress, token, label) {
  const events = progressFor(progress, token);
  assert.ok(events.length >= 3,
    `${label}: progress for ${token} reported only ${events.length} events`);
  const kinds = events.map((entry) => entry.value.kind);
  assert.equal(kinds[0], "begin", `${label}: progress did not begin`);
  assert.equal(kinds.at(-1), "end", `${label}: progress did not end`);
  assert.equal(kinds.filter((kind) => kind === "begin").length, 1,
    `${label}: one indexing period published more than one begin`);
  assert.equal(kinds.filter((kind) => kind === "end").length, 1,
    `${label}: one indexing period published more than one end`);
  assert.equal(kinds.filter((kind) => kind === "report").length >= 1, true,
    `${label}: progress published no saved-file workset`);
}

function lastPublicationFor(session, uri) {
  const publications = session.responses.diagnosticPublications;
  for (let index = publications.length - 1; index >= 0; index -= 1) {
    if (publications[index].uri === uri) return publications[index];
  }
  return undefined;
}

async function pullDiagnostics(session, uri) {
  const report = await session.result("textDocument/diagnostic", {
    textDocument: { uri }
  });
  assert.equal(typeof report.resultId, "string",
    `a pull for ${uri} omitted its result id`);
  assert.match(report.resultId, /^[0-9a-f]{64}$/,
    "a pull result id is not a lowercase hex SHA-256");
  return report;
}

async function testProgressAndPullPerRoot() {
  const base = await makeBase("cells");
  const rootA = path.join(base, "a");
  const rootB = path.join(base, "b");
  const sourceA = await writeRoot(rootA, PULL_A_SOURCE);
  const sourceB = await writeRoot(rootB, PULL_B_SOURCE);
  const session = new Session(launch(rootA, "error"));
  try {
    answerWorkDoneRequests(session);
    const result = await session.initialize({
      capabilities: { window: { workDoneProgress: true } },
      workspaceFolders: [
        { uri: uri(rootA), name: "a" },
        { uri: uri(rootB), name: "b" }
      ],
      initializationOptions: { trustedRoots: [rootA, rootB] }
    });
    // The router advertises pull diagnostics from the client's capabilities.
    assert.deepEqual(result.capabilities.diagnosticProvider, {
      interFileDependencies: true, workspaceDiagnostics: false
    }, "the router did not advertise pull diagnostics");
    session.notify("initialized", {});

    // Drain worker traffic through a router-owned request until both roots end
    // their own indexing period.
    const ends = await poll("both roots' indexing progress", async () => {
      await session.status();
      const found = session.responses.progress.filter(
        (entry) => entry.value.kind === "end");
      return found.length >= 2 ? { accepted: found } : { rejected: found };
    });
    assert.equal(ends.length, 2,
      `two roots reported ${ends.length} indexing periods`);
    const tokens = ends.map((entry) => entry.token);
    assert.equal(new Set(tokens).size, 2,
      "two roots shared one work-done progress token");
    const pids = tokens.map((token) => {
      const match = /^titan-progress\/(\d+)\/(\d+)$/.exec(token);
      assert.ok(match, `token ${token} is not process-qualified`);
      return match[1];
    });
    assert.equal(new Set(pids).size, 2,
      "two roots' progress tokens name one worker process");
    for (const token of tokens) {
      assertOnePeriod(session.responses.progress, token,
        `root progress ${token}`);
    }
    assert.equal(session.responses.serverRequests.length, 2,
      "two roots requested an unexpected number of progress tokens");
    const created = session.responses.serverRequests.map(
      (message) => message.params.token);
    assert.deepEqual([...created].sort(), [...tokens].sort(),
      "a root's created token did not carry its own progress");
    assert.equal(new Set(session.responses.serverRequests.map(
      (message) => message.id)).size, 2,
      "the router reused one request id for both workers");

    // Criterion 4: each root's pull reports only its own saved diagnostics.
    const reportA = await pullDiagnostics(session, uri(sourceA));
    const reportB = await pullDiagnostics(session, uri(sourceB));
    assert.equal(reportA.kind, "full");
    assert.equal(reportB.kind, "full");
    assert.equal(reportA.items.length, 1,
      `root A pulled ${JSON.stringify(reportA.items)}`);
    assert.equal(reportB.items.length, 1,
      `root B pulled ${JSON.stringify(reportB.items)}`);
    assert.match(reportA.items[0].message, /string/i,
      "root A's pull did not describe its own type error");
    assert.match(reportB.items[0].message, /boolean/i,
      "root B's pull did not describe its own type error");
    assert.equal(reportA.items[0].message.includes("boolean"), false,
      "root A's pull reported root B's diagnostic");
    assert.notEqual(reportA.resultId, reportB.resultId,
      "two roots' pulls reported one result id");
    // Pull and push agree per root: the pull serves the published rows.
    const publishedA = lastPublicationFor(session, uri(sourceA));
    const publishedB = lastPublicationFor(session, uri(sourceB));
    assert.ok(publishedA && publishedB,
      "a root published no diagnostics for its own error");
    assert.deepEqual(publishedA.diagnostics, reportA.items,
      "root A's pull disagreed with its push");
    assert.deepEqual(publishedB.diagnostics, reportB.items,
      "root B's pull disagreed with its push");

    // Replaying a result id answers unchanged for that root only.
    const repeated = await session.result("textDocument/diagnostic", {
      textDocument: { uri: uri(sourceA) },
      previousResultId: reportA.resultId
    });
    assert.deepEqual(repeated, {
      kind: "unchanged", resultId: reportA.resultId
    }, "a repeated pull did not replay its own result id");

    // The router classifies bodies through the same envelope owner as its
    // workers: an answer to an unknown id is dropped silently (the following
    // request would report the stray reply), and a malformed body with a string
    // id is Invalid Request rather than a client response.
    session.child.stdin.write(frame({
      jsonrpc: "2.0", id: "titan-ls:9999", result: null
    }));
    await pollStatus(session, (entries) => entries.length === 2,
      "the router stopped answering after an unknown client response");
    session.child.stdin.write(frame({ jsonrpc: "2.0", id: "orphan-request" }));
    const invalid = await nextServerReply(session);
    assert.equal(invalid.id, null,
      `Invalid Request reply kept a request id: ${JSON.stringify(invalid)}`);
    assert.equal(invalid.error?.code, -32600,
      `a malformed body was not rejected: ${JSON.stringify(invalid)}`);
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testRouterPullOptOut() {
  const base = await makeBase("optout");
  const root = path.join(base, "a");
  await writeRoot(root, PULL_A_SOURCE);
  const session = new Session(launch(root, "error"));
  try {
    const result = await session.initialize({
      workspaceFolders: [{ uri: uri(root), name: "a" }],
      initializationOptions: { trustedRoots: [root], pullDiagnostics: false }
    });
    assert.equal(result.capabilities.diagnosticProvider, undefined,
      "the router advertised pull diagnostics to an opted-out client");
    assert.deepEqual(result.capabilities.workspace, {
      workspaceFolders: { supported: true, changeNotifications: true }
    }, "the pull opt-out suppressed the folder capability");
    session.notify("initialized", {});
    await pollSettled(session, 1, "the opted-out root did not start");
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

// Wait on recorded or newly arriving protocol traffic, never on a delay that
// merely hopes a background worker has completed.
async function waitNotification(session, collection, start, predicate, label) {
  const deadline = performance.now() + STATUS_TIMEOUT_MILLISECONDS;
  let cursor = start;
  while (true) {
    while (cursor < collection.length) {
      const notification = collection[cursor++];
      if (predicate(notification)) return notification;
    }
    const remaining = deadline - performance.now();
    assert.ok(remaining > 0, `timed out waiting for ${label}`);
    let message;
    try {
      message = await session.responses.read(remaining);
    } catch (cause) {
      throw new Error(`${label}: ${cause.message}; last notifications: ${
        JSON.stringify(collection.slice(start))}; stderr: ${
        session.stderr().toString("utf8")}`, { cause });
    }
    assert.equal(message.id, undefined, `unexpected response during ${label}`);
    collectNotification(session.responses, message);
  }
}

async function testNestedIndexingStatus() {
  const base = await makeBase("nested-status");
  const outerRoot = path.join(base, "outer");
  const innerRoot = path.join(outerRoot, "inner");
  const outerSource = await writeRoot(outerRoot, ROOT_A_SOURCE);
  const innerSource = await writeRoot(innerRoot, ROOT_B_SOURCE);
  const session = new Session(launch(outerRoot, "error"));
  const model = new IndexingStatusModel();
  let cursor = 0;
  let epoch = -1;
  let generation = 0;
  const consume = () => {
    const displays = [];
    for (; cursor < session.responses.indexingStatuses.length; cursor += 1) {
      const status = session.responses.indexingStatuses[cursor];
      assert.ok(status.epoch >= epoch, "the session epoch moved backwards");
      assert.ok(status.generation >= generation, "the session generation moved backwards");
      epoch = status.epoch;
      generation = status.generation;
      const display = model.update(status);
      assert.ok(display, `the extension rejected ${JSON.stringify(status)}`);
      displays.push(display);
    }
    return displays;
  };
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(outerRoot), name: "outer" }],
      initializationOptions: { trustedRoots: [base] }
    });
    session.notify("initialized", {});
    await waitNotification(session, session.responses.indexingStatuses, 0,
      (status) => status.state === "ready", "the outer root's first index");
    consume();
    // Pull is a saved-refresh barrier. Repeated pulls advance the outer epoch
    // without depending on watcher debounce timing or changing the nested tree.
    for (let index = 0; index < 3; index += 1) {
      const start = session.responses.indexingStatuses.length;
      await pullDiagnostics(session, uri(outerSource));
      await waitNotification(session, session.responses.indexingStatuses, start,
        (status) => status.state === "ready", "an outer refresh");
      consume();
    }
    const outerEpoch = epoch;
    const nestedStart = session.responses.indexingStatuses.length;
    await pollHover(session, innerSource, ROOT_B_SOURCE, "tripled", /integer/,
      "the newly discovered nested project");
    await waitNotification(session, session.responses.indexingStatuses, nestedStart,
      (status) => status.state === "ready", "the nested root's index");
    const nestedDisplays = consume();
    assert.ok(nestedDisplays.some((display) => display.kind === "busy" && display.initial),
      "the extension hid the nested root's initial indexing");
    assert.ok(session.responses.indexingStatuses.slice(nestedStart)
      .every((status) => status.epoch > outerEpoch),
    "the nested root did not clear the outer root's watermark");

    const failureStart = session.responses.indexingStatuses.length;
    await writeFile(path.join(innerRoot, "titan-config.lua"),
      "print('configuration cannot write stdout')\n", "utf8");
    // The explicit pull starts and waits for the failed saved refresh.
    const failedPull = await session.send("textDocument/diagnostic", {
      textDocument: { uri: uri(innerSource) }
    });
    assert.ok(failedPull.error, "the nested root's invalid configuration was accepted");
    await waitNotification(session, session.responses.indexingStatuses, failureStart,
      (status) => status.state === "failed", "the nested root's failure");
    assert.ok(consume().some((display) => display.kind === "failed" &&
      display.message.includes(innerRoot) &&
      /cannot evaluate titan-config\.lua/.test(display.message)),
    "the extension hid the nested root's qualified failure");
    // Another root's successful refresh must not dismiss that failure.
    const readyStart = session.responses.indexingStatuses.length;
    await pullDiagnostics(session, uri(outerSource));
    await waitNotification(session, session.responses.indexingStatuses, readyStart,
      (status) => status.state === "failed", "the retained nested failure");
    assert.equal(consume().at(-1).kind, "failed");
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testCrashDiagnosticClearing() {
  const base = await makeBase("crash-diagnostics");
  const root = path.join(base, "project");
  const source = await writeRoot(root,
    "function answer(): integer\n  return 'broken'\nend\n");
  const session = new Session(launch(root, "error"));
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(root), name: "project" }],
      initializationOptions: { trustedRoots: [base] }
    });
    session.notify("initialized", {});
    const published = await waitNotification(session,
      session.responses.diagnosticPublications, 0,
      (item) => item.uri === uri(source) && item.diagnostics.length > 0,
      "the worker's error");
    const running = rootEntry(await session.status(), root);
    const start = session.responses.diagnosticPublications.length;
    process.kill(running.workerPid, "SIGKILL");
    // No request for this root is sent until the file is fixed. Observing the
    // exit is a router-only request and cannot activate the replacement.
    await pollStatus(session, (entries) =>
      rootEntry(entries, root).workerPid === null, "the crashed worker's exit");
    await writeFile(source, ROOT_A_SOURCE, "utf8");
    await waitNotification(session, session.responses.diagnosticPublications, start,
      (item) => item.uri === uri(source) && item.diagnostics.length === 0,
      "the crashed worker's diagnostic clearing");
    await pollHover(session, source, ROOT_A_SOURCE, "doubled", /integer/,
      "the fixed replacement worker");
    assert.notEqual(rootEntry(await session.status(), root).workerPid, running.workerPid);
    assert.equal(lastPublicationFor(session, published.uri).diagnostics.length, 0,
      "the replacement left the crashed worker's error visible");
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testWarmDiagnosticReplay() {
  const base = await makeBase("warm-diagnostics");
  const sessionRoot = path.join(base, "session");
  const plainRoot = path.join(base, "plain");
  await writeRoot(sessionRoot, ROOT_A_SOURCE);
  await mkdir(path.join(plainRoot, "src"), { recursive: true });
  const source = path.join(plainRoot, "src", "broken.titan");
  await writeFile(source, "function answer(): integer\n  return 'broken'\nend\n", "utf8");
  const session = new Session(launch(sessionRoot, "error"));
  const folder = { uri: uri(plainRoot), name: "plain" };
  try {
    await session.initialize({
      workspaceFolders: [{ uri: uri(sessionRoot), name: "session" }],
      initializationOptions: { trustedRoots: [base] }
    });
    session.notify("initialized", {});
    await waitNotification(session, session.responses.indexingStatuses, 0,
      (status) => status.state === "ready", "the session root's index");
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [folder], removed: [] }
    });
    await pullDiagnostics(session, uri(source));
    const published = await waitNotification(session,
      session.responses.diagnosticPublications, 0,
      (item) => item.uri === uri(source) && item.diagnostics.length > 0,
      "the config-less folder's error");
    const running = rootEntry(await session.status(), plainRoot);
    const removedAt = session.responses.diagnosticPublications.length;
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [folder] }
    });
    await waitNotification(session, session.responses.diagnosticPublications, removedAt,
      (item) => item.uri === uri(source) && item.diagnostics.length === 0,
      "the released root's diagnostic clearing");
    const readdedAt = session.responses.diagnosticPublications.length;
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [folder], removed: [] }
    });
    const replayed = await waitNotification(session,
      session.responses.diagnosticPublications, readdedAt,
      (item) => item.uri === uri(source) && item.diagnostics.length > 0,
      "the warm reclaimed root's diagnostic replay");
    assert.deepEqual(replayed, published, "warm replay changed the completed diagnostics");
    const reclaimed = rootEntry(await session.status(), plainRoot);
    assert.equal(reclaimed.workerPid, running.workerPid, "warm reclaim restarted its worker");
    assert.equal(reclaimed.generation, running.generation, "warm reclaim reactivated its worker");

    const config = path.join(plainRoot, "titan-config.lua");
    const failureAt = session.responses.diagnosticPublications.length;
    await writeFile(config, "include = 42\n", "utf8");
    const failure = await session.failure("textDocument/diagnostic", {
      textDocument: { uri: uri(source) }
    });
    assert.match(failure.message, /include/,
      "the saved refresh did not fail on the invalid configuration");
    await waitNotification(session, session.responses.diagnosticPublications, failureAt,
      (item) => item.uri === uri(source) && item.diagnostics.length === 0,
      "the failed saved refresh's diagnostic clearing");

    const failedReplayAt = session.responses.diagnosticPublications.length;
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [folder] }
    });
    await session.status();
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [folder], removed: [] }
    });
    const failedReclaim = rootEntry(await session.status(), plainRoot);
    assert.equal(failedReclaim.workerPid, running.workerPid,
      "failed saved refresh replaced the warm worker");
    assert.equal(failedReclaim.generation, running.generation,
      "failed saved refresh reactivated the warm worker");
    assert.ok(!session.responses.diagnosticPublications.slice(failedReplayAt).some(
      (item) => item.uri === uri(source) && item.diagnostics.length > 0),
    "warm reclaim resurrected diagnostics cleared by a failed saved refresh");

    const repairAt = session.responses.diagnosticPublications.length;
    await writeFile(config,
      "include = { 'src' }\nsource_module_roots = { 'src' }\n", "utf8");
    await pullDiagnostics(session, uri(source));
    await waitNotification(session, session.responses.diagnosticPublications, repairAt,
      (item) => item.uri === uri(source) && item.diagnostics.length > 0,
      "diagnostic publication after repairing the saved configuration");
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

function peerSession(root) {
  const executable = process.env.TITAN_ROUTER_WORKER_FIXTURE;
  assert.ok(executable, "build the router peer and set TITAN_ROUTER_WORKER_FIXTURE");
  return new Session(spawn(executable, ["--router"], {
    cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"]
  }));
}

function assertAcceptedTimeline(session) {
  const model = new IndexingStatusModel();
  let epoch = -1;
  let generation = 0;
  for (const status of session.responses.indexingStatuses) {
    assert.ok(status.epoch >= epoch && status.generation >= generation,
      `the session timeline regressed: ${JSON.stringify(status)}`);
    assert.ok(model.update(status),
      `the extension rejected a lifecycle status: ${JSON.stringify(status)}`);
    epoch = status.epoch;
    generation = status.generation;
  }
}

async function testRouterActivationTransitions() {
  const base = await makeBase("activation-transitions");
  for (const mode of ["reject-initialize", "exit-before-initialize",
    "exit-on-initialize", "invalid-settings", "quiet"]) {
    const root = path.join(base, mode);
    await writeRoot(root, ROOT_A_SOURCE);
    if (mode === "invalid-settings") {
      await writeFile(path.join(root, "titan-config.lua"), "compiler_root = 3\n", "utf8");
    }
    const session = peerSession(root);
    try {
      await session.initialize({ workspaceFolders: [{ uri: uri(root), name: mode }] });
      session.notify("initialized", {});
      if (mode === "quiet") {
        const running = rootEntry(await session.status(), root);
        assert.ok(Number.isInteger(running.workerPid), "the quiet peer reported no PID");
        assert.equal(session.responses.indexingStatuses.length, 1,
          "the quiet peer emitted an indexing frame before the kill");
        process.kill(running.workerPid, "SIGKILL");
      }
      await waitNotification(session, session.responses.indexingStatuses, 0,
        (status) => status.state === "failed", `${mode} terminal status`);
      const statuses = session.responses.indexingStatuses;
      assert.equal(statuses[0].state, "indexing");
      assert.equal(statuses[0].initial, true);
      assert.equal(statuses[0].completed_files, undefined);
      assert.equal(statuses.at(-1).generation, 0,
        "failure counted a completed root publication");
      assert.equal(statuses.length, 2, "activation repeated its terminal frame");
      assert.equal(rootEntry(await session.status(), root).state, "failed");
      assertAcceptedTimeline(session);
      await session.shutdown();
    } finally {
      await session.abort();
    }
  }
}

async function testNestedDiscoveryDuringBlockedRefresh() {
  const base = await makeBase("blocked-refresh");
  const outer = path.join(base, "refresh-blocked");
  const inner = path.join(outer, "accept");
  // No outer config: releasing the folder must really exclude that root, not
  // rediscover and immediately reclaim it while clearing diagnostic ownership.
  await mkdir(outer);
  const outerSource = path.join(outer, "main.titan");
  await writeFile(outerSource, ROOT_A_SOURCE, "utf8");
  const innerSource = await writeRoot(inner, ROOT_B_SOURCE);
  const session = peerSession(outer);
  const folder = { uri: uri(outer), name: "outer" };
  const issue = (method, params) => {
    const id = session.nextId++;
    session.child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
    return id;
  };
  try {
    await session.initialize({ workspaceFolders: [folder] });
    session.notify("initialized", {});
    await waitNotification(session, session.responses.indexingStatuses, 0,
      (status) => status.state === "ready", "the peer's initial index");
    const running = rootEntry(await session.status(), outer);
    const refreshStart = session.responses.indexingStatuses.length;
    const pullId = issue("textDocument/diagnostic", {
      textDocument: { uri: uri(outerSource) }
    });
    const busy = await waitNotification(session, session.responses.indexingStatuses,
      refreshStart, (status) => status.state === "indexing", "blocked saved refresh");
    const nestedStart = session.responses.indexingStatuses.length;
    // The peer deliberately rejects semantic requests; that reply is a barrier
    // proving the router discovered and activated the nested root, not a compiler
    // assertion. The outer pull cannot complete until the later outer hover.
    const nested = await session.send("textDocument/hover", {
      textDocument: { uri: uri(innerSource) }, position: { line: 0, character: 0 }
    });
    assert.match(nested.error?.message ?? "", /unsupported fixture request/);
    const discovered = await session.status();
    assert.equal(rootEntry(discovered, inner).origin, "discovered");
    assert.ok(session.responses.indexingStatuses.slice(nestedStart)
      .some((status) => status.state === "indexing" && status.initial &&
        status.epoch > busy.epoch), "nested discovery did not replace the busy workset");
    assert.equal(session.responses.indexingStatuses.at(-1).state, "indexing",
      "the nested ready frame hid the blocked outer refresh");

    let start = session.responses.indexingStatuses.length;
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [folder] }
    });
    const released = await waitNotification(session, session.responses.indexingStatuses,
      start, (status) => status.state === "ready", "release of the busy outer root");
    start = session.responses.indexingStatuses.length;
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [folder], removed: [] }
    });
    const reclaimed = await waitNotification(session, session.responses.indexingStatuses,
      start, (status) => status.state === "indexing", "reclaim of the busy outer root");
    assert.ok(reclaimed.epoch > released.epoch);
    assert.equal(reclaimed.generation, released.generation,
      "warm reclaim counted another completed publication");
    assert.equal(rootEntry(await session.status(), outer).workerPid, running.workerPid,
      "busy release/reclaim replaced the warm worker");

    const hoverId = issue("textDocument/hover", {
      textDocument: { uri: uri(outerSource) }, position: { line: 0, character: 0 }
    });
    const replies = new Map();
    while (replies.size < 2) {
      const message = await session.responses.read(STATUS_TIMEOUT_MILLISECONDS);
      if (message.id === undefined) {
        collectNotification(session.responses, message);
      } else {
        assert.ok(message.id === pullId || message.id === hoverId,
          `unexpected reply while releasing refresh: ${JSON.stringify(message)}`);
        assert.ok(!replies.has(message.id), "the peer repeated a request reply");
        replies.set(message.id, message);
      }
    }
    assert.deepEqual(replies.get(pullId).result, { kind: "full", items: [] });
    assert.equal(replies.get(hoverId).result, null);
    await waitNotification(session, session.responses.indexingStatuses, start,
      (status) => status.state === "ready", "the released saved refresh");
    assertAcceptedTimeline(session);
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

async function testAggregateCountedProgress() {
  const base = await makeBase("aggregate-progress");
  const firstRoot = path.join(base, "a", "progress-controlled");
  const secondRoot = path.join(base, "b", "progress-controlled");
  const firstSource = await writeRoot(firstRoot, ROOT_A_SOURCE);
  const secondSource = await writeRoot(secondRoot, ROOT_B_SOURCE);
  const session = peerSession(firstRoot);
  const statuses = session.responses.indexingStatuses;
  const advance = async (source) => {
    const start = statuses.length;
    assert.equal(await session.result("textDocument/hover", {
      textDocument: { uri: uri(source) }, position: { line: 0, character: 0 }
    }), null);
    return statuses.slice(start);
  };
  try {
    await session.initialize({
      workspaceFolders: [
        { uri: uri(firstRoot), name: "first" },
        { uri: uri(secondRoot), name: "second" }
      ],
      initializationOptions: { trustedRoots: [base] }
    });
    session.notify("initialized", {});
    assert.equal((await session.status()).length, 2);
    assert.equal(statuses.length, 1, "startup repeated an unchanged busy aggregate");
    assert.equal(statuses[0].state, "indexing");
    assert.equal(statuses[0].initial, true);
    assert.equal(statuses[0].completed_files, undefined);
    assert.equal(statuses[0].total_files, undefined);
    const initialEpoch = statuses[0].epoch;

    // Another unknown root hides this root's progress and completed generation.
    // Each hover reply is a barrier after that peer's indexing notification.
    assert.deepEqual(await advance(firstSource), []);
    assert.deepEqual(await advance(firstSource), []);
    assert.deepEqual(await advance(firstSource), [],
      "a hidden completion published a generation-only busy frame");
    const baseline = await advance(secondSource);
    assert.equal(baseline.length, 1);
    assert.deepEqual([baseline[0].completed_files, baseline[0].total_files,
      baseline[0].epoch], [0, 4, initialEpoch]);
    const progress = await advance(secondSource);
    assert.equal(progress.length, 1);
    assert.deepEqual([progress[0].completed_files, progress[0].total_files,
      progress[0].epoch], [1, 4, initialEpoch]);

    const unknown = await advance(firstSource);
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].state, "indexing");
    assert.equal(unknown[0].completed_files, undefined);
    assert.equal(unknown[0].total_files, undefined);
    assert.ok(unknown[0].epoch > initialEpoch,
      "unknown work retained the preceding counted workset");
    const summed = await advance(firstSource);
    assert.deepEqual(summed.map((status) =>
      [status.completed_files, status.total_files, status.epoch]),
    [[0, 8, unknown[0].epoch], [1, 8, unknown[0].epoch]]);

    // Finishing one root changes the denominator, not initial session scope.
    const reduced = await advance(secondSource);
    assert.equal(reduced.length, 2);
    assert.equal(reduced[0].completed_files, undefined);
    assert.equal(reduced[0].total_files, undefined);
    assert.ok(reduced[0].epoch > unknown[0].epoch);
    assert.deepEqual([reduced[1].completed_files, reduced[1].total_files,
      reduced[1].epoch], [0, 4, reduced[0].epoch]);
    const remaining = await advance(firstSource);
    assert.equal(remaining.length, 1);
    assert.deepEqual([remaining[0].completed_files, remaining[0].total_files,
      remaining[0].epoch], [2, 4, reduced[0].epoch]);
    const ready = await advance(firstSource);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].state, "ready");
    assert.equal(ready[0].generation, 3,
      "the final generation lost a completion hidden behind busy");
    assert.ok(statuses.every((status) => status.initial &&
      status.message === undefined), "the initial cycle changed scope or gained a message");
    assertAcceptedTimeline(session);
    await session.shutdown();
  } finally {
    await session.abort();
  }
}

// These cases prove symlink semantics: a farmed SDK is a tree of links into the
// session SDK, and one workspace folder is reached through a link.
const SYMLINK_GROUPS = new Set(["sdk", "sdk-errors", "overlays", "shutdown-restart"]);

const groups = [
  ["independent", testIndependentRoots, "independent roots"],
  ["folders", testFolderChanges, "folder changes"],
  ["discovery", testLazyDiscovery, "lazy discovery"],
  ["sdk", testSecondSdk, "second SDK"],
  ["sdk-errors", testRootScopedSdkErrors, "root-scoped SDK errors"],
  ["crash", testWorkerCrashAndOverlay, "crash and overlay replay"],
  ["cap", testCapAndIdleEviction, "worker cap and idle eviction"],
  ["cancel", testCancellation, "request cancellation"],
  ["overlays", testOverlayOwnership, "overlay ownership"],
  ["nested", testNestedProjects, "nested projects"],
  ["released", testReleasedRoots, "released roots"],
  ["migrate", testOwnershipMigration, "ownership migration"],
  ["overlay-limits", testOverlayLimits, "overlay limits"],
  ["indexing-epochs", testIndexingEpochs, "indexing epochs"],
  ["nested-status", testNestedIndexingStatus, "nested indexing and failure status"],
  ["crash-diagnostics", testCrashDiagnosticClearing, "crashed diagnostic clearing"],
  ["warm-diagnostics", testWarmDiagnosticReplay, "warm diagnostic replay"],
  ["activation-transitions", testRouterActivationTransitions, "framed activation failure transitions"],
  ["busy-membership", testNestedDiscoveryDuringBlockedRefresh, "nested discovery and busy membership transitions"],
  ["aggregate-progress", testAggregateCountedProgress, "aggregate counted progress and hidden completions"],
  ["shutdown-restart", testShutdownDuringRestart, "shutdown during a restart"],
  ["diagnostics", testProgressAndPullPerRoot, "progress and pull per root"],
  ["diagnostics-optout", testRouterPullOptOut, "router pull opt-out"]
];

async function main() {
  assert.ok(process.argv[2], "usage: node scripts/test-multi-root.mjs PATH-TO-SERVER [GROUP]");
  const only = process.argv[3];
  if (only !== undefined) {
    assert.ok(groups.some(([name]) => name === only),
      `unknown group ${only}; known groups: ${groups.map(([name]) => name).join(", ")}`);
  }
  const symlinks = await canCreateSymlinks();
  for (const [name, run, label] of groups) {
    if (only !== undefined && only !== name) continue;
    if (!symlinks && SYMLINK_GROUPS.has(name)) {
      console.log(`multi-root: ${label} skipped ` +
        "(this account cannot create symbolic links)");
      continue;
    }
    await run();
    console.log(`multi-root: ${label} passed`);
  }
}

try {
  await main();
  await removeTemporaryDirectories();
} catch (cause) {
  await removeTemporaryDirectories();
  throw cause;
}

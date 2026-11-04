// Real-server transcript for one language-server session serving several
// independent Titan roots. Every case launches the built executable and speaks
// framed JSON-RPC over its stdio, exactly as a client does.
import assert from "node:assert/strict";
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
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FrameReader,
  collect,
  exitOf,
  frame,
  launch,
  request,
  withTimeout
} from "./test-server-protocol.mjs";

const QUERY_TIMEOUT_MILLISECONDS = 30_000;
const STATUS_TIMEOUT_MILLISECONDS = 30_000;
const POLL_INTERVAL_MILLISECONDS = 25;

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
  const entry = roots.find((candidate) => candidate.root === rootPath);
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
    assert.equal(probeA, path.join(await realpath(rootA), ".titan-ls"),
      "a root's probe prefix escaped its own root");
    assert.equal(rootEntry(roots, rootA).titanRoot, process.env.TITAN_ROOT,
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
      roots.length === 2 && roots.some((entry) => entry.root === rootB && entry.state === "ready"),
      "the added folder did not activate");
    assert.equal(rootEntry(twoRoots, rootB).origin, "folder");
    await pollHover(session, sourceB, ROOT_B_SOURCE, "tripled", /integer/,
      "the added root");

    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [{ uri: uri(rootB), name: "b" }] }
    });
    const removed = await pollStatus(session, (roots) =>
      roots.length === 1 && roots[0].root === rootA, "the folder removal did not release the root");
    assert.equal(removed[0].state, "ready",
      "removing one folder disturbed another root");
    assert.notEqual(removed[0].workerPid, twoRoots[1].workerPid);
    const hoverA = await pollHover(session, sourceA, ROOT_A_SOURCE, "doubled",
      /doubled|integer/, "the surviving root");

    // A removed folder's document is now outside every known root, so the
    // documented lazy discovery owns it again as a discovered root.
    await pollHover(session, sourceB, ROOT_B_SOURCE, "tripled", /integer/,
      "the removed root's document");
    const rediscovered = await pollStatus(session, (roots) => {
      const entry = roots.find((candidate) => candidate.root === rootB);
      return entry?.origin === "discovered"
        ? { accepted: roots }
        : { rejected: roots };
    }, "the removed root was not rediscovered");
    assert.equal(rediscovered.length, 2);

    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(rootB), name: "b" }], removed: [] }
    });
    const readded = await pollStatus(session, (roots) =>
      roots.some((entry) => entry.root === rootB && entry.origin === "folder"),
      "the re-added folder did not reclaim its root");
    assert.equal(rootEntry(readded, rootB).state, "ready",
      "a re-added root lost its worker");
    await pollHover(session, sourceB, ROOT_B_SOURCE, "tripled", /integer/,
      "the re-added root");

    // A symlinked folder canonicalizes onto the root it names.
    const linkPath = path.join(base, "a-link");
    await symlink(rootA, linkPath);
    session.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: uri(linkPath), name: "a-link" }], removed: [] }
    });
    const linked = await pollStatus(session, (roots) => roots.length === 2,
      "a symlinked folder created a third root");
    assert.equal(linked.length, 2,
      "a symlinked folder did not share its physical root");

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
      const entry = roots.find((candidate) => candidate.root === nestedRoot);
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
      roots.length === 1 && roots[0].root === plain && roots[0].state === "ready",
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
      roots.length === 1 && roots[0].root === sessionRoot,
      "the launch directory did not become the initial root");

    // No client folder support: the first routed message discovers the nearest
    // configuration ancestor, even when that configuration is nested.
    session.notify("textDocument/didOpen", {
      textDocument: { uri: uri(deepSource), languageId: "titan", version: 1, text: ROOT_B_SOURCE }
    });
    await pollHover(session, deepSource, ROOT_B_SOURCE, "tripled", /integer/,
      "the deepest discovered root");
    const deepest = await pollStatus(session, (roots) => {
      const entry = roots.find((candidate) => candidate.root === deep);
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
      const entry = roots.find((candidate) => candidate.root === inner);
      return entry?.origin === "discovered"
        ? { accepted: roots }
        : { rejected: roots };
    }, "the enclosing configuration was not discovered");
    assert.ok(inner.startsWith(deep.slice(0, deep.lastIndexOf("/"))));
    assert.equal(nested.filter((entry) => entry.origin === "discovered").length, 2,
      "discovery registered an unexpected number of roots");
    assert.equal(nested.some((entry) => entry.root === path.join(base, "slice")), false,
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
    assert.equal(rootEntry(roots, sdkRootDir).compilerRoot, await realpath(sdk),
      "the selected root did not report its compiler_root");
    assert.equal(rootEntry(roots, sdkRootDir).titanRoot, await realpath(sdk),
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
    const generated = new Map(roots.map((entry) => [entry.root, entry.generation]));
    const localOverride = path.join(sdkRootDir, "titan-config.local.lua");
    await writeFile(localOverride, `compiler_root = "${sdk}"\n`, "utf8");
    session.notify("workspace/didChangeConfiguration", { settings: {} });
    const unchanged = await session.status();
    assert.equal(rootEntry(unchanged, sdkRootDir).generation,
      generated.get(sdkRootDir), "an unchanged local override restarted a worker");
    assert.equal(rootEntry(unchanged, defaultRoot).generation,
      generated.get(defaultRoot), "an unrelated root restarted");

    // A local override that selects a different prefix restarts only its root.
    const secondSdk = path.join(base, "second-sdk");
    await farmSdk(sdkRoot(), secondSdk);
    const beforeSelection = rootEntry(await session.status(), sdkRootDir).generation;
    await writeFile(localOverride, `compiler_root = "${secondSdk}"\n`, "utf8");
    session.notify("workspace/didChangeConfiguration", { settings: {} });
    const reselected = await pollStatus(session, (entries) => {
      const entry = entries.find((candidate) => candidate.root === sdkRootDir);
      return entry?.compilerRoot === path.normalize(secondSdk) &&
        entry.generation > beforeSelection && entry.state === "ready"
        ? { accepted: entries }
        : { rejected: entries };
    }, "the local override did not restart the root with the second SDK");
    assert.equal(rootEntry(reselected, sdkRootDir).titanRoot,
      path.normalize(secondSdk),
      "the restarted worker did not adopt the second SDK");
    assert.equal(rootEntry(reselected, defaultRoot).generation,
      generated.get(defaultRoot), "a per-root SDK change restarted an unrelated root");
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
      const entry = entries.find((candidate) => candidate.root === sdkRootDir);
      return entry !== undefined && entry.generation > beforeReinstall &&
        entry.state === "ready" && entry.workerPid !== null
        ? { accepted: entries }
        : { rejected: entries };
    }, "the reinstalled SDK did not restart its worker");
    assert.equal(rootEntry(restarted, defaultRoot).generation,
      generated.get(defaultRoot),
      "an SDK reinstall restarted an unrelated root");
    await pollHover(session, sdkSource, SDK_SOURCE, "tripled", /integer/,
      "the root after the SDK reinstall");

    // A local override exists only to select an SDK, so a broken one refuses an
    // already-ready root instead of quietly serving the router's own SDK.
    await writeFile(localOverride,
      `compiler_root = "${secondSdk}"\ninclude = { "./src" }\n`, "utf8");
    session.notify("workspace/didChangeConfiguration", { settings: {} });
    const broken = await pollStatus(session, (entries) => {
      const entry = entries.find((candidate) => candidate.root === sdkRootDir);
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
      const entry = entries.find((candidate) => candidate.root === sdkRootDir);
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
    assert.equal(incompatibleEntry.compilerRoot, await realpath(incompatible));
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
      roots.some((entry) => entry.root === first && entry.state === "evicted"),
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
        entry.root === rootA && entry.state === "ready"),
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
      roots.some((entry) => entry.root === rootA && entry.workerPid === null),
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

const groups = [
  ["independent", testIndependentRoots, "independent roots"],
  ["folders", testFolderChanges, "folder changes"],
  ["discovery", testLazyDiscovery, "lazy discovery"],
  ["sdk", testSecondSdk, "second SDK"],
  ["sdk-errors", testRootScopedSdkErrors, "root-scoped SDK errors"],
  ["crash", testWorkerCrashAndOverlay, "crash and overlay replay"],
  ["cap", testCapAndIdleEviction, "worker cap and idle eviction"],
  ["cancel", testCancellation, "request cancellation"],
  ["overlays", testOverlayOwnership, "overlay ownership"]
];

async function main() {
  assert.ok(process.argv[2], "usage: node scripts/test-multi-root.mjs PATH-TO-SERVER [GROUP]");
  const only = process.argv[3];
  if (only !== undefined) {
    assert.ok(groups.some(([name]) => name === only),
      `unknown group ${only}; known groups: ${groups.map(([name]) => name).join(", ")}`);
  }
  for (const [name, run, label] of groups) {
    if (only !== undefined && only !== name) continue;
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

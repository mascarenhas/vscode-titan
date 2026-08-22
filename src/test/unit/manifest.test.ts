import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

const repositoryRoot = path.resolve(__dirname, "../../../..");

function readJson(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, relativePath), "utf8")
  ) as unknown;
}

describe("extension manifest", () => {
  test("registers Titan as a workspace language extension", () => {
    const manifest = readJson("package.json") as {
      activationEvents: string[];
      extensionKind: string[];
      main: string;
      contributes: {
        languages: Array<{
          id: string;
          extensions: string[];
          configuration: string;
        }>;
        grammars: Array<{
          language: string;
          scopeName: string;
          path: string;
        }>;
      };
    };

    assert.deepEqual(manifest.activationEvents, ["onLanguage:titan"]);
    assert.deepEqual(manifest.extensionKind, ["workspace"]);
    assert.equal(manifest.main, "./dist/extension.js");
    assert.deepEqual(manifest.contributes.languages, [{
      id: "titan",
      aliases: ["Titan", "titan"],
      extensions: [".titan"],
      configuration: "./language-configuration.json"
    }]);
    assert.deepEqual(manifest.contributes.grammars, [{
      language: "titan",
      scopeName: "source.titan",
      path: "./syntaxes/titan.tmLanguage.json"
    }]);
  });

  test("provides build, headless test, Extension Host, and package scripts", () => {
    const manifest = readJson("package.json") as {
      scripts: Record<string, string>;
    };

    for (const script of [
      "vscode:prepublish",
      "compile",
      "stage-notices",
      "test:unit",
      "test:vscode",
      "test",
      "package"
    ]) {
      assert.equal(typeof manifest.scripts[script], "string", script);
      assert.notEqual(manifest.scripts[script].length, 0, script);
    }
    assert.equal(manifest.scripts.package, "make package");
  });

  test("contributes a command that reveals language-server output", () => {
    const manifest = readJson("package.json") as {
      contributes: {
        commands: Array<{
          command: string;
          title: string;
          category: string;
        }>;
      };
    };

    assert.deepEqual(manifest.contributes.commands, [{
      command: "titan.showLanguageServerOutput",
      title: "Show Language Server Output",
      category: "Titan"
    }]);
  });

  test("contributes language-server observability and compiler settings", () => {
    const manifest = readJson("package.json") as {
      contributes: {
        configuration: {
          properties: Record<string, {
            type: string;
            default: unknown;
            scope: string;
            enum?: string[];
          }>;
        };
      };
    };
    const properties = manifest.contributes.configuration.properties;

    for (const setting of [
      "titan.languageServer.path",
      "titan.languageServer.arguments",
      "titan.languageServer.logLevel",
      "titan.compiler.luaPath",
      "titan.compiler.luaCPath"
    ]) {
      assert.ok(properties[setting], setting);
      assert.equal(properties[setting].scope, "machine-overridable", setting);
    }
    assert.equal(properties["titan.compiler.luaPath"].type, "string");
    assert.equal(properties["titan.compiler.luaPath"].default, "");
    assert.equal(properties["titan.compiler.luaCPath"].type, "string");
    assert.equal(properties["titan.compiler.luaCPath"].default, "");

    assert.deepEqual(properties["titan.languageServer.logLevel"].enum, [
      "off",
      "error",
      "info",
      "debug",
      "trace"
    ]);
    assert.equal(properties["titan.languageServer.logLevel"].default, "debug");

    assert.deepEqual(properties["titan.trace.server"].enum, [
      "off",
      "messages",
      "verbose"
    ]);
    assert.equal(properties["titan.trace.server"].default, "off");
    assert.equal(properties["titan.trace.server"].scope, "window");
  });

  test("points every contributed language asset at a checked-in file", () => {
    const manifest = readJson("package.json") as {
      contributes: {
        languages: Array<{ configuration: string }>;
        grammars: Array<{ path: string }>;
      };
    };
    const assets = [
      ...manifest.contributes.languages.map((language) => language.configuration),
      ...manifest.contributes.grammars.map((grammar) => grammar.path)
    ];

    for (const asset of assets) {
      assert.ok(existsSync(path.resolve(repositoryRoot, asset)), asset);
    }
  });

  test("keeps the actual-usage benchmark on one saved semantic target", () => {
    const benchmark = readFileSync(
      path.join(repositoryRoot, "scripts/benchmark-server.mjs"),
      "utf8"
    );
    const file = /const BENCHMARK_FILE = "([^"]+)";/.exec(benchmark)?.[1];
    const marker = /const BENCHMARK_MARKER = '([^']+)';/.exec(benchmark)?.[1];
    const symbol = /const BENCHMARK_SYMBOL = "([^"]+)";/.exec(benchmark)?.[1];
    assert.ok(file, "benchmark file constant is missing");
    assert.ok(marker, "benchmark marker constant is missing");
    assert.ok(symbol, "benchmark symbol constant is missing");
    assert.ok(marker.includes(symbol), "benchmark marker omits its symbol");

    const target = readFileSync(path.join(repositoryRoot, file), "utf8");
    assert.equal(
      target.split(marker).length - 1,
      1,
      "benchmark marker must identify exactly one saved source occurrence"
    );
  });
});

describe("Titan language configuration", () => {
  test("defines comments, pairs, words, and indentation", () => {
    const configuration = readJson("language-configuration.json") as {
      comments: { lineComment: string; blockComment: string[] };
      brackets: string[][];
      autoClosingPairs: Array<{ open: string; close: string }>;
      surroundingPairs: string[][];
      wordPattern: string;
      indentationRules: {
        increaseIndentPattern: string;
        decreaseIndentPattern: string;
      };
    };

    assert.equal(configuration.comments.lineComment, "--");
    assert.deepEqual(configuration.comments.blockComment, ["--[[", "]]"]);
    assert.deepEqual(configuration.brackets, [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"]
    ]);
    assert.ok(
      configuration.autoClosingPairs.some(
        (pair) => pair.open === "\"" && pair.close === "\""
      )
    );
    assert.ok(
      configuration.surroundingPairs.some(
        (pair) => pair[0] === "'" && pair[1] === "'"
      )
    );
    assert.doesNotThrow(() => new RegExp(configuration.wordPattern));
    assert.doesNotThrow(
      () => new RegExp(configuration.indentationRules.increaseIndentPattern)
    );
    assert.doesNotThrow(
      () => new RegExp(configuration.indentationRules.decreaseIndentPattern)
    );

    const increasesIndent = new RegExp(
      configuration.indentationRules.increaseIndentPattern
    );
    const decreasesIndent = new RegExp(
      configuration.indentationRules.decreaseIndentPattern
    );
    assert.match("local interface Reader", increasesIndent);
    assert.match("foreign function fs_realpath_cb(request: *uv_fs_t)", increasesIndent);
    assert.match("defer do", increasesIndent);
    assert.match("defer if not transferred then", increasesIndent);
    for (const deferredBlock of [
      "defer while pending do",
      "defer for index = 1, 3 do",
      "defer repeat",
      "defer case result"
    ]) {
      assert.match(deferredBlock, increasesIndent);
    }
    assert.doesNotMatch("defer cleanup()", increasesIndent);
    assert.match("else -- fallback", increasesIndent);
    assert.match("else -- fallback", decreasesIndent);
  });
});

describe("Codex plugin manifest", () => {
  test("exposes the supported skills-only Titan adapter", () => {
    const marketplace = readJson(".agents/plugins/marketplace.json") as {
      plugins: Array<Record<string, unknown> & {
        name: string;
        source: { source: string; path: string };
      }>;
    };
    const plugin = marketplace.plugins.find((entry) => entry.name === "titan-lsp");
    assert.ok(plugin);
    assert.deepEqual(Object.keys(plugin).sort(), [
      "category",
      "name",
      "policy",
      "source"
    ]);
    assert.deepEqual(plugin.source, {
      source: "local",
      path: "./plugins/titan-lsp"
    });

    const manifest = readJson(
      "plugins/titan-lsp/.codex-plugin/plugin.json"
    ) as { name: string; skills: string };
    assert.equal(manifest.name, "titan-lsp");
    assert.equal(manifest.skills, "./skills/");
    assert.ok(existsSync(path.join(
      repositoryRoot,
      "plugins/titan-lsp/skills/titan-lsp-query/SKILL.md"
    )));
    assert.ok(existsSync(path.join(
      repositoryRoot,
      "plugins/titan-lsp/skills/titan-lsp-query/scripts/titan-lsp-query.mjs"
    )));
    const skill = readFileSync(path.join(
      repositoryRoot,
      "plugins/titan-lsp/skills/titan-lsp-query/SKILL.md"
    ), "utf8");
    assert.match(skill, /sandbox_permissions: "require_escalated"/);
    assert.match(skill, /Do not retry inside the sandbox/);
    assert.match(skill, /does not authorize source\s+changes/);
  });
});

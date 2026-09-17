import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { before, describe, test } from "node:test";
import {
  INITIAL,
  IGrammar,
  IRawGrammar,
  Registry,
  StateStack,
  parseRawGrammar
} from "vscode-textmate";
import {
  OnigScanner,
  OnigString,
  loadWASM
} from "vscode-oniguruma";

const repositoryRoot = path.resolve(__dirname, "../../../..");
const grammarPath = path.join(
  repositoryRoot,
  "syntaxes",
  "titan.tmLanguage.json"
);

let grammar: IGrammar;

before(async () => {
  const wasmPath = require.resolve("vscode-oniguruma/release/onig.wasm");
  const wasm = readFileSync(wasmPath);
  await loadWASM(
    wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)
  );

  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner(patterns: string[]): OnigScanner {
        return new OnigScanner(patterns);
      },
      createOnigString(value: string): OnigString {
        return new OnigString(value);
      }
    }),
    loadGrammar: async (scopeName: string): Promise<IRawGrammar | null> => {
      if (scopeName !== "source.titan") {
        return null;
      }
      return parseRawGrammar(readFileSync(grammarPath, "utf8"), grammarPath);
    }
  });

  const loaded = await registry.loadGrammar("source.titan");
  assert.ok(loaded, "Titan grammar should load");
  grammar = loaded;
});

interface TokenizedLine {
  line: string;
  scopesAt(text: string): string[];
}

function tokenizeLines(lines: string[]): TokenizedLine[] {
  let stack: StateStack = INITIAL;
  return lines.map((line) => {
    const tokenized = grammar.tokenizeLine(line, stack);
    stack = tokenized.ruleStack;
    return {
      line,
      scopesAt(text: string): string[] {
        const index = line.indexOf(text);
        assert.notEqual(index, -1, `${JSON.stringify(text)} is absent from line`);
        const token = tokenized.tokens.find(
          (candidate) =>
            candidate.startIndex <= index && candidate.endIndex > index
        );
        assert.ok(token, `no token covers ${JSON.stringify(text)}`);
        return token.scopes;
      }
    };
  });
}

function assertScope(
  tokenizedLine: TokenizedLine,
  text: string,
  expectedScope: string
): void {
  assert.ok(
    tokenizedLine.scopesAt(text).includes(expectedScope),
    `${JSON.stringify(text)} should include ${expectedScope}`
  );
}

describe("Titan TextMate grammar", () => {
  test("recognizes declarations, primitive types, literals, and operators", () => {
    const [declaration, expression] = tokenizeLines([
      "local function render(value: integer?): string",
      "  return value as integer + 0x1.8p1"
    ]);

    assertScope(declaration, "local", "storage.modifier.titan");
    assertScope(declaration, "function", "storage.type.function.titan");
    assertScope(declaration, "render", "entity.name.function.titan");
    assertScope(declaration, "integer", "storage.type.primitive.titan");
    assertScope(expression, "return", "keyword.control.titan");
    assertScope(expression, "as", "keyword.operator.type.titan");
    assertScope(expression, "+", "keyword.operator.titan");
    assertScope(expression, "0x1.8p1", "constant.numeric.titan");
  });

  test("recognizes anonymous functions, local interfaces, and all hex floats", () => {
    const [lambda, declaration, number] = tokenizeLines([
      "local transform = function (value: integer): integer",
      "local interface Reader",
      "local fraction = 0x.8p+1"
    ]);

    assertScope(lambda, "function", "storage.type.function.titan");
    assertScope(declaration, "interface", "storage.type.declaration.titan");
    assertScope(declaration, "Reader", "entity.name.type.titan");
    assertScope(number, "0x.8p+1", "constant.numeric.titan");
  });

  test("marks the reserved non-syntax finally word as invalid", () => {
    const [line] = tokenizeLines(["finally"]);

    assertScope(line, "finally", "invalid.illegal.reserved.titan");
  });

  test("recognizes the builtin FFI namespace and nameless foreign imports", () => {
    const [directive, value, type, member, comment, string] = tokenizeLines([
      'foreign import "native.h"',
      "return ffi.native_value()",
      "local pointer: foreign *NativeType = nil",
      "return object.ffi",
      "-- ffi remains comment text",
      'local text = "ffi"'
    ]);

    assertScope(directive, "foreign", "storage.modifier.titan");
    assertScope(directive, "import", "keyword.control.import.titan");
    assertScope(directive, "native.h", "string.quoted.double.titan");
    assertScope(value, "ffi", "variable.language.ffi.titan");
    assertScope(type, "foreign", "storage.modifier.titan");
    assertScope(value, "native_value", "variable.other.member.titan");
    assertScope(type, "NativeType", "entity.name.type.titan");
    assertScope(member, "ffi", "variable.other.member.titan");
    assertScope(comment, "ffi", "comment.line.double-dash.titan");
    assertScope(string, "ffi", "string.quoted.double.titan");
  });

  test("recognizes generic delimiters, function types, and union arms", () => {
    const [generic, callable, arm, removed] = tokenizeLines([
      "local box = Box<|integer|>.new(1)",
      "type Transform = function (integer): string",
      "when some(item) then",
      "type Removed = (integer) -> string"
    ]);

    assertScope(generic, "<|", "punctuation.definition.typeparameters.begin.titan");
    assertScope(generic, "|>", "punctuation.definition.typeparameters.end.titan");
    assertScope(generic, "new", "variable.other.member.titan");
    assertScope(callable, "function", "storage.type.function.titan");
    assertScope(arm, "when", "keyword.control.titan");
    assertScope(arm, "some", "entity.name.tag.titan");
    assertScope(removed, "->", "invalid.illegal.operator.titan");
  });

  test("recognizes foreign type operations and current-module builtins", () => {
    const [allocation, callback, module, state] = tokenizeLines([
      "local bytes = foreign unsigned char.new_array(32)",
      "type Callback = function (foreign function (*void): void): ()",
      "return M.type",
      "return ffi.lua_gettop(L)"
    ]);

    assertScope(allocation, "unsigned char", "entity.name.type.titan");
    assertScope(allocation, "new_array", "variable.other.member.titan");
    assertScope(callback, "foreign", "storage.modifier.titan");
    assertScope(module, "M", "variable.language.module.titan");
    assertScope(module, "type", "variable.other.member.titan");
    assertScope(state, "L", "variable.language.lua-state.titan");
  });

  test("allows contextual type and builtin words as local bindings", () => {
    const [typeWord, builtin] = tokenizeLines([
      "local string = 1",
      "local const ffi: integer = 2"
    ]);

    assertScope(typeWord, "string", "variable.other.readwrite.titan");
    assertScope(builtin, "ffi", "variable.other.readwrite.titan");
    assertScope(builtin, "integer", "storage.type.primitive.titan");
  });

  test("keeps equals-delimited long comments and strings open across lines", () => {
    const comment = tokenizeLines([
      "--[=[ comment begins",
      "return false",
      "]=]"
    ]);
    const string = tokenizeLines([
      "local text = [==[",
      "not a keyword",
      "]==]"
    ]);

    assertScope(comment[1], "return", "comment.block.titan");
    assertScope(comment[1], "false", "comment.block.titan");
    assertScope(string[1], "not", "string.quoted.other.long.titan");
  });

  test("recognizes short strings, escapes, comments, and member names", () => {
    const [line, comment] = tokenizeLines([
      "local message = strings.rep(\"!\\n\", value)",
      "-- return is comment text"
    ]);

    assertScope(line, "strings", "source.titan");
    assertScope(line, ".rep", "punctuation.accessor.titan");
    assertScope(line, "rep", "variable.other.member.titan");
    assertScope(line, "\\n", "constant.character.escape.titan");
    assertScope(comment, "return", "comment.line.double-dash.titan");
  });

  test("keeps valid short-string physical-line escapes open", () => {
    const direct = tokenizeLines([
      'local direct = "before' + "\\",
      'return remains_text"',
      "return true"
    ]);
    const compact = tokenizeLines([
      "local compact = 'before\\z   ",
      "   ",
      "  return remains_text'",
      "return false"
    ]);

    assertScope(direct[0], "\\", "constant.character.escape.titan");
    assertScope(direct[1], "return", "string.quoted.double.titan");
    assertScope(direct[2], "return", "keyword.control.titan");
    assertScope(compact[0], "\\z", "constant.character.escape.titan");
    assertScope(compact[2], "return", "string.quoted.single.titan");
    assertScope(compact[3], "return", "keyword.control.titan");
  });

  test("tokenizes the representative Titan fixture without stalling", () => {
    const source = readFileSync(
      path.join(repositoryRoot, "test", "fixtures", "workspace", "sample.titan"),
      "utf8"
    );
    const lines = tokenizeLines(source.split(/\r?\n/));

    assert.equal(lines.length > 20, true);
    assertScope(lines.find((line) => line.line.includes("record Greeting"))!,
      "Greeting", "entity.name.type.titan");
    assertScope(lines.find((line) => line.line.includes("case result"))!,
      "case", "keyword.control.titan");
    assertScope(lines.find((line) => line.line.includes("0x1.8p1"))!,
      ".5", "constant.numeric.titan");
  });
});

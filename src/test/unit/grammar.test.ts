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

  test("recognizes multiple union parts, constructors, and both case forms", () => {
    const [declaration, parts, , positional, named, prefix, selected, empty] =
      tokenizeLines([
        "union Message",
        "  moved(x: integer, text: string, note: string?)",
        "end",
        'local first = Message.moved(1, "one")',
        'local second = Message.moved { text = "two", x = 2 }',
        "when moved(string) then",
        "when moved{body = text; x} then",
        "when moved{} then"
      ]);

    assertScope(declaration, "Message", "entity.name.type.titan");
    assertScope(parts, "moved", "entity.name.tag.titan");
    assertScope(parts, "x", "variable.parameter.titan");
    assertScope(named, "text", "variable.other.member.titan");
    assertScope(parts, "integer", "storage.type.primitive.titan");
    assertScope(parts, ",", "punctuation.separator.titan");
    assertScope(parts, "?", "keyword.operator.titan");
    for (const line of [positional, named]) {
      assertScope(line, "moved", "variable.other.member.titan");
    }
    for (const line of [prefix, selected, empty]) {
      assertScope(line, "when", "keyword.control.titan");
      assertScope(line, "moved", "entity.name.tag.titan");
      assertScope(line, "then", "keyword.control.titan");
    }
    assertScope(prefix, "string", "variable.other.readwrite.titan");
    assertScope(selected, "body", "variable.other.readwrite.titan");
    assertScope(selected, "text", "variable.other.member.titan");
    assertScope(selected, "x}", "variable.other.readwrite.titan");
    assertScope(selected, ";", "punctuation.separator.titan");
    assertScope(empty, "{", "punctuation.section.group.begin.titan");
    assertScope(empty, "}", "punctuation.section.group.end.titan");
  });

  test("scopes union variants and contextual part declarations without losing type scopes", () => {
    const lines = tokenizeLines([
      "local union Message<|T|>",
      "  moved(x: integer, end: integer)",
      "  local end(value: string, ffi: T)",
      "  plain(string) local(integer) local local(integer)",
      "  complex(callback: function (integer): (string, T),",
      "    items: Box<|function (T): T|>, lookup: {string: {T}},",
      "    -- end: integer remains a comment",
      "    note: string?)",
      "end",
      "function after(): integer",
      "  if true then return 1 end",
      "end"
    ]);

    assertScope(lines[0], "Message", "entity.name.type.titan");
    assertScope(lines[0], "<|", "punctuation.definition.typeparameters.begin.titan");
    for (const [index, variant] of [[1, "moved"], [2, "end"], [3, "plain"], [4, "complex"]] as const) {
      assertScope(lines[index], variant, "entity.name.tag.titan");
    }
    for (const [index, part] of [[1, "x"], [1, "end"], [2, "value"], [2, "ffi"],
      [4, "callback"], [5, "items"], [5, "lookup"], [7, "note"]] as const) {
      assertScope(lines[index], part, "variable.parameter.titan");
      assert.ok(!lines[index].scopesAt(part).includes("keyword.control.titan"));
    }
    assertScope(lines[2], "local", "storage.modifier.titan");
    assertScope(lines[3], "string", "storage.type.primitive.titan");
    assertScope(lines[3], "local(integer)", "entity.name.tag.titan");
    assertScope(lines[3], "local local", "storage.modifier.titan");
    assertScope(lines[4], "function", "storage.type.function.titan");
    assertScope(lines[4], "integer", "storage.type.primitive.titan");
    assertScope(lines[5], "string", "storage.type.primitive.titan");
    assert.ok(!lines[5].scopesAt("string").includes("variable.parameter.titan"));
    assertScope(lines[6], "end", "comment.line.double-dash.titan");
    assertScope(lines[7], "string", "storage.type.primitive.titan");
    assertScope(lines[8], "end", "keyword.control.titan");
    assertScope(lines[9], "after", "entity.name.function.titan");
    assertScope(lines[10], "if", "keyword.control.titan");
    assertScope(lines[10], "end", "keyword.control.titan");
  });

  test("scopes named constructor labels while preserving nested expressions and comments", () => {
    const lines = tokenizeLines([
      "local packet = Message<|integer|>.moved { end = 4,",
      "  x = other.end,",
      "  value = Other.part { end = nested(5, 6), value = {7, 8} },",
      '  text = "end = 6", -- end = 7',
      "  flag = value == other,",
      "  callback = function (): integer",
      "    local count = 0; count = 1; if true then return count end",
      "  end",
      "}",
      "return Message.moved(1, 2)"
    ]);

    for (const [index, label] of [[0, "end"], [1, "x"], [2, "value"], [2, "end"],
      [3, "text"], [4, "flag"], [5, "callback"]] as const) {
      assertScope(lines[index], label, "variable.other.member.titan");
      assert.ok(!lines[index].scopesAt(label).includes("keyword.control.titan"));
    }
    assertScope(lines[1], "end", "variable.other.member.titan");
    assertScope(lines[3], "end = 6", "string.quoted.double.titan");
    assertScope(lines[3], "end = 7", "comment.line.double-dash.titan");
    assertScope(lines[4], "value", "storage.type.primitive.titan");
    assert.ok(!lines[4].scopesAt("value").includes("variable.other.member.titan"));
    assertScope(lines[4], "==", "keyword.operator.titan");
    assertScope(lines[5], "function", "storage.type.function.titan");
    assertScope(lines[6], "if", "keyword.control.titan");
    assert.ok(!lines[6].scopesAt("count = 1").includes("variable.other.member.titan"));
    assertScope(lines[7], "end", "keyword.control.titan");
    assertScope(lines[9], "return", "keyword.control.titan");
    assertScope(lines[9], "moved", "variable.other.member.titan");
  });

  test("preserves long strings, function types, and assignments in named values", () => {
    const lines = tokenizeLines([
      "type Callbacks = { function(integer): integer }",
      "local data = Event.some { value = [[end, label = 2]], end = 3 }",
      "local callback = Event.some { callback = function(op: function(integer): integer): integer",
      "  local count = 0; count = 1",
      "  return op(count)",
      "end, end = 3 }",
      "local after = 0",
      "after = 2",
      "if after == 2 then return object.end() end"
    ]);
    assertScope(lines[0], "integer", "storage.type.primitive.titan");
    assertScope(lines[1], "end, label", "string.quoted.other.long.titan");
    assertScope(lines[1], "end = 3", "variable.other.member.titan");
    assertScope(lines[2], "integer", "storage.type.primitive.titan");
    assert.ok(!lines[3].scopesAt("count = 1").includes("variable.other.member.titan"));
    assertScope(lines[4], "return", "keyword.control.titan");
    assertScope(lines[5], "end,", "keyword.control.titan");
    assertScope(lines[5], "end =", "variable.other.member.titan");
    assertScope(lines[6], "after", "variable.other.readwrite.titan");
    assert.ok(!lines[7].scopesAt("after").includes("variable.other.member.titan"));
    assertScope(lines[8], "if", "keyword.control.titan");
    assertScope(lines[8], "end()", "variable.other.member.titan");
  });

  test("keeps function-type annotations out of constructor function bodies", () => {
    for (const source of [
      "Event.some { callback = function():integer local x: string? return 1 end, end = 3 }",
      "Event.some { callback = (f as function(integer):integer), end = 3 }",
      "Event.some { callback = Box<|function(integer):integer|>.new(add), end = 3 }",
      "Event.some { callback = function():integer local x: integer, cb: function():integer = 1, add; return cb() end, end = 3 }",
      "Event.some { callback = function(): integer local f: function(integer):integer = add; return f(1) end, end = 3 }",
      "Event.some { callback = function(): function(integer):integer return add end, end = 3 }",
      "Event.some { callback = function(): integer local f = add as function(integer):integer; return f(1) end, end = 3 }",
      "Event.some { callback = function -- comment\n(op: function(integer):integer):integer return op(1) end, end = 3 }",
      "Event.some { callback = function\n(op: function(integer):integer):integer return op(1) end, end = 3 }"
    ]) {
      const lines = tokenizeLines(source.split("\n"));
      assertScope(lines[lines.length - 1], "end = 3", "variable.other.member.titan");
    }
    const [type, array, nested, value] = tokenizeLines([
      "type Callbacks = { function(function(integer):integer):integer }",
      "local callbacks = { function():integer local x = 1; x = 2; return x end }",
      "local nested = Event.some { callback = function():integer local function helper():integer return 1 end return helper() end, end = 3 }",
      "local message = Event.some { end = 3 }"
    ]);
    assertScope(type, "integer", "storage.type.primitive.titan");
    assert.ok(!array.scopesAt("x = 2").includes("variable.other.member.titan"));
    assertScope(nested, "helper", "entity.name.function.titan");
    assertScope(nested, "end = 3", "variable.other.member.titan");
    assertScope(value, "end = 3", "variable.other.member.titan");
  });

  test("keeps contextual method names distinct from nested control blocks", () => {
    const [loop] = tokenizeLines([
      "Event.some { callback = function():integer for i: integer = 1, 2 do end for k: integer, v: string in next, ctx do end return 1 end, end = 3 }"
    ]);
    assertScope(loop, "integer =", "storage.type.primitive.titan");
    assertScope(loop, "integer,", "storage.type.primitive.titan");
    assertScope(loop, "string", "storage.type.primitive.titan");
    assertScope(loop, "end = 3", "variable.other.member.titan");
    const [locals] = tokenizeLines([
      "Event.some { callback = function():integer local x: integer, cb: function():integer = 1, add; return cb() end, end = 3 }"
    ]);
    assertScope(locals, "function():integer =", "storage.type.function.titan");
    assertScope(locals, "end = 3", "variable.other.member.titan");
    const [callbackLoop] = tokenizeLines([
      "Event.some { callback = function():integer for index: integer, cb: function(): integer in callbacks do cb() end return 1 end, end = 3 }"
    ]);
    assertScope(callbackLoop, "function(): integer in", "storage.type.function.titan");
    assertScope(callbackLoop, "end = 3", "variable.other.member.titan");
    for (const receiver of ["obj", "obj.field", "(obj)", "items[1]"]) {
      const [line] = tokenizeLines([
        `Event.some { value = ${receiver}:for(), text = ${receiver}:do(), callback = function():integer ${receiver}:end(); return 1 end, end = 3 }`
      ]);
      assertScope(line, "for()", "variable.other.member.titan");
      assertScope(line, "do()", "variable.other.member.titan");
      assertScope(line, "end()", "variable.other.member.titan");
      assertScope(line, "integer", "storage.type.primitive.titan");
      assertScope(line, "return", "keyword.control.titan");
      assertScope(line, "end = 3", "variable.other.member.titan");
    }
  });

  test("keeps named case aliases distinct from keyword parts across lines", () => {
    const [head, comment, aliases, end, body] = tokenizeLines([
      "when end {",
      "  -- return is comment text",
      "  finish = end; string = value, ffi",
      "} then",
      "return string"
    ]);

    assertScope(head, "end", "entity.name.tag.titan");
    assertScope(comment, "return", "comment.line.double-dash.titan");
    for (const name of ["finish", "string", "ffi"]) {
      assertScope(aliases, name, "variable.other.readwrite.titan");
    }
    for (const name of ["end", "value"]) {
      assertScope(aliases, name, "variable.other.member.titan");
    }
    assertScope(end, "then", "keyword.control.titan");
    assertScope(body, "return", "keyword.control.titan");

    const [splitAlias, splitPart, closed] = tokenizeLines([
      "when moved{finish = -- selected part follows",
      "end",
      "} then"
    ]);
    assertScope(splitAlias, "finish", "variable.other.readwrite.titan");
    assertScope(splitAlias, "selected", "comment.line.double-dash.titan");
    assertScope(splitPart, "end", "variable.other.member.titan");
    assertScope(closed, "then", "keyword.control.titan");
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
    assertScope(lines.find((line) => line.line.includes("when moved{"))!,
      "moved", "entity.name.tag.titan");
  });
});

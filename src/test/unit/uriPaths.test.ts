import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeWorkspaceUriPath } from "../../extension/uriPaths";

function file(path: string, authority = "") {
  return { scheme: "file", authority, path };
}

for (const drive of ["C", "c"]) {
  const alternate = drive === "C" ? "c" : "C";
  test(`matches initialize and folder URIs with a ${drive}: lexical root`, () => {
    const folder = file(`/${drive}:/Work/Link`);
    // vscode-languageclient passes both the original folder URI and a URI
    // rebuilt from fsPath through the same converter.
    assert.equal(relativeWorkspaceUriPath(folder, folder, "win32"), "");
    assert.equal(relativeWorkspaceUriPath(
      folder, file(`/${alternate}:/Work/Link`), "win32"
    ), "");
  });

  test(`preserves the document suffix in both mappings for a ${drive}: root`, () => {
    const lexicalRoot = file(`/${drive}:/Work/Link`);
    const physicalRoot = file(`/${drive}:/Data/Physical`);
    assert.equal(relativeWorkspaceUriPath(
      lexicalRoot, file(`/${alternate}:/Work/Link/src/My File.titan`), "win32"
    ), "src/My File.titan");
    assert.equal(relativeWorkspaceUriPath(
      physicalRoot, file(`/${alternate}:/Data/Physical/src/My File.titan`), "win32"
    ), "src/My File.titan");
  });
}

test("only normalizes a Windows local drive letter, never a suffix", () => {
  const root = file("/C:/Work/Link");
  assert.equal(relativeWorkspaceUriPath(root, file("/c:/work/Link/a.titan"), "win32"),
    undefined);
  assert.equal(relativeWorkspaceUriPath(root, file("/c:/Work/Linked/a.titan"), "win32"),
    undefined);
  assert.equal(relativeWorkspaceUriPath(root, file("/D:/Work/Link/a.titan"), "win32"),
    undefined);
  assert.equal(relativeWorkspaceUriPath(root, file("/c:/Work/Link/a.titan"), "linux"),
    undefined);
  assert.equal(relativeWorkspaceUriPath(
    file(root.path, "server"), file("/c:/Work/Link/a.titan", "server"), "win32"
  ), undefined);
  assert.equal(relativeWorkspaceUriPath(root, file(root.path, "server"), "win32"),
    undefined);
  const remote = { ...root, scheme: "vscode-remote", authority: "ssh-remote+host" };
  assert.equal(relativeWorkspaceUriPath(
    remote, { ...remote, path: "/c:/Work/Link/a.titan" }, "win32"
  ), undefined);
});

test("distinguishes a drive root itself from its descendants", () => {
  assert.equal(relativeWorkspaceUriPath(file("/c:/"), file("/C:/"), "win32"), "");
  assert.equal(relativeWorkspaceUriPath(file("/c:/"), file("/C:/Work"), "win32"),
    "Work");
});

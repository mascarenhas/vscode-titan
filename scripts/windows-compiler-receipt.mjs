import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export const receiptPath = "share/titan/0.6/compiler-dependencies.tsv";
const header = "source_name\tsource_version\tsource_sha256\tartifact_path\tartifact_sha256\tnotice_path\tnotice_sha256";
export const compilerDependencies = [
  ["lpeglabel", "1.6.2-1", "5511d2704de4580c5b79b100c2daec5e773db58be9c2239e49ea2d9da2decf67", "lib/lua/5.5/lpeglabel.dll"],
  ["lpeglabel", "1.6.2-1", "5511d2704de4580c5b79b100c2daec5e773db58be9c2239e49ea2d9da2decf67", "share/lua/5.5/relabel.lua"],
  ["luafilesystem", "1.9.0", "1142c1876e999b3e28d1c236bf21ffd9b023018e336ac25120fb5373aade1450", "lib/lua/5.5/lfs.dll"],
  ["inspect", "3.1.3", "43386a613f9916186af4919f36392d8b8dad8c4428a5f8c85ebac80acba71eeb", "share/lua/5.5/inspect.lua"],
  ["argparse", "0.7.2", "d2ae8066939420957bb6d580c6a6b8176c4f05419eca318e48d90a670fe2f59e", "share/lua/5.5/argparse.lua"]
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseCompilerReceipt(text) {
  assert(!text.includes("\r") && text.endsWith("\n"), "compiler receipt must use LF-terminated records");
  const [actualHeader, ...lines] = text.slice(0, -1).split("\n");
  assert.equal(actualHeader, header, "unknown compiler dependency receipt schema");
  assert.equal(lines.length, compilerDependencies.length, "compiler dependency receipt must contain exactly five artifacts");
  const rows = lines.map((line) => {
    const fields = line.split("\t");
    assert.equal(fields.length, 7, "invalid compiler dependency record");
    const [name, version, sourceHash, artifact, artifactHash, notice, noticeHash] = fields;
    const expected = compilerDependencies.find((entry) => entry[3] === artifact);
    assert(expected, `unexpected compiler artifact ${artifact}`);
    assert.deepEqual([name, version, sourceHash, artifact], expected, `compiler source identity mismatch for ${artifact}`);
    assert.equal(notice, `share/titan/0.6/licenses/${name}.txt`, "unexpected compiler notice path");
    assert(/^[a-f0-9]{64}$/.test(artifactHash) && /^[a-f0-9]{64}$/.test(noticeHash), "invalid artifact or notice SHA256");
    return { name, version, sourceHash, artifact, artifactHash, notice, noticeHash };
  });
  assert.equal(new Set(rows.map((row) => row.artifact)).size, rows.length, "duplicate compiler artifact");
  return rows;
}

export async function verifyCompilerReceipt(sdk) {
  const text = await readFile(path.join(sdk, receiptPath), "utf8");
  const rows = parseCompilerReceipt(text);
  for (const row of rows) {
    for (const [relative, expected] of [[row.artifact, row.artifactHash], [row.notice, row.noticeHash]]) {
      const filename = path.join(sdk, relative);
      assert((await lstat(filename)).isFile(), `compiler receipt requires a regular file: ${relative}`);
      assert.equal(sha256(await readFile(filename)), expected, `compiler receipt hash mismatch: ${relative}`);
    }
  }
  return rows;
}

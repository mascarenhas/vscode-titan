import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compilerDependencies, parseCompilerReceipt, receiptPath, verifyCompilerReceipt } from "./windows-compiler-receipt.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");
const header = "source_name\tsource_version\tsource_sha256\tartifact_path\tartifact_sha256\tnotice_path\tnotice_sha256\n";
const receipt = header + compilerDependencies.map(([name, version, source, artifact]) =>
  [name, version, source, artifact, digest(artifact), `share/titan/0.6/licenses/${name}.txt`, digest(name)].join("\t")
).join("\n") + "\n";

test("receipt rejects unknown sources, missing/duplicate artifacts, and escaped paths", () => {
  assert.equal(parseCompilerReceipt(receipt).length, 5);
  for (const malformed of [
    receipt.replace("1.6.2-1", "1.6.2"),
    receipt.replace(compilerDependencies[0][2], "0".repeat(64)),
    receipt.split("\n").slice(0, -2).join("\n") + "\n",
    receipt.replace("lib/lua/5.5/lfs.dll", "lib/lua/5.5/lpeglabel.dll"),
    receipt.replace("lib/lua/5.5/lfs.dll", "../lfs.dll"),
    receipt.replaceAll("\n", "\r\n")
  ]) assert.throws(() => parseCompilerReceipt(malformed));
});

test("receipt verifies actual artifact/notice bytes and rejects later tampering", async () => {
  const sdk = await mkdtemp(path.join(tmpdir(), "titan-receipt-"));
  async function put(relative, data) {
    const filename = path.join(sdk, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, data);
  }
  try {
    for (const [name, , , artifact] of compilerDependencies) {
      await put(artifact, artifact);
      await put(`share/titan/0.6/licenses/${name}.txt`, name);
    }
    await put(receiptPath, receipt);
    assert.equal((await verifyCompilerReceipt(sdk)).length, 5);
    await put("lib/lua/5.5/lfs.dll", "changed native artifact");
    await assert.rejects(verifyCompilerReceipt(sdk), /hash mismatch.*lfs.dll/);
    await put("lib/lua/5.5/lfs.dll", "lib/lua/5.5/lfs.dll");
    await put("share/titan/0.6/licenses/inspect.txt", "changed license");
    await assert.rejects(verifyCompilerReceipt(sdk), /hash mismatch.*inspect.txt/);
  } finally { await rm(sdk, { recursive: true, force: true }); }
});

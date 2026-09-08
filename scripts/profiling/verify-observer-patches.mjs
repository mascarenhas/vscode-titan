#!/usr/bin/env node
// Reconstructs affected files in /tmp from pinned Git objects. No builds,
// workloads, cache changes, or writes to the supplied repositories.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const patchDirectory = fileURLToPath(new URL('./patches/', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(patchDirectory, 'manifest.json'), 'utf8'));
const repositories = {};
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--help') {
    console.log('Usage: node verify-observer-patches.mjs --titan-repo PATH --server-repo PATH');
    process.exit(0);
  }
  assert.ok(argument === '--titan-repo' || argument === '--server-repo', `Unknown argument: ${argument}`);
  const value = process.argv[++index];
  assert.ok(value && !value.startsWith('--'), `${argument} needs a path`);
  repositories[argument === '--titan-repo' ? 'titan' : 'vscode-titan'] = path.resolve(value);
}
for (const name of ['titan', 'vscode-titan']) assert.ok(repositories[name], `Missing repository path for ${name}`);
assert.equal(manifest.schema_version, 1);
assert.equal(manifest.hash_algorithm, 'sha256');

function git(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
function safeRelative(filename) {
  assert.ok(filename && !path.isAbsolute(filename) && !filename.split('/').some(part => part === '..' || part === ''), `Unsafe path: ${filename}`);
  return filename;
}
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function snapshot(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assert.ok(stat.isFile(), `Expected regular file: ${filename}`);
  const bytes = fs.readFileSync(filename);
  return { sha256: digest(bytes), bytes: bytes.length, mode: (stat.mode & 0o777).toString(8).padStart(4, '0') };
}
function inventory(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return inventory(path.join(directory, entry.name), relative + '/');
    assert.ok(entry.isFile(), `Unexpected non-regular file: ${relative}`);
    return [relative];
  }).sort();
}

const results = [];
for (const spec of manifest.repositories) {
  const repository = repositories[spec.repository];
  assert.ok(repository, `Unsupported repository in manifest: ${spec.repository}`);
  assert.match(spec.base_commit, /^[a-f0-9]{40}$/);
  const patchFile = path.join(patchDirectory, safeRelative(spec.patch));
  const patchBytes = fs.readFileSync(patchFile);
  assert.equal(digest(patchBytes), spec.patch_sha256, `${spec.repository} patch hash`);
  assert.equal(patchBytes.length, spec.patch_bytes, `${spec.repository} patch bytes`);
  const filenames = spec.files.map(file => safeRelative(file.path));
  assert.equal(new Set(filenames).size, filenames.length, 'Manifest contains duplicate paths');
  const before = new Map(filenames.map(filename => [filename, snapshot(path.join(repository, filename))]));
  const scratch = fs.mkdtempSync(`/tmp/${spec.repository}-observer-replay-`);
  try {
    for (const file of spec.files) {
      if (!file.original) {
        assert.equal(file.status, 'added');
        assert.equal(git(repository, ['ls-tree', spec.base_commit, '--', file.path]).length, 0, `${file.path} should be absent at base`);
        continue;
      }
      assert.equal(file.status, 'modified');
      const object = git(repository, ['show', `${spec.base_commit}:${file.path}`]);
      const tree = git(repository, ['ls-tree', spec.base_commit, '--', file.path]).toString();
      assert.ok(tree.startsWith(`100${file.original.mode.slice(1)} blob `), `${file.path} base mode`);
      assert.equal(digest(object), file.original.sha256, `${file.path} base hash`);
      assert.equal(object.length, file.original.bytes, `${file.path} base bytes`);
      const destination = path.join(scratch, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, object);
      fs.chmodSync(destination, Number.parseInt(file.original.mode, 8));
    }
    git(scratch, ['apply', '--check', '--whitespace=error-all', patchFile]);
    git(scratch, ['apply', '--whitespace=error-all', patchFile]);
    assert.deepEqual(inventory(scratch), [...filenames].sort(), `${spec.repository} exact result inventory`);
    for (const file of spec.files) assert.deepEqual(snapshot(path.join(scratch, file.path)), file.result, `${file.path} replay result`);
    results.push({ repository: spec.repository, base_commit: spec.base_commit, verified_files: spec.files.length,
      patch_sha256: spec.patch_sha256, apply_check: 'passed', result_hashes_modes_inventory: 'passed' });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    for (const filename of filenames) assert.deepEqual(snapshot(path.join(repository, filename)), before.get(filename), `${filename} original working file changed`);
  }
}
console.log(JSON.stringify({ passed: true, repositories: results, supplied_repositories_unchanged: true,
  compilers_or_workloads_executed: false }, null, 2));

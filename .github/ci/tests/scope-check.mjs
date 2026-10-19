import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsChecks, scope } from '../scope.mjs';

test('allowlist and mixed/shared/uncertain paths', () => {
  assert.equal(needsChecks(['docs/interface-map.md']), false);
  for (const path of ['src/server.ts', 'src/config.ts', 'README.md', 'CONTRIBUTING.md', '.github/workflows/ci.yml', 'scripts/clean.mjs', 'AGENTS.md', 'unknown', 'package.json', 'docs/new-contract.md']) {
    assert.equal(needsChecks(['docs/interface-map.md', path]), true, path);
  }
  assert.equal(needsChecks([]), true);
});
test('non-PR events and failed comparisons always run full', () => {
  for (const event of ['push', 'workflow_dispatch', 'merge_group', 'unknown']) assert.equal(scope(event, {}), true);
  assert.equal(scope('pull_request', {}), true);
  const event = { pull_request: {base: {sha: 'a'.repeat(40)}, head: {sha: 'b'.repeat(40)}}};
  assert.equal(scope('pull_request', event, () => {throw Error('missing history');}), true);
  assert.equal(scope('pull_request', event, () => Buffer.from('docs/interface-map.md')), true);
});
test('real git diffs include rename source, delete and multiple areas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monday-ci-'));
  const git = args => execFileSync('git', args, {cwd: dir});
  const commit = () => {git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']); return git(['rev-parse', 'HEAD']).toString().trim();};
  try {
    git(['init', '-q']); mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'src/a'), 'shared'); writeFileSync(join(dir, 'docs/interface-map.md'), 'docs');
    const base = commit();
    rmSync(join(dir, 'docs/interface-map.md'));
    renameSync(join(dir, 'src/a'), join(dir, 'docs/interface-map.md'));
    let head = commit();
    const check = () => scope('pull_request', {pull_request: {base: {sha: base}, head: {sha: head}}}, git);
    assert.equal(check(), true);
    git(['reset', '--hard', base]); renameSync(join(dir, 'docs/interface-map.md'), join(dir, 'src/from-docs')); head = commit(); assert.equal(check(), true);
    git(['reset', '--hard', base]); rmSync(join(dir, 'src/a')); head = commit(); assert.equal(check(), true);
    git(['reset', '--hard', base]); rmSync(join(dir, 'docs/interface-map.md')); head = commit(); assert.equal(check(), false);
    writeFileSync(join(dir, 'src/b'), 'shared'); head = commit(); assert.equal(check(), true);
  } finally {rmSync(dir, {recursive:true, force:true});}
});

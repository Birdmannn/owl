import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('../scripts/install-pilot.mjs', import.meta.url));

test('installer rejects incompatible apps before mutating files or installing dependencies', async (t) => {
  for (const [name, manifest, lock, expected] of [
    ['React 18', { dependencies: { react: '^18.0.0' } }, '', /requires React 19/],
    ['CCC override', { overrides: { '@ckb-ccc/core': '1.19.1' } }, '', /already overrides/],
    ['other package manager', {}, 'pnpm-lock.yaml', /uses npm/],
    ['Pilot checkout as app', { name: '@owl/pilot' }, '', /not the Pilot repository/],
  ] as const) {
    await t.test(name, () => {
      const app = mkdtempSync(join(tmpdir(), 'pilot installer '));
      const original = JSON.stringify(manifest);
      try {
        writeFileSync(join(app, 'package.json'), original);
        if (lock) writeFileSync(join(app, lock), '');
        const result = spawnSync(process.execPath, [installer], { cwd: app, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, expected);
        assert.equal(readFileSync(join(app, 'package.json'), 'utf8'), original);
        assert.equal(existsSync(join(app, '.npmrc')), false);
        assert.equal(existsSync(join(app, 'node_modules')), false);
      } finally { rmSync(app, { recursive: true, force: true }); }
    });
  }
});

test('installer validates CLI arguments and shows help without requiring an app', () => {
  const result = spawnSync(process.execPath, [installer, '--help'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--source PATH/);
  assert.match(result.stdout, /Always installs the SDK, React 19 modal, and CCC wallet connector/);
  assert.doesNotMatch(result.stdout, /--react/);
  for (const args of [['--source'], ['--unknown']]) {
    const invalid = spawnSync(process.execPath, [installer, ...args], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /requires a path|Unknown option/);
  }
});

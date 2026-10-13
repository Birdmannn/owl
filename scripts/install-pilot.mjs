#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const usage = `Install Owl's Pilot into an existing npm app (Node.js 22+).

  node scripts/install-pilot.mjs --app /path/to/my-app
  # Or run the downloaded script from your app directory.

Options:
  --app PATH      App directory (default: current directory)
  --source PATH   Existing Pilot checkout (default: this checkout, or ../pilot)
  --help          Show this help

Always installs the SDK, React 19 modal, and CCC wallet connector.
If the default checkout is missing, it is cloned from GitHub. Existing
checkouts are rebuilt without pulling. Re-run after git pull to update.
`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal}). Fix the error above and re-run the installer.`);
}

function readPackage(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
}

function main() {
  let app = process.cwd();
  let source;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(usage); return; }
    if (arg === '--app' || arg === '--source') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path.`);
      if (arg === '--app') app = resolve(value);
      else source = resolve(value);
    } else throw new Error(`Unknown option: ${arg}. Use --help.`);
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Pilot requires Node.js 22 or newer.');
  app = resolve(app);
  if (!existsSync(join(app, 'package.json'))) throw new Error(`No package.json in ${app}. Run this from your existing app or pass --app PATH.`);
  const manifest = readPackage(app);
  if (manifest.name === '@owl/pilot') throw new Error('Run the installer from your app, not the Pilot repository, or pass --app PATH.');
  for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    if (existsSync(join(app, lock))) throw new Error(`This installer uses npm; ${lock} exists in your app. Use the manual integration guide for another package manager.`);
  }
  const override = manifest.overrides?.['@ckb-ccc/core'];
  if (override !== undefined && override !== '1.23.0') throw new Error('Your app already overrides @ckb-ccc/core. Pilot currently needs 1.23.0; resolve that override before installing.');
  for (const name of ['react', 'react-dom']) {
    const version = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
    if (version && !/^[~^]?19(?:\.|$)/.test(version)) throw new Error(`The Pilot modal requires React 19. Your ${name} dependency is ${version}; migrate it before installing Pilot.`);
  }
  const script = fileURLToPath(import.meta.url);
  source ??= script.endsWith('/scripts/install-pilot.mjs')
    ? resolve(dirname(script), '..') : resolve(app, '..', 'pilot');
  if (source === app) throw new Error('The Pilot checkout and your app must be different directories.');
  if (!existsSync(source)) {
    console.log(`Cloning Pilot into ${source}`);
    run('git', ['clone', 'https://github.com/Birdmannn/owl.git', source], dirname(source));
  }
  if (readPackage(source).name !== '@owl/pilot') throw new Error(`${source} is not a Pilot checkout. Use --source PATH.`);
  console.log(`Building Pilot from ${source}`);
  run('npm', ['ci'], source);
  run('npm', ['run', 'build'], source);
  run('npm', ['ci', '--prefix', 'packages/react'], source);
  run('npm', ['run', 'build', '--prefix', 'packages/react'], source);
  console.log(`Installing SDK, React modal, and wallet connector into ${app}`);
  // Setting both entries together avoids npm's EOVERRIDE check on a stale direct dependency.
  const coreSettings = ['dependencies.@ckb-ccc/core=1.23.0', 'overrides.@ckb-ccc/core=1.23.0'];
  if (manifest.devDependencies?.['@ckb-ccc/core']) coreSettings.push('devDependencies.@ckb-ccc/core=1.23.0');
  run('npm', ['pkg', 'set', ...coreSettings], app);
  run('npm', ['config', 'set', 'install-links', 'true', '--location=project'], app);
  const packages = [source, join(source, 'packages/react'), '@ckb-ccc/connector-react@1.1.9', 'react@^19', 'react-dom@^19'];
  run('npm', ['install', '--install-links', ...packages], app);
  console.log(`\nPilot installed. Import from '@owl/pilot' and '@owl/pilot-react'.
Keep the checkout at ${source} available for future installs and CI.
Next: configure your registry URL and wire the SDK into your app.
Docs: https://github.com/Birdmannn/owl (apps/docs)`);
}

try { main(); }
catch (error) { console.error(`Pilot installer: ${error.message}`); process.exitCode = 1; }

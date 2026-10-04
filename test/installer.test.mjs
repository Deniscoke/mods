import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installMods, validateManifest, checkedUrl, checkGameDirectory, detectForge } from '../lib/installer.mjs';

const bytes = Buffer.from('PK-test-fixture-version-one');
const mod = { name: 'Test Mod', version: '1.0.0', filename: 'test-1.0.0.jar', size: bytes.length,
  sha512: createHash('sha512').update(bytes).digest('hex'), url: 'https://cdn.modrinth.com/data/example.jar' };
const manifest = { schema: 1, minecraft: '1.20.1', mods: [mod] };
const download = async (m, dest) => fs.writeFile(dest, bytes);
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rpg-installer-test-'));
  t.after(async () => {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('rpg-installer-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'minecraft');
  await fs.mkdir(path.join(root, 'versions', 'Forge-test'), { recursive: true });
  await fs.writeFile(path.join(root, 'versions', 'Forge-test', 'Forge-test.json'), JSON.stringify({
    libraries: [{ name: 'net.minecraftforge:fmlloader:1.20.1-47.4.26' }],
    arguments: { game: ['--fml.forgeVersion', '47.4.26', '--fml.mcVersion', '1.20.1'] }
  }));
  await fs.mkdir(path.join(root, 'mods'));
  await fs.writeFile(path.join(root, 'mods', 'old-mod.jar'), 'old-mod-content');
  await fs.mkdir(path.join(root, 'saves', 'MyWorld'), { recursive: true });
  await fs.writeFile(path.join(root, 'saves', 'MyWorld', 'level.dat'), 'world-content');
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config', 'my.cfg'), 'original-config');
  return { root, temp };
}

test('install preserves original mods, worlds and configs; repeat is a no-op', async t => {
  const { root } = await fixture(t);
  const result = await installMods({ gameDir: root, manifest, download });
  assert.equal(await fs.readFile(path.join(result.backup, 'old-mod.jar'), 'utf8'), 'old-mod-content');
  assert.deepEqual(await fs.readFile(path.join(root, 'mods', mod.filename)), bytes);
  assert.equal(await fs.readFile(path.join(root, 'saves', 'MyWorld', 'level.dat'), 'utf8'), 'world-content');
  assert.equal(await fs.readFile(path.join(root, 'config', 'my.cfg'), 'utf8'), 'original-config');
  const repeated = await installMods({ gameDir: root, manifest, download: () => { throw new Error('must not download again'); } });
  assert.equal(repeated.unchanged, true);
  assert.equal((await fs.readdir(root)).some(x => x.startsWith('.rpg-')), false);
});

test('corrupt download never replaces old mods', async t => {
  const { root } = await fixture(t);
  await assert.rejects(installMods({ gameDir: root, manifest, download: async (m, dest) => fs.writeFile(dest, 'corrupt') }), /SHA-512/);
  assert.equal(await fs.readFile(path.join(root, 'mods', 'old-mod.jar'), 'utf8'), 'old-mod-content');
  assert.equal((await fs.readdir(root)).some(x => x.startsWith('.rpg-')), false);
});

test('network failure leaves original mods untouched', async t => {
  const { root } = await fixture(t);
  await assert.rejects(installMods({ gameDir: root, manifest, download: async () => { throw new Error('offline'); } }), /offline/);
  assert.deepEqual(await fs.readdir(path.join(root, 'mods')), ['old-mod.jar']);
});

test('failed final rename restores original mods', async t => {
  const { root } = await fixture(t);
  let calls = 0;
  const rename = async (from, to) => {
    if (++calls === 2) throw new Error('simulated locked destination');
    await fs.rename(from, to);
  };
  await assert.rejects(installMods({ gameDir: root, manifest, download, rename }), /locked destination/);
  assert.equal(calls, 3);
  assert.equal(await fs.readFile(path.join(root, 'mods', 'old-mod.jar'), 'utf8'), 'old-mod-content');
});

test('failed rollback keeps backup and prepared files for manual recovery', async t => {
  const { root } = await fixture(t);
  let calls = 0;
  const rename = async (from, to) => {
    if (++calls >= 2) throw new Error('locked');
    await fs.rename(from, to);
  };
  await assert.rejects(installMods({ gameDir: root, manifest, download, rename }), /Povodne mody su zachovane/);
  const backups = await fs.readdir(path.join(root, 'rpg-mod-backups'));
  assert.equal(await fs.readFile(path.join(root, 'rpg-mod-backups', backups[0], 'mods', 'old-mod.jar'), 'utf8'), 'old-mod-content');
  const stage = (await fs.readdir(root)).find(x => x.startsWith('.rpg-stage-'));
  assert.deepEqual(await fs.readFile(path.join(root, stage, 'mods', mod.filename)), bytes);
});

test('concurrent installer lock is respected and not removed', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, '.rpg-mod-setup.lock'), 'other-installer');
  await assert.rejects(installMods({ gameDir: root, manifest, download }), /zamok/);
  assert.equal(await fs.readFile(path.join(root, '.rpg-mod-setup.lock'), 'utf8'), 'other-installer');
});

test('mods junction is rejected without altering its destination', async t => {
  const { root, temp } = await fixture(t);
  await fs.rename(path.join(root, 'mods'), path.join(root, 'original-mods'));
  const external = path.join(temp, 'external');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'untouched.txt'), 'untouched');
  await fs.symlink(external, path.join(root, 'mods'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(checkGameDirectory(root), /nie odkaz/);
  assert.equal(await fs.readFile(path.join(external, 'untouched.txt'), 'utf8'), 'untouched');
});

test('manifest cannot name paths or download from unapproved hosts', () => {
  for (const filename of ['../a.jar', '..\\a.jar', 'C:a.jar', 'a.jar:stream', 'test..jar']) {
    assert.throws(() => validateManifest({ ...manifest, mods: [{ ...mod, filename }] }), /nazov/);
  }
  for (const url of ['http://cdn.modrinth.com/test', 'https://evil.test/test', 'https://cdn.modrinth.com.evil.test/test', 'https://user:pass@cdn.modrinth.com/test']) {
    assert.throws(() => checkedUrl(url), /Nepovoleny/);
  }
  assert.throws(() => validateManifest({ ...manifest, mods: [mod, { ...mod, filename: mod.filename.toUpperCase() }] }), /nazov/);
});

test('Forge loader detection excludes old builds and NeoForge', async t => {
  const { root } = await fixture(t);
  assert.equal((await detectForge(root))[0].compatible, true);
  await fs.writeFile(path.join(root, 'versions', 'Forge-test', 'Forge-test.json'), JSON.stringify({ libraries: [
    { name: 'net.minecraftforge:forge:1.20.1-47.1.26:universal' },
    { name: 'net.neoforged:forge:1.20.1-47.1.26:universal' }
  ] }));
  const profiles = await detectForge(root);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].compatible, false);
});

test('CLI dry-run never changes files or downloads', async t => {
  const { root } = await fixture(t);
  const before = await fs.readdir(root);
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('bin/setup.mjs'), '--game-dir', root, '--dry-run']);
  assert.match(stdout, /Nic sa nestahovalo ani nemenilo/);
  assert.deepEqual(await fs.readdir(root), before);
  assert.equal(await fs.readFile(path.join(root, 'mods', 'old-mod.jar'), 'utf8'), 'old-mod-content');
});

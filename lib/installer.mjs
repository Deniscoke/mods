import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const hosts = new Set(['cdn.modrinth.com', 'edge.forgecdn.net', 'mediafilez.forgecdn.net']);
export function checkedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error(`Nepovoleny zdroj stahovania: ${url.hostname}`);
  }
  return url;
}

export function validateManifest(manifest) {
  if (manifest.schema !== 1 || manifest.minecraft !== '1.20.1' || !Array.isArray(manifest.mods) || !manifest.mods.length) {
    throw new Error('Neplatny zoznam modov.');
  }
  const seen = new Set();
  for (const mod of manifest.mods) {
    if (!/^[a-zA-Z0-9_+.,() -]+\.jar$/.test(mod.filename) || mod.filename.includes('..') || seen.has(mod.filename.toLowerCase())) {
      throw new Error(`Neplatny alebo duplicitny nazov modu: ${mod.filename}`);
    }
    seen.add(mod.filename.toLowerCase());
    if (!/^[a-f0-9]{128}$/.test(mod.sha512) || !Number.isSafeInteger(mod.size) || mod.size < 4 || mod.size > 250 * 1024 * 1024) {
      throw new Error(`Neplatny kontrolny sucet/velkost: ${mod.filename}`);
    }
    checkedUrl(mod.url);
  }
}

async function statOrNull(file) {
  try { return await fs.lstat(file); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function regularDirectory(file, required = false) {
  const stat = await statOrNull(file);
  if (!stat && !required) return false;
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Ocakavany skutocny priecinok (nie odkaz): ${file}`);
  }
  return true;
}

export async function checkGameDirectory(input) {
  const requested = path.resolve(input);
  await regularDirectory(requested, true);
  const root = await fs.realpath(requested);
  await regularDirectory(path.join(root, 'versions'), true);
  await regularDirectory(path.join(root, 'mods'));
  await regularDirectory(path.join(root, 'rpg-mod-backups'));
  return root;
}

export async function detectForge(root, minimum = '47.4.0') {
  const profiles = [];
  for (const entry of await fs.readdir(path.join(root, 'versions'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const filename = path.join(root, 'versions', entry.name, `${entry.name}.json`);
    const stat = await statOrNull(filename);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) continue;
    let profile;
    try { profile = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { continue; }
    const versions = new Set();
    for (const library of profile.libraries ?? []) {
      // TLauncher profiles commonly contain fmlloader/fmlearlydisplay instead
      // of the older net.minecraftforge:forge library.
      const match = /^net\.minecraftforge:(?:forge|fmlloader|fmlearlydisplay):1\.20\.1-(47\.\d+\.\d+)(?::|$)/.exec(library.name ?? '');
      if (match) versions.add(match[1]);
    }
    const gameArguments = profile.arguments?.game ?? [];
    const values = gameArguments.flatMap(argument => {
      if (typeof argument === 'string') return [argument];
      if (Array.isArray(argument?.value)) return argument.value.filter(value => typeof value === 'string');
      return typeof argument?.value === 'string' ? [argument.value] : [];
    });
    const forgeFlag = values.indexOf('--fml.forgeVersion');
    const mcFlag = values.indexOf('--fml.mcVersion');
    if (forgeFlag >= 0 && typeof values[forgeFlag + 1] === 'string' &&
        mcFlag >= 0 && values[mcFlag + 1] === '1.20.1' && /^47\.\d+\.\d+$/.test(values[forgeFlag + 1])) {
      versions.add(values[forgeFlag + 1]);
    }
    const b = minimum.split('.').map(Number);
    for (const forge of versions) {
      const a = forge.split('.').map(Number);
      const compatible = a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]));
      profiles.push({ profile: entry.name, forge, compatible });
    }
  }
  return profiles;
}

export async function verifyFile(file, mod) {
  const stat = await statOrNull(file);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== mod.size) return false;
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === mod.sha512;
}

export async function alreadyInstalled(root, manifest) {
  const target = path.join(root, 'mods');
  if (!await regularDirectory(target)) return false;
  const existing = await fs.readdir(target);
  if (existing.length !== manifest.mods.length) return false;
  for (const mod of manifest.mods) if (!await verifyFile(path.join(target, mod.filename), mod)) return false;
  return true;
}

export async function downloadMod(mod, output) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const signal = AbortSignal.timeout(180_000);
    try {
      let url = checkedUrl(mod.url);
      let response;
      for (let redirects = 0; redirects < 5; redirects++) {
        response = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'RPG-Minecraft-Setup/1.0' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new Error('Presmerovanie bez adresy.');
          url = checkedUrl(new URL(location, url).href);
          response = undefined;
          continue;
        }
        break;
      }
      if (!response?.ok || !response.body) {
        await response?.body?.cancel();
        throw new Error(`HTTP ${response?.status ?? 'prilis vela presmerovani'}`);
      }
      let count = 0;
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        count += chunk.length;
        callback(count > mod.size ? new Error('Stiahnuty subor je vacsi nez ocakavana verzia.') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(output, { flags: 'w' }), { signal });
      if (!await verifyFile(output, mod)) throw new Error('Nesedi velkost alebo SHA-512 suboru.');
      return;
    } catch (e) { last = e; }
  }
  throw new Error(`Nepodarilo sa stiahnut ${mod.filename}: ${last?.message}. Povodne mody sa nezmenili.`);
}

async function removeOwnedStage(root, stage) {
  if (path.dirname(stage) !== root || !path.basename(stage).startsWith('.rpg-stage-')) throw new Error('Neplatny docasny priecinok.');
  const stat = await statOrNull(stage);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(stage) !== stage) throw new Error('Docasny priecinok sa zmenil.');
  await fs.rm(stage, { recursive: true });
}

export async function installMods({ gameDir, manifest, log = () => {}, download = downloadMod, rename = fs.rename, beforeCommit = async () => {} }) {
  validateManifest(manifest);
  const root = await checkGameDirectory(gameDir);
  if (await alreadyInstalled(root, manifest)) return { unchanged: true, mods: manifest.mods.length };
  const lockPath = path.join(root, '.rpg-mod-setup.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`Uz bezi instalacia alebo ostal zamok po preruseni: ${lockPath}. Najprv over, ze iny instalator nebezi.`);
    throw e;
  }
  let stage;
  let backup;
  let moved = false;
  let committed = false;
  let preserveStage = false;
  const target = path.join(root, 'mods');
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    stage = await fs.mkdtemp(path.join(root, '.rpg-stage-'));
    const prepared = path.join(stage, 'mods');
    await fs.mkdir(prepared);
    let count = 0;
    for (const mod of manifest.mods) {
      const dest = path.join(prepared, mod.filename);
      log(`[${++count}/${manifest.mods.length}] ${mod.name} ${mod.version}`);
      const existing = path.join(target, mod.filename);
      if (await verifyFile(existing, mod)) await fs.copyFile(existing, dest);
      else await download(mod, dest);
      if (!await verifyFile(dest, mod)) throw new Error(`Kontrola SHA-512 zlyhala: ${mod.filename}`);
    }
    await beforeCommit();
    await checkGameDirectory(root);
    const backupRoot = path.join(root, 'rpg-mod-backups');
    await fs.mkdir(backupRoot, { recursive: true });
    await regularDirectory(backupRoot, true);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    const record = path.join(backupRoot, stamp);
    await fs.mkdir(record);
    backup = path.join(record, 'mods');
    // Write the recovery instructions before renaming any existing data.
    await fs.writeFile(path.join(record, 'RESTORE.txt'),
      `Minecraft: ${root}\nZavri Minecraft a launcher.\nAk tu existuje priecinok mods, obsahuje vsetky povodne mody.\nNa obnovu presun sucasny ${target} do ineho zalozneho priecinka a potom presun tento mods do ${root}.\nSvetov ani konfiguracii mimo mods sa instalator nedotyka.\n`);
    await fs.writeFile(path.join(record, 'installation.json'), JSON.stringify({ gameDir: root, files: manifest.mods, date: new Date().toISOString() }, null, 2));
    if (await regularDirectory(target)) {
      await rename(target, backup);
      moved = true;
    }
    try {
      await rename(prepared, target);
      committed = true;
    } catch (error) {
      if (moved) {
        try { await rename(backup, target); moved = false; }
        catch (rollback) {
          preserveStage = true;
          throw new Error(`Obnova po chybe zlyhala. Povodne mody su zachovane v ${backup}. Pripravene mody: ${prepared}. Dovod: ${rollback.message}`, { cause: error });
        }
      }
      throw error;
    }
    return { unchanged: false, mods: manifest.mods.length, backup: moved ? backup : null, record };
  } finally {
    await lock.close().catch(() => {});
    await fs.unlink(lockPath).catch(e => log(`Upozornenie: nepodarilo sa odstranit zamok ${lockPath}: ${e.message}`));
    if (stage && !preserveStage) {
      await removeOwnedStage(root, stage).catch(e => log(`Docasny priecinok zostal v ${stage}: ${e.message}`));
    }
    if (committed) log('Vsetky subory boli overene a nainstalovane.');
  }
}

#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkGameDirectory, detectForge, installMods, validateManifest, alreadyInstalled } from '../lib/installer.mjs';

const exec = promisify(execFile);
const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
let gameDir, dryRun = false, list = false, confirm = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--game-dir' && args[i + 1] && !args[i + 1].startsWith('--')) gameDir = args[++i];
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--list') list = true;
  else if (args[i] === '--confirm') confirm = true;
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log('RPG Minecraft setup 1.0.0\nPouzitie: rpg-minecraft-setup [--game-dir "priecinok .minecraft"] [--dry-run] [--list] [--confirm]\nNode.js 22+, Forge 1.20.1 vo verzii 47.4.x.\nBez parametrov sa spyta na priecinok a potvrdenie.\n--confirm: potvrdi instalaciu v samotnom prikaze (pouzivaj iba so zavretym Minecraftom).\n--dry-run: iba kontrola, nic nestahuje ani nemeni.\n--list: zoznam vsetkych presnych verzii modov.');
    process.exit(0);
  } else { console.error(`Neznamy parameter: ${args[i]}. Pouzi --help.`); process.exit(1); }
}

async function assertMinecraftStopped() {
  if (process.platform !== 'win32') return;
  const script = `@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^javaw?\\.exe$' -and $_.CommandLine -match '(?i)(net\\.minecraft\\.client\\.main\\.Main|cpw\\.mods\\.bootstraplauncher\\.BootstrapLauncher|--launchTarget\\s+forgeclient|--gameDir)' }).Count`;
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let stdout;
  try { ({ stdout } = await exec(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 })); }
  catch { throw new Error('Nepodarilo sa overit, ci je Minecraft zavrety. Zavri hru a skus znova.'); }
  if (!/^\d+$/.test(stdout.trim())) throw new Error('Nepodarilo sa overit beziace procesy Minecraftu.');
  if (Number(stdout.trim()) > 0) throw new Error('Minecraft prave bezi. Zavri hru a spusti instalator znova.');
}

let rl;
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Potrebujes Node.js 22 alebo novsi: https://nodejs.org/');
  validateManifest(manifest);
  if (list) {
    for (const mod of manifest.mods) console.log(`${mod.name}: ${mod.version} (${mod.filename})`);
    process.exit(0);
  }
  console.log('\nRPG PARTIA - Minecraft 1.20.1 Forge\n');
  const suggested = process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'minecraft') : path.join(os.homedir(), '.minecraft');
  if (!gameDir) {
    if (dryRun) gameDir = suggested;
    else {
      if (!process.stdin.isTTY) throw new Error('Spusti prikaz v interaktivnom terminali. Pre kontrolu pouzi --dry-run.');
      rl = createInterface({ input: process.stdin, output: process.stdout });
      console.log('V TLauncheri je to herny priecinok z nastaveni. Enter pouzije predvolenu cestu.');
      gameDir = (await rl.question(`Priecinok Minecraftu [${suggested}]: `)).trim().replace(/^"(.*)"$/, '$1') || suggested;
    }
  }
  let root;
  try { root = await checkGameDirectory(gameDir); }
  catch (e) {
    throw new Error(`Nenasiel som pripraveny priecinok Minecraftu: ${gameDir}.\nNajprv v TLauncheri vyber Forge 1.20.1, spusti hru aspon raz a zavri ju. Ak pouzivas iny priecinok, zadaj ho cez --game-dir.\n${e.message}`);
  }
  const profiles = await detectForge(root, manifest.forgeMinimum);
  const compatible = profiles.filter(p => p.compatible);
  if (!compatible.length) throw new Error(`Nenasiel som Forge 1.20.1 verzie 47.4.x.\nV TLauncheri vyber Forge 1.20.1, odporucane ${manifest.forgeRecommended}, spusti hru raz a zavri ju. Potom zopakuj tento prikaz.\nForge sa tymto instalatorom sam neinstaluje.`);
  console.log(`Ciel: ${path.join(root, 'mods')}`);
  console.log(`Profil Forge: ${compatible.map(p => `${p.profile} (${p.forge})`).join(', ')}`);
  console.log(`Zostava: ${manifest.mods.length} modov, najviac ${Math.ceil(manifest.mods.reduce((n, m) => n + m.size, 0) / 1048576)} MiB na stiahnutie.`);
  if (await alreadyInstalled(root, manifest)) { console.log('Presne tieto mody uz su nainstalovane. Nic sa nemeni.'); }
  else {
    console.log('Povodny priecinok mods bude cely presunuty do rpg-mod-backups. Aktivna zostava bude nahradena nasimi 24 modmi.');
    console.log('Upravuju sa iba mody a zaloha v tomto hernom priecinku. Svety, ucty a ostatne konfiguracie ostanu zachovane.');
    console.log('Stahovanie: Modrinth a CurseForge. Kazdy subor sa overuje pomocou SHA-512.');
    if (dryRun) console.log('\nKontrola dokoncena. Nic sa nestahovalo ani nemenilo.');
    else {
      await assertMinecraftStopped();
      let accepted = confirm;
      if (!accepted) {
        if (!process.stdin.isTTY) throw new Error('Instalacia vyzaduje tvoje potvrdenie. Spusti prikaz s parametrom --confirm.');
        rl ??= createInterface({ input: process.stdin, output: process.stdout });
        console.log('\nPred pokracovanim zavri Minecraft aj launcher.');
        const answer = await rl.question('Suhlasis s touto instalaciou a zalohou? Napis ANO: ');
        accepted = answer.trim().toUpperCase() === 'ANO';
      }
      if (!accepted) console.log('Zrusene. Ziadne subory sa nezmenili.');
      else {
        await assertMinecraftStopped();
        const result = await installMods({ gameDir: root, manifest, log: console.log, beforeCommit: assertMinecraftStopped });
        console.log('\nHOTOVO. Spusti TLauncher a vyber Forge 1.20.1.');
        if (result.backup) console.log(`Povodne mody: ${result.backup}`);
        console.log('Pripojenie k hernemu serveru sa overi az v Minecrafte.');
      }
    }
  }
} catch (error) {
  console.error(`\nCHYBA: ${error.message}`);
  process.exitCode = 1;
} finally { rl?.close(); }

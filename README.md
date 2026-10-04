# RPG Minecraft setup

Jednorazový inštalátor 24 klientských modov pre našu zostavu Minecraft **1.20.1 Forge**. Verzie sú pevne určené v `manifest.json`, vrátane Simply Tooltips a JourneyMap.

## Horác: jeden cloudový príkaz

1. Nainštaluj **Node.js LTS (22 alebo novší)** z https://nodejs.org/ a potom otvor nové okno terminálu.
2. V TLauncheri vyber **Forge 1.20.1**, zostavu **47.4.x** (odporúčaná 47.4.26; pripravená zostava tiež používala 47.4.20). Spusti hru aspoň raz. Potom zavri Minecraft aj launcher. Tento program Forge sám neinštaluje.
3. Otvor PowerShell a spusti jediný príkaz:

```powershell
npx.cmd --yes --package=github:Deniscoke/mods#main rpg-minecraft-setup --confirm
```

4. Príkaz použije predvolenú cestu `%APPDATA%\.minecraft` a po kontrole okamžite spustí inštaláciu. Ak má TLauncher vlastný herný priečinok, doplň `--game-dir "D:\Hry\Minecraft"`.
5. Po hlásení **HOTOVO** otvor launcher, vyber Forge 1.20.1 a pripoj sa na server.

Príkaz stiahne iba verejný inštalačný kód z tohto GitHubu do npm cache a mody z oficiálnych CDN Modrinthu a CurseForge. Netreba posielať ani ručne ukladať `.tgz`. Nepoužívaj skrátený názov neznámeho npm balíka; príkaz musí obsahovať `github:Deniscoke/mods`.

Parameter `--confirm` je zámerné potvrdenie v samotnom príkaze. Minecraft aj TLauncher musia byť pred spustením zavreté; program odmietne pokračovať, ak hru nájde spustenú.

## Lokálna alternatíva

Ak by GitHub nebol dostupný, správca môže použiť lokálny `.tgz` balík:

```powershell
npx.cmd --yes --package=./rpg-minecraft-setup-1.0.0.tgz rpg-minecraft-setup
```

## Čo sa mení

- Celý pôvodný priečinok `mods` sa presunie do `<herný priečinok>/rpg-mod-backups/<dátum>/mods`. Ostatné mody z pôvodnej zostavy tak zostanú zálohované, ale nebudú aktívne.
- Nový `mods` bude obsahovať našich 24 súborov.
- Svety, účty, uložené heslá a konfigurácie mimo `mods` sa nemenia. TL Skin/Cape sa nesťahuje; TLauncher si ho môže pridať sám.
- Sťahuje sa približne 176 MiB z oficiálnych CDN Modrinthu a CurseForge. Každý súbor sa overuje podľa veľkosti a SHA-512. Už prítomné zhodné súbory sa použijú lokálne.
- Pôvodné mody sa presunú až po overení všetkých pripravených súborov. Pri chybe sťahovania zostanú na mieste; pri chybe prepnutia sa program pokúsi automaticky obnoviť zálohu.
- Nevytvára sa vzdialený prístup, služba na pozadí ani spojenie s Claude/Codexom. npm používa svoju bežnú vyrovnávaciu pamäť. Inštalátor nepotrebuje správcu systému.
- Nastavenie je pripravené pre Windows/TLauncher. Vlastný herný priečinok možno zadať; jeho `versions` však musí obsahovať lokálny Forge profil. Iné launchery zatiaľ nie sú overené.

## Kontrola bez zmien

```powershell
npx.cmd --yes --package=github:Deniscoke/mods#main rpg-minecraft-setup --dry-run
```

Pri použití npx si npm môže uložiť samotný malý inštalátor do svojej cache. `--dry-run` nemení Minecraft ani nesťahuje mody.

Iný priečinok:

```powershell
npx.cmd --yes --package=github:Deniscoke/mods#main rpg-minecraft-setup --game-dir "D:\Hry\Minecraft"
```

## Návrat k pôvodným modom

Zavri Minecraft a launcher. V `rpg-mod-backups/<dátum>` nájdeš súbor `RESTORE.txt` a pôvodný priečinok `mods`. Aktuálny `mods` si odlož pod iným názvom a zálohovaný `mods` vráť na pôvodné miesto.

Ak bol program prerušený počas výmeny priečinkov, najskôr skontroluj `rpg-mod-backups` a prípadný `.rpg-stage-*`. Nič z nich nemaž, kým neobnovíš požadovanú zostavu. Zámok `.rpg-mod-setup.lock` po násilnom prerušení odstráň až po overení, že iný inštalátor nebeží.

## Pre správcu balíka

Zdrojový kód je v `bin/` a `lib/`. Inštalátor nemá cudzie npm závislosti ani inštalačné skripty. Modifikácie sa nesú v manifeste s odkazmi na autorov; JAR súbory nie sú súčasťou distribuovaného balíka.

```powershell
npm.cmd test
npm.cmd pack
```

Kompatibilita deklarovaných závislostí bola overená pri príprave zostavy. Skutočné pripojenie k vášmu Hostify serveru treba vyskúšať v Minecrafte. Chybové hlásenia sa nikam automaticky neodosielajú.

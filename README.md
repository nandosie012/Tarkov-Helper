# Tarkov Helper

Lokale helper voor Escape from Tarkov: alle quests met hun benodigde items, een overzicht van wat je in totaal moet verzamelen, een interactieve kaart met boss-spawns, quest-locaties en extracts, en een boss-overzicht.

De data wordt live opgehaald, niet uit een bevroren dataset:

| Bron | Waarvoor |
|---|---|
| [Escape from Tarkov Wiki](https://escapefromtarkov.fandom.com/wiki/Quests) (MediaWiki-API) | Welke quests er zijn, doelen, tabellen "Related Quest Items", vereisten, beloningen, guides met afbeeldingen, boss- en mapbeschrijvingen, extract-vereisten |
| [json.tarkov.dev](https://json.tarkov.dev/endpoints) (game-data, doorlopend bijgewerkt) | Coördinaten van quest-doelen, item-ID's, iconen en flea-prijzen, boss-spawnkansen en spawnposities, extracts, transits, mijnenvelden, sloten |
| [tarkov.dev map-config](https://github.com/the-hideout/tarkov-dev/blob/main/src/data/maps.json) + [SVG-kaarten](https://github.com/the-hideout/tarkov-dev-svg-maps) | Kaartafbeeldingen en de coördinaten-transformatie |

De wiki is leidend voor de inhoud. De game-data vult aan met wat de wiki niet machine-leesbaar heeft, vooral posities. Quests die alleen op de wiki staan (events, Arena/Ref, prestige, nieuwer dan de game-data) worden gewoon meegenomen, alleen zonder kaartpunten. Op de pagina **Data** zie je welke dat zijn.

## Starten

Vereist: Node.js 20 of nieuwer.

**Windows:** dubbelklik `start.cmd`. De browser opent op http://localhost:3311.

**Handmatig:**

```bash
npm install
```

```bash
npm start
```

Bij de eerste start is er nog geen data. De server haalt die dan automatisch op (± 1–2 minuten, de app toont de voortgang). Daarna synchroniseert de server elke 6 uur opnieuw zolang hij draait, en via **Data → Nu synchroniseren** kan het altijd handmatig.

**Docker:**

```bash
docker compose up -d --build
```

De data (en je voortgang) staat in `./data`, dus die blijft bewaard.

### Instellingen

| Variabele | Standaard | Betekenis |
|---|---|---|
| `PORT` | `3311` | Poort |
| `HOST` | `127.0.0.1` | Alleen lokaal bereikbaar. Zet op `0.0.0.0` om bijvoorbeeld vanaf een tablet op je netwerk te kijken. |
| `GAME_MODE` | `regular` | `pve` voor PvE-data (spawnkansen en quests verschillen soms) |
| `SYNC_INTERVAL_HOURS` | `6` | Automatisch opnieuw ophalen, `0` = uit |

Alleen syncen, zonder server: `npm run sync` (of `node sync/index.mjs --mode=pve`).

## Wat zit erin

**Quests.** Alle quests per handelaar, met zoeken (ook op itemnaam), filters op map, Kappa, Lightkeeper en "alleen beschikbaar". Per quest:

- benodigde items met icoon, aantal, FIR, type (inleveren, meenemen, plaatsen, sleutel, …) en flea-prijs
- doelen met afvinkbare checkboxes
- vereisten: level, handelaarsniveau, voorgaande quests, wat de quest ontgrendelt
- knop naar de kaart met precies die quest-locaties
- wiki-guide met afbeeldingen (klik voor groot)
- beloningen

Vul rechtsboven je level in. Vink voltooide quests af. "Voltooid + voorgaande" vinkt de hele keten ervoor in één keer af.

**Quest-items.** Alles wat je nog moet verzamelen, opgeteld over alle (open) quests: FIR apart, voor welke quests, "heb ik"-teller, geschatte flea-kosten. Filters voor inleveren, quest-items, sleutels, plaatsen/markeren, wapens bouwen, verkopen en geld.

**Kaart.** Alle maps met verdiepingen. Lagen voor bosses, raiders/rogues/cultists, quest-locaties (kleur per handelaar, gestippelde zones), extracts (PMC/Scav/gedeeld, met wiki-vereisten), transits, mijnenvelden/snipers en sloten met de bijbehorende sleutel.

- Klik een boss in de zijbalk: de kaart zoomt naar de spawnpunten en toont een infokaart met spawnkans, alle zones, escort en de wiki-kaart met gemarkeerde plekken. Dat laatste is handig voor zones waarvoor de game-data geen coördinaten heeft (bijvoorbeeld Reshala in de Dorms).
- Klik een quest in de zijbalk of "Toon op kaart" bij een quest om alleen die quest te zien.
- Quest-markers tonen standaard alleen open quests; kies "Beschikbaar" of "Alle" in de zijbalk.

**Bosses.** Spawnkans per map, spawnzones, escorts, health, uitrusting, quests, gedrag, wiki-afbeeldingen.

**Ammo.** Per kaliber een grafiek met penetratie tegen damage (hagel: pellets × damage), met lijnen voor armor-klasse 1–6. Shift-klik vergelijkt tot 3 kalibers. Hover geeft alle stats; de tabel eronder heeft tier, armor damage, fragmentatie, snelheid, recoil, effectiviteit per armor-klasse, waar te koop (handelaar, LL, quest-lock) en flea-prijs. Zoeken werkt over alle kalibers. Tier en klasse-effectiviteit zijn een vuistregel (penetratie vs klasse × 10).

**Builds.** Per wapen een meta-build en budget-builds (≤ 25k, 50k, 100k en 200k ₽ aan onderdelen), berekend uit de game-data. Er bestaat geen open, actuele bron met community-builds, dus de helper rekent ze zelf uit en ze lopen automatisch mee met elke patch.

- De optimizer loopt de slot-boom van het wapen af en kiest per slot het onderdeel met de beste verhouding tussen recoil en ergonomie. Recoil weegt het zwaarst. Conflicterende onderdelen vermijdt hij.
- Meta heeft geen budget, maar betaalt geen 200k voor +2 ergonomie.
- Budget is het beste dat binnen het bedrag past.
- Een ladder vergelijkt de verticale recoil van het kale wapen, de standaard-preset, elk budget en meta. Klik een balk om die build te zien.
- Bovenaan staat het standaardwapen zoals de game hem rendert (de default preset). Van de berekende build zelf bestaat geen render: de game-data heeft geen montageposities.
- Een onderdelenbord toont per gemonteerd onderdeel een afbeelding, het slot en waar het op zit. Klik een tegel om naar dat onderdeel in de tabel te springen.
- Per onderdeel zie je recoil, ergonomie en waar je het het goedkoopst koopt (handelaar + LL of flea). Verder: presets die kant-en-klaar bij handelaren te koop zijn, en een ammo-suggestie per kaliber.
- Optiek, tactische apparaten en magazijnen laat hij weg; die zijn persoonlijke voorkeur. Onderdelen die niet los te koop zijn (bijvoorbeeld pistoolslides) staan als "standaard" gemarkeerd.

**Handel.** Items die een handelaar duurder terugkoopt dan ze op de flea kosten: koop op de flea (laagste aanbieding), verkoop aan de handelaar.
- Per item: flea-prijs (laagste en 24 uur gemiddeld), het aantal aanbiedingen, de leeftijd van de prijs, de beste handelaar, winst per stuk en per slot, en de marge.
- Filters op minimale winst, minimaal aanbod en handelaar.
- Zoek je een item op, dan zie je het ook zonder winst, handig om te kijken waar je iets het best verkoopt.
- Let op: prijzen veranderen snel en de site ververst elke 6 uur. Check de prijs in de game voordat je koopt. Sommige items (keycards, sleutels) kun je pas op een hoger flea-level kopen; dat staat erbij.

## Voortgang

Wordt opgeslagen in `data/progress.json` (en als back-up in de browser). Op de pagina **Data** kun je exporteren, importeren en wissen.

## Online zetten (gratis)

Online draait de helper als statische site: geen server, alleen HTML, JavaScript en de JSON-data. `npm run build` haalt verse data op en zet alles in `dist/`. Een geplande build (elke 6 uur) houdt de data actueel.

Verschillen met lokaal:

- Voortgang staat alleen in de browser, per apparaat. Gebruik **Data → Exporteren/Importeren** om hem mee te nemen.
- Er is geen knop "Nu synchroniseren"; de geplande build doet dat.

Lokaal testen zoals een host het serveert:

```bash
npm run build
```

```bash
node scripts/serve-static.mjs --base=/tarkov-helper/
```

Open daarna http://localhost:3312/tarkov-helper/.

Voor alle opties hieronder moet de map in een GitHub-repository staan. Daarvoor heb je [Git](https://git-scm.com/download/win) of [GitHub Desktop](https://desktop.github.com/) en een GitHub-account nodig. `data/` en `dist/` worden niet gecommit; die maakt de build zelf.

### Optie A: GitHub Pages (alles binnen GitHub)

1. Push de repository naar GitHub, met `main` als branch.
2. **Settings → Pages → Build and deployment → Source:** kies "GitHub Actions". Op een gratis GitHub-account werkt Pages alleen voor een **publieke** repository.
3. **Actions → GitHub Pages → Run workflow** voor de eerste keer (of opnieuw starten als de eerste run faalde omdat Pages nog uit stond). Daarna bouwt hij bij elke push en elke 6 uur.
4. Optioneel: PvE-data via de repository-variabele `GAME_MODE` = `pve` (**Settings → Secrets and variables → Actions → Variables**).

GitHub Pages is de standaard. Host je bij Vercel, Cloudflare of Netlify, zet dan de variabele `DEPLOY_TARGET` op die naam (bijvoorbeeld `vercel`); de Pages-workflow slaat zich dan over.

De site staat dan op `https://<gebruiker>.github.io/<repo>/`. Workflow: `.github/workflows/github-pages.yml`.

### Optie B: Vercel

1. Importeer de repository in Vercel. `vercel.json` regelt de rest: build `npm run build`, output `dist`.
2. **Project → Settings → Git → Deploy Hooks:** maak een hook aan voor `main` en kopieer de URL.
3. Zet die URL in GitHub als secret `DEPLOY_HOOK_URL` (**Settings → Secrets and variables → Actions → Secrets**). De workflow `.github/workflows/refresh-deploy-hook.yml` laat Vercel dan elke 6 uur opnieuw bouwen.

Het gratis Hobby-plan van Vercel is alleen voor niet-commercieel gebruik.

### Optie C: Cloudflare Pages of Netlify

- **Cloudflare Pages:** koppel de repository. Build command `npm run build`, output directory `dist`. Node 22 komt uit `.node-version`.
- **Netlify:** koppel de repository. `netlify.toml` regelt de build.
- **Verse data:** maak bij beide een deploy hook (Cloudflare: Settings → Builds → Deploy hooks; Netlify: Build hooks) en zet de URL als GitHub-secret `DEPLOY_HOOK_URL`, net als bij Vercel.

### Goed om te weten

- **Geplande workflows pauzeren:** GitHub zet geplande workflows in een publieke repository uit na 60 dagen zonder activiteit in die repo. Je krijgt daar een mail over; één klik op "Enable workflow" (of een commit) zet ze weer aan.
- **Licenties:**
  - **Kaarten:** de SVG-kaarten van [tarkov-dev-svg-maps](https://github.com/the-hideout/tarkov-dev-svg-maps) vallen onder CC BY-NC-SA 4.0. Dat betekent niet-commercieel, met naamsvermelding (staat in de kaart). Gebruik in cheat-software (radars, ESP) is expliciet verboden; een guide als deze valt daar niet onder.
  - **Wiki-content:** valt onder CC BY-SA; de naamsvermelding staat bij elke quest en boss.
- **Niet verbonden aan Battlestate Games.** Die disclaimer staat onderaan de pagina Data, met de bronnen en licenties.

## Structuur

| Pad | Inhoud |
|---|---|
| `server.mjs` | Lokale server zonder dependencies: frontend, data, sync-endpoint, voortgang |
| `sync/index.mjs` | Haalt alles op en voegt het samen tot `data/*.json` |
| `sync/wiki.mjs`, `sync/wikitext.mjs`, `sync/parse-wiki.mjs` | MediaWiki-client en wikitext-parsers (infobox, tabellen, lijsten, galerijen, veilige HTML) |
| `sync/tarkovdev.mjs` | json.tarkov.dev en de kaartconfiguratie |
| `sync/builds.mjs` | Build-optimizer (meta en budget) over de slot-bomen van de wapens |
| `public/` | Frontend (vanilla JS-modules, Leaflet), alle paden relatief |
| `data/` | Gegenereerd: `quests.json`, `items.json`, `bosses.json`, `maps.json`, `ammo.json`, `builds.json`, `meta.json`, `maps/*.svg`, `progress.json` |
| `scripts/build.mjs` | Statische build naar `dist/` (sync + frontend + data + Leaflet) |
| `scripts/serve-static.mjs` | Preview van `dist/` zoals een statische host, optioneel onder een subpad |
| `.github/workflows/`, `vercel.json`, `netlify.toml`, `.node-version` | Hosting en geplande rebuilds |

## Bekende beperkingen

- Niet elke quest heeft coördinaten in de game-data (± 240 van de 565 wel). Voor de rest staan de wiki-afbeeldingen in de guide.
- Een deel van de boss-zones (onder andere Reshala Dorms/Gas Station, Sanitar Port, Zryachiy Island) heeft geen coördinaten in de game-data. Die staan als zone in de infokaart, met de wiki-kaart erbij.
- De GraphQL-API van tarkov.dev (`api.tarkov.dev`) gaf tijdens het bouwen een foutmelding. Daarom gebruikt de helper de statische JSON-endpoints.
- Wiki-teksten en -afbeeldingen vallen onder CC BY-SA, de kaarten onder CC BY-NC-SA 4.0 (zie "Online zetten"). Afbeeldingen worden rechtstreeks van de wiki geladen, dus voor de guide-afbeeldingen heb je internet nodig.

Niet verbonden aan Battlestate Games.

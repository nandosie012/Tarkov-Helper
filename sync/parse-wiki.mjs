// Page-specific parsers for the EFT wiki: quest list, quest pages, bosses, map pages.

import {
  stripNoise, findTemplate, sections, sectionList, bullets, tables, links, files,
  toHtml, plain, blocksToHtml, renderList,
} from "./wikitext.mjs";

const lower = (s) => String(s ?? "").toLowerCase();

/** "Quests" page: tabbed tables per trader. Returns [{ trader, title }] in page order. */
export function parseQuestList(wikitext) {
  const text = stripNoise(wikitext);
  const tabsBlock = /<ul class="wds-tabs[\s\S]*?<\/ul>/.exec(text)?.[0] ?? "";
  const traders = [...tabsBlock.matchAll(/class=wds-tabs__tab-label\|([^\]]+)\]\]/g)].map((m) => m[1].trim());
  const blocks = text.split(/<div class="wds-tab__content[^"]*">/).slice(1);
  const out = [];
  blocks.forEach((block, i) => {
    const trader = traders[i] ?? null;
    // stop at the end of the tabber (operational tasks follow)
    const body = block.split(/\n==[^=]/)[0];
    for (const table of tables(body)) {
      for (const row of table.rows) {
        if (row.every((c) => c.header)) continue;
        const first = links(row[0]?.text)[0];
        if (!first) continue;
        out.push({ trader, title: first.target, summary: row[1] ? bullets(row[1].text).map((b) => plain(b.text)) : [] });
      }
    }
  });
  return out;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * "Events" page: one "==Halloween 2026 (29 October 2026)==" section per event, newest first.
 * Returns [{ name, start (YYYY-MM-DD or null), quests: [titles] }]; quests come from the
 * "Quest [[X]] has been added" bullets, so they may still contain the odd non-quest link.
 */
export function parseEventList(wikitext) {
  const text = stripNoise(wikitext);
  const out = [];
  for (const section of text.split(/^==(?=[^=])/m).slice(1)) {
    const heading = section.slice(0, section.indexOf("==")).trim();
    const m = /^(.*?)\s*\((\d{1,2}) ([A-Za-z]+) (\d{4})\)$/.exec(heading);
    const month = m ? MONTHS.indexOf(lower(m[3])) : -1;
    const start = month >= 0 ? `${m[4]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
    const quests = [];
    for (const line of section.split("\n")) {
      if (!/^\*.*\bquests?\b.*\b(added|available)\b/i.test(line)) continue;
      for (const l of links(line)) if (!quests.includes(l.target)) quests.push(l.target);
    }
    out.push({ name: m ? m[1].trim() : heading, start, quests });
  }
  return out;
}

function linkTargets(value) {
  return links(value).map((l) => l.target);
}

/** Header-driven parse of a "Related Quest Items" style table. */
function parseItemTable(table, ctx) {
  const headerIdx = table.rows.findIndex((r) => r.length >= 3 && r.every((c) => c.header) && r.some((c) => /item/i.test(plain(c.text))));
  if (headerIdx < 0) return null;
  const head = table.rows[headerIdx].map((c) => lower(plain(c.text)));
  const col = (re) => head.findIndex((h) => re.test(h));
  const cols = {
    icon: col(/^icon|image/),
    item: col(/item name|^item$|^name/),
    amount: col(/amount|quantity|count/),
    requirement: col(/requirement|type|usage/),
    fir: col(/found in raid|find in raid|fir/),
    notes: col(/note/),
  };
  if (cols.item < 0) return null;
  const title = table.rows.slice(0, headerIdx).map((r) => r.map((c) => plain(c.text)).join(" ")).join(" ");
  const rows = [];
  for (const row of table.rows.slice(headerIdx + 1)) {
    if (row.length < head.length - 1) continue;
    const cell = (i) => (i >= 0 ? row[i]?.text ?? "" : "");
    const itemCell = cell(cols.item);
    const itemLinks = links(itemCell);
    const name = plain(itemCell, ctx);
    if (!name) continue;
    const amountText = plain(cell(cols.amount), ctx);
    const firText = lower(plain(cell(cols.fir), ctx));
    rows.push({
      items: itemLinks.map((l) => ({ title: l.target, label: l.label })),
      name,
      nameHtml: toHtml(itemCell, ctx),
      alternatives: itemLinks.length > 1 && /\bor\b/i.test(name),
      amountText,
      amount: /^\d[\d,]*$/.test(amountText.replace(/\s/g, "")) ? Number(amountText.replace(/[,\s]/g, "")) : null,
      requirement: plain(cell(cols.requirement), ctx),
      fir: firText.startsWith("yes") ? true : firText.startsWith("no") ? false : null,
      notesHtml: toHtml(cell(cols.notes), ctx),
      icons: files(cell(cols.icon)).map((f) => f.file),
    });
  }
  return { title, rows };
}

export function parseQuestPage(title, wikitext) {
  const ctx = { title };
  const text = stripNoise(wikitext);
  const info = findTemplate(text, "Infobox quest")?.params ?? {};
  const secs = sections(text);
  const objectivesRaw = secs.get("objectives") ?? "";
  const guideRaw = secs.get("guide") ?? "";

  const objectives = bullets(objectivesRaw).map((b) => ({
    depth: b.depth,
    html: toHtml(b.text, ctx),
    text: plain(b.text, ctx),
    fir: /found in raid/i.test(b.text),
    optional: /optional/i.test(b.text),
    links: links(b.text).map((l) => l.target),
  }));

  const itemTables = [];
  for (const table of tables(text)) {
    const parsed = parseItemTable(table, ctx);
    if (parsed?.rows.length) itemTables.push(parsed);
  }

  const reqList = bullets(secs.get("requirements") ?? "");
  const rewardsRaw = (secs.get("rewards") ?? "").replace(/\{\{quote[\s\S]*?\}\}/gi, "");
  const rewardList = bullets(rewardsRaw);

  return {
    title,
    event: /\{\{\s*event content/i.test(text),
    infobox: {
      givenBy: linkTargets(info["given by"])[0] ?? plain(info["given by"]) ?? null,
      locations: linkTargets(info.location),
      locationText: plain(info.location ?? ""),
      llRequirement: plain(info["ll requirement"] ?? "") || null,
      levelRequirement: plain(info["level requirement"] ?? info["level"] ?? "") || null,
      previous: linkTargets(info.previous),
      leadsTo: linkTargets(info["leads to"]),
      related: linkTargets(info.related),
      image: files(`[[File:${info.image ?? ""}]]`)[0]?.file ?? null,
      kappa: info.kappa ? /yes|true|required/i.test(info.kappa) : null,
    },
    requirementsHtml: reqList.length ? renderList(reqList, ctx) : "",
    objectives,
    rewardsHtml: rewardList.length ? renderList(rewardList, ctx) : "",
    itemTables,
    guideHtml: blocksToHtml(guideRaw, ctx),
    guideImages: files(guideRaw),
    revision: null,
  };
}

/** "Bosses" page: main + event tables. */
export function parseBossList(wikitext) {
  const text = stripNoise(wikitext);
  const out = [];
  for (const table of tables(text)) {
    const headerIdx = table.rows.findIndex((r) => r.every((c) => c.header) && r.some((c) => /name/i.test(plain(c.text))));
    if (headerIdx < 0) continue;
    const head = table.rows[headerIdx].map((c) => lower(plain(c.text)));
    const col = (name) => head.findIndex((h) => h.includes(name));
    for (const row of table.rows.slice(headerIdx + 1)) {
      const cell = (i) => (i >= 0 ? row[i]?.text ?? "" : "");
      const name = links(cell(col("name")))[0];
      if (!name) continue;
      out.push({
        title: name.target,
        name: name.label || name.target,
        event: col("event") >= 0 ? plain(cell(col("event"))) : null,
        faction: plain(cell(col("faction"))),
        locations: links(cell(col("location"))).map((l) => ({ title: l.target, label: l.label })),
        followersHtml: toHtml(cell(col("follower"))),
        equipment: links(cell(col("equipment"))).map((l) => l.target),
        portrait: files(cell(col("image")))[0]?.file ?? null,
      });
    }
  }
  return out;
}

export function parseBossPage(title, wikitext) {
  const ctx = { title };
  const text = stripNoise(wikitext);
  const info = findTemplate(text, "Infobox character")?.params ?? {};
  const secs = sections(text);
  const locationRaw = secs.get("location") ?? secs.get("locations") ?? secs.get("spawn locations") ?? "";
  const perMap = [];
  for (const level of [3, 4]) {
    for (const s of sectionList(locationRaw, level)) {
      const mapLink = links(s.title)[0];
      perMap.push({
        map: mapLink?.target ?? plain(s.title),
        html: blocksToHtml(s.body, ctx),
        images: files(s.body),
      });
    }
    if (perMap.length) break;
  }
  const notes = secs.get("notes") ?? "";
  const health = {};
  for (const m of notes.matchAll(/(Head|Thorax|Stomach|Arms|Legs|Total)\W*:\s*'*\s*([\d,]+)/gi)) {
    const key = m[1].toLowerCase();
    if (!(key in health)) health[key] = Number(m[2].replace(/,/g, ""));
  }
  return {
    title,
    image: files(`[[File:${info.image ?? ""}]]`)[0]?.file ?? null,
    faction: plain(info.faction ?? ""),
    fullName: plain(info["full name"] ?? ""),
    spawnChanceText: plain(info["spawn chance"] ?? ""),
    locationIntroHtml: blocksToHtml(locationRaw.split(/^===/m)[0], ctx),
    perMap,
    health: Object.keys(health).length ? health : null,
    questsHtml: blocksToHtml(secs.get("quests") ?? "", ctx),
    behaviorHtml: blocksToHtml(secs.get("behavior") ?? secs.get("behaviour") ?? "", ctx),
    lootHtml: blocksToHtml(secs.get("loot") ?? "", ctx),
  };
}

export function parseMapPage(title, wikitext) {
  const ctx = { title };
  const text = stripNoise(wikitext);
  const info = findTemplate(text, "Infobox location")?.params ?? {};
  const secs = sections(text);
  const bosses = [];
  for (const table of tables(secs.get("bosses") ?? "")) {
    const headerIdx = table.rows.findIndex((r) => r.every((c) => c.header) && r.length >= 2);
    if (headerIdx < 0) continue;
    const head = table.rows[headerIdx].map((c) => lower(plain(c.text)));
    const col = (name) => head.findIndex((h) => h.includes(name));
    for (const row of table.rows.slice(headerIdx + 1)) {
      const cell = (i) => (i >= 0 ? row[i]?.text ?? "" : "");
      const name = links(cell(col("name")))[0];
      if (!name) continue;
      bosses.push({ title: name.target, locationHtml: toHtml(cell(col("location")), ctx), followersHtml: toHtml(cell(col("follower")), ctx) });
    }
  }
  const extracts = [];
  for (const table of tables(secs.get("extractions") ?? secs.get("extracts") ?? "")) {
    const headerIdx = table.rows.findIndex((r) => r.every((c) => c.header) && r.length >= 3);
    if (headerIdx < 0) continue;
    const head = table.rows[headerIdx].map((c) => lower(plain(c.text)));
    const col = (name) => head.findIndex((h) => h.includes(name));
    for (const row of table.rows.slice(headerIdx + 1)) {
      const cell = (i) => (i >= 0 ? row[i]?.text ?? "" : "");
      const name = plain(cell(col("name")), ctx);
      if (!name) continue;
      extracts.push({
        name,
        faction: plain(cell(col("faction")), ctx),
        alwaysAvailable: /✔|yes/i.test(cell(col("always"))) ? true : /✘|no/i.test(cell(col("always"))) ? false : null,
        singleUse: /✔|yes/i.test(cell(col("single"))) ? true : /✘|no/i.test(cell(col("single"))) ? false : null,
        requirementsHtml: toHtml(cell(col("requirement")), ctx).replace(/^-$/, ""),
        notesHtml: toHtml(cell(col("note")), ctx),
      });
    }
  }
  return {
    title,
    players: plain(info.players ?? ""),
    duration: plain(info.duration ?? ""),
    enemies: links(info.enemies ?? "").map((l) => l.target),
    descriptionHtml: blocksToHtml(secs.get("description") ?? "", ctx),
    bosses,
    extracts,
  };
}

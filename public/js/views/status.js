import { store, refreshStatus, reloadData, saveProgress, STATIC, seasonDaysLeft } from "../app.js";
import { html, timeAgo } from "../util.js";

let root;
let timer = null;
let wasRunning = false;
// bumped on every mount/unmount so a poll that was in flight stops instead of rendering into a removed view
let generation = 0;

export function mount(el) {
  root = el;
  generation++;
  el.innerHTML = `<div class="page"><div class="page-body scroll" id="s-body"></div></div>`;
  el.addEventListener("click", onClick);
  el.addEventListener("change", onChange);
  render();
  poll(generation);
}

export function unmount() {
  generation++;
  clearTimeout(timer);
}

async function poll(gen) {
  const s = await refreshStatus();
  if (gen !== generation) return;
  const running = !!s?.sync?.running;
  if (wasRunning && !running && s?.sync?.exitCode === 0) {
    wasRunning = false;
    await reloadData(); // remounts this view, which starts its own poll
    return;
  }
  wasRunning = running;
  render();
  timer = setTimeout(() => poll(gen), running ? 1500 : STATIC ? 60000 : 10000);
}

async function onClick(e) {
  if (e.target.closest("#s-sync")) {
    await fetch("api/sync", { method: "POST" });
    wasRunning = true;
    clearTimeout(timer);
    poll(generation);
  }
  if (e.target.closest("#s-export")) {
    const blob = new Blob([JSON.stringify(store.progress, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tarkov-helper-voortgang.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  if (e.target.closest("#s-reset")) {
    if (!confirm("Alle voortgang (voltooide quests, doelen, items) wissen? Dit kan niet ongedaan worden gemaakt.")) return;
    store.progress = { done: {}, objectives: {}, owned: {}, level: store.progress.level };
    saveProgress();
    window.dispatchEvent(new CustomEvent("progress"));
    render();
  }
}

async function onChange(e) {
  if (e.target.id !== "s-import" || !e.target.files[0]) return;
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!data || typeof data !== "object" || !data.done) throw new Error("Geen geldig voortgangsbestand");
    store.progress = { done: {}, objectives: {}, owned: {}, level: null, ...data };
    saveProgress();
    window.dispatchEvent(new CustomEvent("progress"));
    alert("Voortgang geïmporteerd.");
  } catch (err) {
    alert(`Import mislukt: ${err.message}`);
  }
}

function render() {
  const body = root?.querySelector("#s-body");
  if (!body) return;
  const s = store.status;
  const meta = s?.meta;
  // contents and warnings describe the mode you are looking at (regular or season)
  const content = store.modeMeta ?? meta;
  const c = content?.counts ?? {};
  const running = !!s?.sync?.running;
  const seasonMode = store.mode === "season";
  body.innerHTML = String(html`
    <div class="detail-inner" style="padding:0">
      <h2 style="font-size:17px;margin-bottom:12px">Data &amp; synchronisatie</h2>
      ${seasonMode ? seasonCard() : ""}
      <div class="card">
        <h3>Status</h3>
        <dl class="kv">
          <dt>Laatst opgehaald</dt><dd>${meta ? html`${new Date(meta.fetchedAt).toLocaleString("nl-NL")} <span class="muted">(${timeAgo(meta.fetchedAt)}, ${meta.durationSec}s)</span>` : "nog nooit"}</dd>
          <dt>Modi</dt><dd>${(s?.mode ?? meta?.mode) === "pve" ? "PvE" : "Regulier (PvP)"}${store.season ? ` + seizoen ${store.season.name}` : ""} <span class="muted">· hoofdmodus wijzigen met GAME_MODE=pve</span></dd>
          ${STATIC
            ? html`<dt>Automatisch</dt><dd>via de geplande build van deze site${meta?.build?.source ? html` <span class="muted">(${meta.build.source})</span>` : ""}</dd>`
            : html`<dt>Automatisch</dt><dd>${s?.syncIntervalHours ? `elke ${s.syncIntervalHours} uur (zolang de server draait)` : "uit"}</dd>`}
          <dt>Bronnen</dt><dd><a href="${meta?.sources?.wiki ?? "#"}" target="_blank" rel="noopener">EFT Wiki</a> · <a href="https://json.tarkov.dev/endpoints" target="_blank" rel="noopener">json.tarkov.dev</a> · <a href="${meta?.sources?.mapSvg ?? "#"}" target="_blank" rel="noopener">tarkov-dev-svg-maps</a></dd>
        </dl>
        ${STATIC ? "" : html`<div class="q-actions"><button class="btn primary" id="s-sync" ${running ? "disabled" : ""}>${running ? "Bezig…" : "Nu synchroniseren"}</button></div>`}
      </div>

      ${content ? html`<div class="card">
        <h3>Inhoud <span class="count">${seasonMode ? `seizoen${content.season?.questsNotInSeason ? ` · ${content.season.questsNotInSeason} reguliere quests zitten niet in het seizoen` : ""}` : "regulier"}</span></h3>
        <div class="stat-row">
          <div class="stat"><b>${c.quests}</b><span>Quests</span></div>
          <div class="stat"><b>${c.questsWikiAndApi}</b><span>Wiki + game-data</span></div>
          <div class="stat"><b>${c.questsWikiOnly}</b><span>Alleen wiki</span></div>
          <div class="stat"><b>${c.questsApiOnly}</b><span>Alleen game-data</span></div>
          <div class="stat"><b>${c.questsWithItems}</b><span>Met items</span></div>
          <div class="stat"><b>${c.questsWithMapPins}</b><span>Met kaartpunten</span></div>
          <div class="stat"><b>${c.bosses}</b><span>Bosses</span></div>
          <div class="stat"><b>${c.maps}</b><span>Maps</span></div>
          ${c.ammo ? html`<div class="stat"><b>${c.ammo}</b><span>Soorten ammo</span></div>` : ""}
        </div>
      </div>
      ${content.questsWikiOnly?.length ? html`<div class="card"><h3>Alleen op de wiki <span class="count">${content.questsWikiOnly.length}</span></h3>
        <p class="muted" style="margin-top:0">Staan op de wiki maar (nog) niet in de game-data: nieuwe of event-quests, Arena/Ref-quests, prestige. Ze zijn wel volledig opgenomen, alleen zonder kaartcoördinaten.</p>
        <div class="taglist">${content.questsWikiOnly.map((t) => html`<span class="chip">${t}</span>`)}</div></div>` : ""}
      ${content.questsApiOnly?.length ? html`<div class="card"><h3>Alleen in game-data <span class="count">${content.questsApiOnly.length}</span></h3><div class="taglist">${content.questsApiOnly.map((t) => html`<span class="chip">${t}</span>`)}</div></div>` : ""}
      ${content.warnings?.length ? html`<div class="card"><h3>Waarschuwingen</h3><ul class="richtext">${content.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ""}` : ""}
      ${!seasonMode && store.season ? seasonCard() : ""}

      ${STATIC ? "" : html`<div class="card">
        <h3>Sync-log</h3>
        <div class="log">${(s?.sync?.log ?? []).join("\n") || "Nog geen sync in deze sessie."}</div>
      </div>`}

      <div class="card">
        <h3>Voortgang</h3>
        <p class="muted" style="margin-top:0">${Object.keys(store.progress.done).length} quests voltooid ${seasonMode ? "in het seizoen" : "in regulier"}; elke modus heeft zijn eigen voortgang. ${STATIC
          ? "Opgeslagen in deze browser, per apparaat. Exporteer om een back-up te maken of om je voortgang naar een ander apparaat te zetten."
          : html`Opgeslagen in <span class="mono">data/${seasonMode ? "progress-season.json" : "progress.json"}</span> (en in je browser als back-up).`}</p>
        <div class="q-actions">
          <button class="btn" id="s-export">Exporteren</button>
          <label class="btn">Importeren<input type="file" id="s-import" accept="application/json" hidden></label>
          <button class="btn" id="s-reset">Voortgang wissen</button>
        </div>
      </div>

      <p class="attrib">
        Niet verbonden aan Battlestate Games; Escape from Tarkov is een handelsmerk van Battlestate Games.
        Teksten en afbeeldingen: <a href="https://escapefromtarkov.fandom.com" target="_blank" rel="noopener">Escape from Tarkov Wiki</a> (CC BY-SA).
        Game-data: <a href="https://tarkov.dev" target="_blank" rel="noopener">tarkov.dev</a>.
        Kaarten: <a href="https://github.com/the-hideout/tarkov-dev-svg-maps" target="_blank" rel="noopener">tarkov-dev-svg-maps</a> (CC BY-NC-SA 4.0).
      </p>
    </div>`);
}

/** The current PvP season: dates, the modifiers everybody has, and the personal ones you buy with points. */
function seasonCard() {
  const season = store.season;
  if (!season) return "";
  const days = seasonDaysLeft();
  const nameOf = new Map(season.personal.map((p) => [p.id, p.name]));
  const date = (iso) => new Date(iso).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });
  const points = (p) => {
    if (p.points == null) return "";
    if (p.points > 0) return html`<span class="c-green">+${p.points}</span><div class="faint" style="font-size:11px">geeft punten</div>`;
    if (p.points < 0) return html`<span class="c-orange">−${Math.abs(p.points)}</span><div class="faint" style="font-size:11px">kost punten</div>`;
    return "0";
  };
  const perkName = (p) => html`<div class="iname">${p.image ? html`<img class="icon-img sm" src="${p.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<b>${p.name}</b></div>`;
  return html`<div class="card highlight">
    <h3>Seizoen: ${season.name} <span class="count">${days > 0 ? `nog ${days} ${days === 1 ? "dag" : "dagen"}` : "afgelopen"}</span></h3>
    <p style="margin:0 0 12px">${date(season.start)} – ${date(season.end)}. ${store.mode === "season"
      ? "Je bekijkt de seizoensdata: quests, prijzen, builds en spawns van het PvP-seizoen."
      : "Schakel bovenaan naar Seizoen voor de quests, prijzen, builds en spawns van het PvP-seizoen."}</p>
    <div class="section-title">Voor iedereen</div>
    <div class="table-scroll"><table class="itable" style="margin-bottom:14px">
      <tbody>${season.common.map((p) => html`<tr><td style="width:240px">${perkName(p)}</td><td class="muted">${p.description}</td></tr>`)}</tbody>
    </table></div>
    <details>
      <summary>Persoonlijke modifiers (${season.personal.length}): kies je zelf met punten</summary>
      <p class="muted" style="font-size:12.5px">Nadelen geven punten, voordelen kosten punten. Sommige modifiers sluiten elkaar uit.</p>
      <div class="table-scroll"><table class="itable">
        <thead><tr><th>Modifier</th><th>Effect</th><th>Punten</th><th>Sluit uit</th></tr></thead>
        <tbody>${[...season.personal].sort((a, b) => (a.points ?? 0) - (b.points ?? 0)).map((p) => html`<tr>
          <td style="width:220px">${perkName(p)}</td>
          <td class="muted">${p.description}</td>
          <td class="num" style="white-space:nowrap">${points(p)}</td>
          <td class="muted" style="font-size:12px">${p.exclusive.map((id) => nameOf.get(id)).filter(Boolean).join(", ") || "–"}</td>
        </tr>`)}</tbody>
      </table></div>
    </details>
  </div>`;
}

import { store, refreshStatus, reloadData, saveProgress, STATIC } from "../app.js";
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
  const c = meta?.counts ?? {};
  const running = !!s?.sync?.running;
  body.innerHTML = String(html`
    <div class="detail-inner" style="padding:0">
      <h2 style="font-size:17px;margin-bottom:12px">Data &amp; synchronisatie</h2>
      <div class="card">
        <h3>Status</h3>
        <dl class="kv">
          <dt>Laatst opgehaald</dt><dd>${meta ? html`${new Date(meta.fetchedAt).toLocaleString("nl-NL")} <span class="muted">(${timeAgo(meta.fetchedAt)}, ${meta.durationSec}s)</span>` : "nog nooit"}</dd>
          <dt>Spelmodus</dt><dd>${(s?.mode ?? meta?.mode) === "pve" ? "PvE" : "PvP (regular)"} <span class="muted">· wijzig met GAME_MODE=pve</span></dd>
          ${STATIC
            ? html`<dt>Automatisch</dt><dd>via de geplande build van deze site${meta?.build?.source ? html` <span class="muted">(${meta.build.source})</span>` : ""}</dd>`
            : html`<dt>Automatisch</dt><dd>${s?.syncIntervalHours ? `elke ${s.syncIntervalHours} uur (zolang de server draait)` : "uit"}</dd>`}
          <dt>Bronnen</dt><dd><a href="${meta?.sources?.wiki ?? "#"}" target="_blank" rel="noopener">EFT Wiki</a> · <a href="https://json.tarkov.dev/endpoints" target="_blank" rel="noopener">json.tarkov.dev</a> · <a href="${meta?.sources?.mapSvg ?? "#"}" target="_blank" rel="noopener">tarkov-dev-svg-maps</a></dd>
        </dl>
        ${STATIC ? "" : html`<div class="q-actions"><button class="btn primary" id="s-sync" ${running ? "disabled" : ""}>${running ? "Bezig…" : "Nu synchroniseren"}</button></div>`}
      </div>

      ${meta ? html`<div class="card">
        <h3>Inhoud</h3>
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
      ${meta.questsWikiOnly?.length ? html`<div class="card"><h3>Alleen op de wiki <span class="count">${meta.questsWikiOnly.length}</span></h3>
        <p class="muted" style="margin-top:0">Staan op de wiki maar (nog) niet in de game-data: nieuwe of event-quests, Arena/Ref-quests, prestige. Ze zijn wel volledig opgenomen, alleen zonder kaartcoördinaten.</p>
        <div class="taglist">${meta.questsWikiOnly.map((t) => html`<span class="chip">${t}</span>`)}</div></div>` : ""}
      ${meta.questsApiOnly?.length ? html`<div class="card"><h3>Alleen in game-data <span class="count">${meta.questsApiOnly.length}</span></h3><div class="taglist">${meta.questsApiOnly.map((t) => html`<span class="chip">${t}</span>`)}</div></div>` : ""}
      ${meta.warnings?.length ? html`<div class="card"><h3>Waarschuwingen</h3><ul class="richtext">${meta.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ""}` : ""}

      ${STATIC ? "" : html`<div class="card">
        <h3>Sync-log</h3>
        <div class="log">${(s?.sync?.log ?? []).join("\n") || "Nog geen sync in deze sessie."}</div>
      </div>`}

      <div class="card">
        <h3>Voortgang</h3>
        <p class="muted" style="margin-top:0">${Object.keys(store.progress.done).length} quests voltooid. ${STATIC
          ? "Opgeslagen in deze browser, per apparaat. Exporteer om een back-up te maken of om je voortgang naar een ander apparaat te zetten."
          : html`Opgeslagen in <span class="mono">data/progress.json</span> (en in je browser als back-up).`}</p>
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

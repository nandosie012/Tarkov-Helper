// Weapon build optimizer over the game data's slot trees (json.tarkov.dev items).
//
// Recoil in EFT: final = base × (1 + Σ recoilModifier of the mods); ergonomics = base + Σ mod ergonomics.
// Score per part: -100 × recoilModifier + ERGO_WEIGHT × ergonomics, so recoil leads and ergonomics breaks ties.
// "Meta" maximises the score with no price limit; "budget" does the same within a cap on the mods' total price
// (tree knapsack over price buckets). Optics, tactical devices and magazines are left to personal taste.

const ERGO_WEIGHT = 0.5;
// meta ignores budgets but should not buy +2 ergonomics for 200k: 1 score point (≈1% recoil) per 50k ₽
const PRICE_WEIGHT = 1 / 50_000;
export const BUDGET_CAPS = [25_000, 50_000, 100_000, 200_000];
const BUCKETS = 50;
const EPS = 1e-9;

// slots that matter for recoil/ergonomics; the rest is only filled when the weapon requires it
const OPTIMIZE = /^mod_(pistol_?grip|reciever|stock|charge|barrel|handguard|mount|muzzle|gas_block|foregrip|trigger|hammer|catch)/;
const SLOT_LABEL = [
  [/^mod_pistol_?grip/, "Pistoolgreep"],
  [/^mod_reciever/, "Receiver"],
  [/^mod_stock/, "Kolf"],
  [/^mod_charge/, "Charging handle"],
  [/^mod_barrel/, "Loop"],
  [/^mod_handguard/, "Handguard"],
  [/^mod_mount/, "Mount"],
  [/^mod_muzzle/, "Mondingsstuk"],
  [/^mod_gas_block/, "Gas block"],
  [/^mod_foregrip/, "Voorgreep"],
  [/^mod_trigger/, "Trekker"],
  [/^mod_hammer/, "Hamer"],
  [/^mod_catch/, "Catch"],
  [/^mod_magazine/, "Magazijn"],
  [/^mod_(scope|sight)/, "Vizier"],
  [/^mod_tactical/, "Tactisch"],
];
const slotLabel = (nameId) => SLOT_LABEL.find(([re]) => re.test(nameId))?.[1] ?? nameId.replace(/^mod_/, "");

const SKIP_CATEGORIES = new Set(["Grenade launcher", "Rocket Launcher"]);

export function computeBuilds({ items, tr, traderById, categories }) {
  const recoilOf = (it) => it?.properties?.recoilModifier ?? 0;
  const ergoOf = (it) => it?.properties?.ergonomics ?? 0;
  const partScore = (it) => -100 * recoilOf(it) + ERGO_WEIGHT * ergoOf(it);

  // parts that ship on a weapon's default preset; some (pistol slides, barrels) are never sold separately
  const stockParts = new Set();
  for (const it of Object.values(items)) {
    if (it.types?.includes("preset") && it.properties?.default) for (const c of it.containsItems ?? []) stockParts.add(c.item);
  }

  const offerCache = new Map();
  /** Cheapest way to buy an item: flea (avg 24h) or a trader offer; stock parts fall back to their handbook price. null = not obtainable. */
  function offer(id) {
    if (offerCache.has(id)) return offerCache.get(id);
    const it = items[id];
    const offers = [];
    if (it && !it.types?.includes("noFlea") && it.avg24hPrice > 0) offers.push({ price: it.avg24hPrice, source: "Flea" });
    for (const b of it?.buyFromTrader ?? []) {
      if (b.priceRUB > 0) offers.push({ price: b.priceRUB, source: traderById.get(b.trader)?.name ?? "Handelaar", level: b.minTraderLevel ?? null, quest: !!b.taskUnlock });
    }
    let best = offers.sort((a, b) => a.price - b.price)[0] ?? null;
    if (!best && stockParts.has(id)) best = { price: it.basePrice ?? 0, source: "Standaardonderdeel", stock: true };
    offerCache.set(id, best);
    return best;
  }

  const slotsOf = (it) => (it?.properties?.slots ?? []).filter((s) => s.required || OPTIMIZE.test(s.nameId));

  // ---------------------------------------------------------------- meta (no price limit)

  function metaSolver(banned) {
    const memo = new Map();
    const busy = new Set();
    function node(id, root = false) {
      if (!root && memo.has(id)) return memo.get(id);
      if (banned.has(id) || busy.has(id)) return null;
      const it = items[id];
      const o = root ? { price: 0 } : offer(id);
      if (!it || !o) return null;
      busy.add(id);
      const res = { id, score: root ? 0 : partScore(it) - o.price * PRICE_WEIGHT, cost: o.price, children: [] };
      for (const slot of slotsOf(it)) {
        let best = null;
        for (const opt of slot.filters?.allowedItems ?? []) {
          if (!slot.required && offer(opt)?.stock) continue; // unsellable stock parts only where the weapon needs them
          const n = node(opt);
          if (n && (!best || n.score > best.score + EPS || (Math.abs(n.score - best.score) <= EPS && n.cost < best.cost))) best = n;
        }
        if (!best) {
          if (slot.required) {
            busy.delete(id);
            if (!root) memo.set(id, null);
            return null;
          }
          continue;
        }
        if (!slot.required && best.score <= EPS) continue; // optional part that doesn't help
        res.score += best.score;
        res.cost += best.cost;
        res.children.push({ slot, node: best });
      }
      busy.delete(id);
      if (!root) memo.set(id, res);
      return res;
    }
    return (weaponId) => {
      const r = node(weaponId, true);
      return r ? flatten(r) : null;
    };
  }

  // ---------------------------------------------------------------- budget (tree knapsack)

  function budgetSolver(cap, banned) {
    const step = cap / BUCKETS;
    const memo = new Map();
    const busy = new Set();
    const NEG = -Infinity;

    function node(id, root = false) {
      if (!root && memo.has(id)) return memo.get(id);
      if (banned.has(id) || busy.has(id)) return null;
      const it = items[id];
      const o = root ? { price: 0 } : offer(id);
      if (!it || !o) return null;
      const c = Math.ceil(o.price / step - EPS);
      if (c > BUCKETS) {
        if (!root) memo.set(id, null);
        return null;
      }
      busy.add(id);
      let val = new Array(BUCKETS + 1).fill(NEG);
      const own = root ? 0 : partScore(it);
      for (let b = c; b <= BUCKETS; b++) val[b] = own;
      const splits = [];
      for (const slot of slotsOf(it)) {
        const s = slotArray(slot);
        if (!s) {
          busy.delete(id);
          if (!root) memo.set(id, null);
          return null;
        }
        const merged = new Array(BUCKETS + 1).fill(NEG);
        const split = new Array(BUCKETS + 1).fill(-1);
        for (let b = 0; b <= BUCKETS; b++) {
          for (let k = 0; k <= b; k++) {
            if (val[b - k] === NEG || s.val[k] === NEG) continue;
            const v = val[b - k] + s.val[k];
            if (v > merged[b] + EPS) {
              merged[b] = v;
              split[b] = k;
            }
          }
        }
        val = merged;
        splits.push({ slot, s, split });
      }
      busy.delete(id);
      const res = { id, val, splits, price: o.price };
      if (!root) memo.set(id, res);
      return res;
    }

    function slotArray(slot) {
      const val = new Array(BUCKETS + 1).fill(slot.required ? NEG : 0);
      const choice = new Array(BUCKETS + 1).fill(null);
      for (const opt of slot.filters?.allowedItems ?? []) {
        if (!slot.required && offer(opt)?.stock) continue;
        const n = node(opt);
        if (!n) continue;
        for (let k = 0; k <= BUCKETS; k++) {
          if (n.val[k] > val[k] + EPS) {
            val[k] = n.val[k];
            choice[k] = opt;
          }
        }
      }
      if (slot.required && val.every((v) => v === NEG)) return null;
      return { val, choice };
    }

    function rebuild(n, b) {
      const out = { id: n.id, cost: n.price, children: [] };
      for (let j = n.splits.length - 1; j >= 0; j--) {
        const { slot, s, split } = n.splits[j];
        const k = split[b];
        const chosen = s.choice[k];
        if (chosen) {
          const child = rebuild(memo.get(chosen), k);
          out.children.unshift({ slot, node: child });
          out.cost += child.cost;
        }
        b -= k;
      }
      return out;
    }

    return (weaponId) => {
      const root = node(weaponId, true);
      if (!root) return null;
      const best = Math.max(...root.val);
      if (best === NEG) return null;
      // cheapest bucket that reaches the best score
      const b = root.val.findIndex((v) => v >= best - EPS);
      return flatten(rebuild(root, b));
    };
  }

  // ---------------------------------------------------------------- shared

  /** Tree -> flat part list (depth-first), with totals. */
  function flatten(tree) {
    const parts = [];
    const walk = (n, depth) => {
      for (const { slot, node } of n.children) {
        const it = items[node.id];
        const o = offer(node.id);
        parts.push({
          slot: slotLabel(slot.nameId),
          depth,
          id: node.id,
          recoil: recoilOf(it),
          ergo: ergoOf(it),
          price: o?.price ?? null,
          source: o?.source ?? null,
          level: o?.level ?? null,
          quest: o?.quest ?? false,
          stock: o?.stock ?? false,
        });
        walk(node, depth + 1);
      }
    };
    walk(tree, 0);
    return parts;
  }

  const conflictsOf = (id) => items[id]?.conflictingItems ?? [];

  /** First pair of parts in the build that may not be combined, or null. */
  function findClash(parts) {
    const ids = new Set(parts.map((p) => p.id));
    for (const p of parts) {
      const other = conflictsOf(p.id).find((c) => ids.has(c));
      if (other) return [p.id, other];
    }
    return null;
  }

  /**
   * Conflicts (e.g. a grip with a built-in stock vs every separate stock) are resolved by a small
   * breadth-first search: for a clash A×B try "keep A" (ban everything A conflicts with) and
   * "keep B", and keep the best conflict-free build found.
   */
  function solveConsistent(weaponId, makeSolver) {
    const queue = [new Set()];
    const seen = new Set();
    let best = null;
    for (let tries = 0; queue.length && tries < 16; tries++) {
      const banned = queue.shift();
      const parts = makeSolver(banned)(weaponId);
      if (!parts) continue;
      const clash = findClash(parts);
      if (!clash) {
        const score = parts.reduce((s, p) => s + partScore(items[p.id]), 0);
        if (!best || score > best.score + EPS) best = { parts, score };
        continue;
      }
      const [a, b] = clash;
      for (const [keep, drop] of [[a, b], [b, a]]) {
        const next = new Set([...banned, drop, ...conflictsOf(keep)]);
        next.delete(keep);
        const key = [...next].sort().join(",");
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(next);
        }
      }
    }
    return best?.parts ?? null;
  }

  function summarize(weapon, parts) {
    if (!parts) return null;
    const p = weapon.properties;
    const rec = parts.reduce((s, x) => s + x.recoil, 0);
    const ergo = parts.reduce((s, x) => s + x.ergo, 0);
    return {
      recoilV: Math.round(p.recoilVertical * (1 + rec)),
      recoilH: Math.round(p.recoilHorizontal * (1 + rec)),
      ergo: Math.max(0, Math.min(100, Math.round(p.ergonomics + ergo))),
      cost: Math.round(parts.reduce((s, x) => s + (x.price ?? 0), 0)),
      parts,
    };
  }

  // ---------------------------------------------------------------- per weapon

  const weapons = [];
  const usedItems = new Set();
  const metaShared = metaSolver(new Set());
  const budgetShared = new Map(BUDGET_CAPS.map((cap) => [cap, budgetSolver(cap, new Set())]));

  for (const g of Object.values(items)) {
    if (!g.types?.includes("gun") || !g.properties?.slots) continue;
    const cls = tr.items(categories?.[g.categories?.[0]]?.name, "") || "Overig";
    if (SKIP_CATEGORIES.has(cls)) continue;
    const p = g.properties;

    const solve = (makeSolver, shared) => {
      const first = shared(g.id);
      if (!first) return null;
      return findClash(first) ? solveConsistent(g.id, makeSolver) : first;
    };

    const budget = {};
    for (const cap of BUDGET_CAPS) {
      budget[cap] = summarize(g, solve((banned) => budgetSolver(cap, banned), budgetShared.get(cap)));
    }
    // ergonomics above 100 is wasted, which the tree search can't see: pick meta on the capped stats
    const realValue = (b) => (b ? -100 * b.parts.reduce((s, x) => s + x.recoil, 0) + ERGO_WEIGHT * (b.ergo - Math.round(p.ergonomics)) - b.cost * PRICE_WEIGHT : -Infinity);
    const meta = [summarize(g, solve((banned) => metaSolver(banned), metaShared)), ...Object.values(budget)]
      .filter(Boolean)
      .sort((a, b) => realValue(b) - realValue(a))[0] ?? null;

    const def = items[p.defaultPreset];
    const presetInfo = (pr) => ({
      id: pr.id,
      name: tr.items(pr.name, pr.normalizedName),
      recoilV: pr.properties?.recoilVertical ?? null,
      recoilH: pr.properties?.recoilHorizontal ?? null,
      ergo: pr.properties?.ergonomics != null ? Math.round(pr.properties.ergonomics) : null,
      offer: offer(pr.id),
    });
    const traderPresets = (p.presets ?? [])
      .map((id) => items[id])
      .filter((pr) => pr?.buyFromTrader?.length)
      .map(presetInfo)
      .sort((a, b) => (a.recoilV ?? 999) - (b.recoilV ?? 999));

    for (const build of [meta, ...Object.values(budget)]) for (const part of build?.parts ?? []) usedItems.add(part.id);
    weapons.push({
      id: g.id,
      name: tr.items(g.name, g.normalizedName),
      shortName: tr.items(g.shortName, ""),
      icon: g.iconLink ?? null,
      image: g.gridImageLink ?? null,
      image512: g.image512pxLink ?? null,
      wiki: g.wikiLink ?? null,
      category: cls,
      caliber: p.caliber ?? null,
      fireRate: p.fireRate ?? null,
      base: { recoilV: p.recoilVertical, recoilH: p.recoilHorizontal, ergo: Math.round(p.ergonomics) },
      offer: offer(g.id),
      default: def ? presetInfo(def) : null,
      meta,
      budget,
      traderPresets,
    });
  }

  const parts = {};
  for (const id of usedItems) {
    const it = items[id];
    parts[id] = {
      name: tr.items(it.name, it.normalizedName),
      shortName: tr.items(it.shortName, ""),
      icon: it.iconLink ?? null,
      image: it.image512pxLink ?? null,
      wiki: it.wikiLink ?? null,
    };
  }
  weapons.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return { caps: BUDGET_CAPS, ergoWeight: ERGO_WEIGHT, weapons, parts };
}

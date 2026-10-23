// Approximate side view of a build, composed from separate part images.
// Not a render: positions and sizes are estimated per slot type (the data has no mount points).
// Units are centimetres; the front (muzzle) is on the left, like the game's item images.

const BARE_LENGTH = { "Assault rifle": 68, "Assault carbine": 55, SMG: 35, "Marksman rifle": 85, "Sniper rifle": 90, Machinegun: 90, Shotgun: 80, Handgun: 18, Revolver: 22 };
// bare item is only a lower/trigger group when the barrel or an upper receiver is a separate part
const LOWER_LENGTH = { "Assault rifle": 26, "Assault carbine": 26, SMG: 18, "Marksman rifle": 30, "Sniper rifle": 35, Machinegun: 35, Shotgun: 45, Handgun: 15, Revolver: 15 };
const UPPER = /receiver|upper/i;
const COVER = /dust cover|cover|slide/i;
const BARREL_LENGTH = { "Assault rifle": 35, "Assault carbine": 30, SMG: 20, "Marksman rifle": 50, "Sniper rifle": 60, Machinegun: 55, Shotgun: 50, Handgun: 11, Revolver: 12 };
const SKIP = new Set(["Trekker", "Hamer", "Catch", "Vizier", "Tactisch", "Magazijn", "Charging handle"]);
const Z = { Kolf: 1, Loop: 2, "Gas block": 3, Wapen: 4, Receiver: 5, Handguard: 6, Mount: 7, Mondingsstuk: 8, Pistoolgreep: 8, Voorgreep: 9 };

/** Length printed in a part name: 10.3" / 16 inch / 127mm (but not calibers like 5.45x39mm). */
function nameLength(name) {
  const inch = /(\d+(?:\.\d+)?)\s*(?:"|''|-?inch\b)/i.exec(name);
  if (inch) return Number(inch[1]) * 2.54;
  const mm = /(?<![x\d.])(\d{2,4})\s*mm\b/i.exec(name);
  if (mm) return Number(mm[1]) / 10;
  return null;
}

function partLength(slot, name, cat, handgun) {
  const n = name.toLowerCase();
  switch (slot) {
    case "Mondingsstuk":
      if (/suppressor|silencer|moderator/.test(n)) return handgun ? 14 : 19;
      if (/adapter|thread|protector/.test(n)) return 3;
      return handgun ? 4 : 7.5;
    case "Loop":
      return nameLength(name) ?? BARREL_LENGTH[cat] ?? 35;
    case "Handguard":
      return nameLength(name) ?? (cat === "SMG" ? 16 : /extension|ext\b/.test(n) ? 10 : 24);
    case "Gas block":
      return /tube/.test(n) ? 22 : 4;
    case "Kolf":
      if (/buffer|tube|extension|adapter/.test(n)) return 17;
      return handgun ? 0 : 26;
    case "Pistoolgreep":
      if (handgun) return 0;
      return /adapter/.test(n) ? 5 : 11;
    case "Voorgreep":
      return /rail/.test(n) ? nameLength(name) ?? 10 : 9;
    case "Mount":
      if (/trunnion/.test(n)) return 0;
      return /rail|bridge|full length/.test(n) ? 16 : 6;
    case "Receiver":
      if (handgun) return 18;
      return /dust cover|cover/.test(n) ? 22 : 23;
    default:
      return 0;
  }
}

/**
 * @param weapon  { id, category }
 * @param parts   build.parts (flattened, with depth)
 * @param geo     id -> image geometry { w, h, box, cx, cy, angle, len, thick }
 * @param names   id -> display name
 * @returns { nodes: [{ id, slot, x, y, w, h, rotate, z }], bounds } in cm, or null
 */
export function layoutBuild(weapon, parts, geo, names) {
  const wg = geo[weapon.id];
  if (!wg) return null;
  const cat = weapon.category;
  const handgun = cat === "Handgun" || cat === "Revolver";
  const isUpper = (p) => !handgun && p.slot === "Receiver" && p.depth === 0 && UPPER.test(names[p.id] ?? "") && !COVER.test(names[p.id] ?? "");
  const hasUpper = parts.some(isUpper);
  const modular = hasUpper || parts.some((p) => p.slot === "Loop");
  const bare = modular ? LOWER_LENGTH[cat] ?? 26 : BARE_LENGTH[cat] ?? 60;
  const [bx0, by0, bx1, by1] = wg.box;
  const W = { id: weapon.id, slot: "Wapen", x: 0, y: 0, w: bare, h: (bare * (by1 - by0)) / (bx1 - bx0), rotate: false, z: Z.Wapen };
  const axisY = W.y + W.h * (handgun ? 0.25 : 0.22);
  const nodes = [W];
  const rectOf = new Map(); // part index -> rect used as parent for its children
  const stack = [];

  parts.forEach((p, i) => {
    stack[p.depth] = i;
    const parentIdx = p.depth ? stack[p.depth - 1] : null;
    const P = parentIdx == null ? W : rectOf.get(parentIdx) ?? W;
    const parentSlot = parentIdx == null ? "Wapen" : parts[parentIdx].slot;
    const g = geo[p.id];
    // a stock/grip/muzzle part that carries another part of the same kind is a connector (adapter, tube): keep it small
    const connector = parts[i + 1]?.depth === p.depth + 1 && parts[i + 1]?.slot === p.slot && ["Kolf", "Pistoolgreep", "Mondingsstuk"].includes(p.slot);
    const len = SKIP.has(p.slot) || !g ? 0 : connector ? (p.slot === "Kolf" ? 7 : 4) : partLength(p.slot, names[p.id] ?? "", cat, handgun);
    if (!len) {
      rectOf.set(i, P);
      return;
    }
    const nm = (names[p.id] ?? "").toLowerCase();
    const vertical = !connector && ((p.slot === "Pistoolgreep" && !/adapter/.test(nm)) || (p.slot === "Voorgreep" && !/rail/.test(nm)));
    const bw = g.box[2] - g.box[0];
    const bh = g.box[3] - g.box[1];
    let w, h, rotate = false;
    if (!vertical && g.len / Math.max(1, g.thick) >= 1.8) {
      w = len;
      h = (len * g.thick) / g.len;
      rotate = true;
    } else if (vertical) {
      h = len;
      w = (len * bw) / bh;
    } else {
      const m = Math.max(bw, bh);
      w = (len * bw) / m;
      h = (len * bh) / m;
    }
    // stocks drawn from a 3/4 view can come out taller than the gun itself
    if (p.slot === "Kolf" && h > 1.3 * W.h) {
      w *= (1.3 * W.h) / h;
      h = 1.3 * W.h;
    }
    // a mount that carries a foregrip (anywhere below it) goes under the handguard, not on top
    let hasForegrip = false;
    for (let j = i + 1; j < parts.length && parts[j].depth > p.depth; j++) if (parts[j].slot === "Voorgreep") hasForegrip = true;
    const upperParent = parentIdx != null && isUpper(parts[parentIdx]);
    const pos = place(p.slot, { w, h }, P, parentSlot, { W, axisY, modular, handgun, hasForegrip, upper: isUpper(p), upperParent, name: nm });
    if (!pos) {
      rectOf.set(i, P);
      return;
    }
    const node = { id: p.id, index: i, slot: p.slot, x: pos.x, y: pos.y, w, h, rotate, z: Z[p.slot] ?? 5 };
    nodes.push(node);
    rectOf.set(i, node);
  });

  const bounds = {
    x0: Math.min(...nodes.map((n) => n.x)),
    y0: Math.min(...nodes.map((n) => n.y)),
    x1: Math.max(...nodes.map((n) => n.x + n.w)),
    y1: Math.max(...nodes.map((n) => n.y + n.h)),
  };
  return { nodes: nodes.sort((a, b) => a.z - b.z), bounds };
}

function place(slot, { w, h }, P, parentSlot, ctx) {
  const { W, axisY, modular, handgun, hasForegrip, upper, upperParent, name } = ctx;
  const at = (right, cy) => ({ x: right - w, y: cy - h / 2 });
  switch (slot) {
    case "Mondingsstuk":
      if (parentSlot === "Wapen") return at(W.x + 0.3 * w, axisY);
      if (upperParent) return at(P.x + 0.25 * w, P.y + 0.3 * P.h); // integral barrel (MP5-style receiver)
      return at(P.x + 0.2 * w, P.y + P.h / 2);
    case "Loop":
      // pistol barrels hang off the frame but sit inside the slide, which rides on top of the frame
      if (handgun) return parentSlot === "Wapen" ? { x: W.x - 0.02 * W.w, y: W.y + 0.02 * W.h - h / 2 } : { x: P.x + 0.02 * P.w, y: P.y + 0.5 * P.h - h / 2 };
      if (parentSlot === "Wapen") return at(W.x + 0.1 * W.w, axisY);
      return at(P.x + 0.18 * P.w, P.y + 0.35 * P.h);
    case "Handguard":
      if (parentSlot === "Handguard") return at(P.x + 0.15 * w, P.y + P.h / 2);
      if (parentSlot === "Loop") return at(P.x + 0.85 * P.w, P.y + P.h / 2 + 0.2 * h); // shotgun forend
      if (parentSlot === "Receiver" && modular) return at(P.x + 0.06 * P.w, P.y + 0.45 * P.h);
      return at(W.x + 0.56 * W.w, axisY + 0.12 * h);
    case "Gas block":
      if (parentSlot === "Loop") return { x: P.x + 0.32 * P.w - w / 2, y: P.y + P.h / 2 - 0.7 * h };
      return { x: W.x + 0.56 * W.w - w, y: axisY - 0.95 * h };
    case "Receiver":
      if (handgun) return { x: W.x - 0.04 * W.w, y: W.y - 0.45 * h };
      if (upper) return { x: W.x + 0.98 * W.w - w, y: W.y + 0.3 * W.h - h }; // upper sits on the lower, flush at the rear
      return { x: W.x + 0.5 * W.w, y: W.y - 0.25 * h };
    case "Kolf":
      if (parentSlot === "Kolf") return { x: P.x + 0.2 * P.w, y: P.y + P.h / 2 - h * 0.45 };
      // buffer tubes slide mostly behind the lower (its image often shows one already)
      if (/buffer|tube|extension/.test(name)) return { x: P.x + P.w - 0.75 * w, y: P.y + 0.08 * P.h };
      return { x: P.x + P.w - 0.06 * w, y: P.y + 0.02 * P.h };
    case "Pistoolgreep":
      if (parentSlot === "Pistoolgreep") return { x: P.x + 0.5 * P.w - w / 2, y: P.y + 0.6 * P.h };
      return { x: P.x + (modular ? 0.62 : 0.7) * P.w - w / 2, y: P.y + 0.45 * P.h };
    case "Voorgreep":
      return { x: P.x + 0.45 * P.w - w / 2, y: P.y + 0.6 * P.h };
    case "Mount":
      if (hasForegrip) return { x: P.x + 0.45 * P.w - w / 2, y: P.y + P.h - 0.6 * h };
      return { x: P.x + 0.5 * P.w - w / 2, y: P.y - 0.7 * h };
    default:
      return null;
  }
}

const xml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** SVG markup for a layout. href(id) gives each image's URL, title(node) an optional tooltip. Parts get data-part = index in build.parts. */
export function layoutSvg(layout, geo, href, { width = 900, pad = 16, title = null } = {}) {
  const { nodes, bounds } = layout;
  const bw = bounds.x1 - bounds.x0;
  const bh = bounds.y1 - bounds.y0;
  const scale = (width - 2 * pad) / bw;
  const height = Math.round(bh * scale + 2 * pad);
  const parts = nodes.map((n) => {
    const g = geo[n.id];
    const cx = pad + (n.x - bounds.x0 + n.w / 2) * scale;
    const cy = pad + (n.y - bounds.y0 + n.h / 2) * scale;
    const [x0, y0, x1, y1] = g.box;
    const k = n.rotate ? (n.w * scale) / g.len : (n.w * scale) / (x1 - x0);
    const icx = n.rotate ? g.cx : (x0 + x1) / 2;
    const icy = n.rotate ? g.cy : (y0 + y1) / 2;
    const rot = n.rotate ? ` rotate(${(-g.angle).toFixed(2)})` : "";
    const tip = title ? `<title>${xml(title(n))}</title>` : "";
    const attr = n.index != null ? ` data-part="${n.index}"` : "";
    return `<g${attr} transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})${rot} scale(${k.toFixed(4)}) translate(${(-icx).toFixed(1)} ${(-icy).toFixed(1)})">${tip}<image href="${xml(href(n.id))}" width="${g.w}" height="${g.h}"/></g>`;
  });
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">${parts.join("")}</svg>`, width, height };
}

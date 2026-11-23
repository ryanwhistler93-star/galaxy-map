/**
 * Galaxy Map — an Elite: Dangerous-style 3D star map for Foundry VTT v14.
 *
 * - Any Scene can be flagged as a Galaxy Map (Scene directory → right-click → "Toggle Galaxy Map").
 * - Close up the camera orbits in 3D; as you zoom out it tilts to a straight top-down chart.
 * - GM tools: paint/erase faction territory, add star systems, add fast-travel points and link them.
 * - All map data lives in the Scene's flags, so it is saved with the world and synced to players.
 */

const MODULE_ID = "galaxy-map";
const FLAG = "data";
const SOCKET = `module.${MODULE_ID}`;
const THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";

const EXTENT = 1000;          // map covers -EXTENT..EXTENT on X and Z (world units)
const RES = 200;              // territory paint grid resolution (cells per side)
const UNITS_PER_LY = 10;      // shown distance = units / UNITS_PER_LY
const GATE_COLOR = "#3ff0de";
const LEVEL_STEP = 20;        // vertical spacing of placement levels (world units)
const MAX_LEVEL = 12;
const LOCKED_VIEW = { tx: 0, ty: 0, tz: 0, dist: 2600, yaw: 0, pitch: 35 };
const MOVE_KEYS = { KeyW: [1, 0], KeyS: [-1, 0], KeyA: [0, -1], KeyD: [0, 1] };   // [forward, right]         // levels run from -MAX_LEVEL to +MAX_LEVEL
const STAR_COLORS = ["#9bb0ff", "#cad7ff", "#f8f7ff", "#fff4ea", "#ffe3b0", "#ffcc6f", "#ff9a5c"];

let THREE = null;
let activeMap = null;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const uid = () => foundry.utils.randomID(10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function hexToRgb(hex) {
  const n = parseInt(String(hex ?? "#ffffff").replace("#", "").padEnd(6, "f").slice(0, 6), 16);
  return Number.isNaN(n) ? [1, 1, 1] : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function rleEncode(arr) {
  if (!arr.length) return "";
  const out = []; let prev = arr[0], n = 0;
  for (const v of arr) { if (v === prev) n++; else { out.push(`${prev}x${n}`); prev = v; n = 1; } }
  out.push(`${prev}x${n}`);
  return out.join(",");
}
function rleDecode(str, size) {
  const arr = new Uint8Array(size);
  if (!str) return arr;
  let i = 0;
  for (const part of str.split(",")) { const [v, n] = part.split("x").map(Number); arr.fill(v, i, Math.min(size, i + n)); i += n; }
  return arr;
}

function hslHex(h, s, l) {
  const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0"); };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Light years per world unit for the open map (set per map in data.galaxy.lyPerUnit). */
function lyPerUnit() {
  const v = Number(activeMap?.data?.galaxy?.lyPerUnit);
  return v > 0 ? v : 1 / UNITS_PER_LY;
}
function fmtLy(units) {
  const ly = units * lyPerUnit();
  return `${Math.abs(ly) >= 100 ? Math.round(ly).toLocaleString() : ly.toFixed(1)} ly`;
}
function fmtLevel(y) {
  const l = y / LEVEL_STEP, lv = Number.isInteger(l) ? l : l.toFixed(1);
  return `${l > 0 ? "+" : ""}${lv} (${fmtLy(y)})`;
}

function routeFor(path) {
  const fn = foundry.utils.getRoute ?? globalThis.getRoute;
  return fn ? fn(path) : `/${path}`;
}

async function loadThree() {
  if (THREE) return THREE;
  try { THREE = await import(routeFor(`modules/${MODULE_ID}/lib/three.module.js`)); }
  catch (err) {
    console.log(`${MODULE_ID} | No bundled three.js found in lib/, loading from CDN.`);
    THREE = await import(THREE_CDN);
  }
  return THREE;
}

function readForm(form) {
  const out = {};
  for (const el of form?.elements ?? []) {
    if (!el.name) continue;
    out[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  return out;
}

/** Show a form dialog and resolve with its values (or null if cancelled). */
async function formDialog(title, content, okLabel = "Save") {
  const { DialogV2 } = foundry.applications.api;
  try {
    return await DialogV2.prompt({
      window: { title },
      position: { width: 420 },
      content,
      rejectClose: false,
      ok: { label: okLabel, callback: (event, button) => readForm(button.form) }
    });
  } catch { return null; }
}
async function confirmDialog(title, content) {
  const { DialogV2 } = foundry.applications.api;
  try { return await DialogV2.confirm({ window: { title }, content, rejectClose: false }); }
  catch { return false; }
}

/** Sample a point from the galaxy's shape. Returns {x, y, z, r, core}. */
function galaxyPoint(rnd, gp) {
  const E = EXTENT, g = () => (rnd() + rnd() + rnd() + rnd() - 2) / 2;
  const shape = gp.shape ?? "spiral";
  let x, z, y, core = false;
  if (shape === "elliptical") {
    const r = Math.abs(g()) * E * 0.55, a = rnd() * Math.PI * 2;
    x = Math.cos(a) * r; z = Math.sin(a) * r * 0.65; y = g() * 90 * (1 - r / E); core = r < E * 0.15;
  } else if (shape === "irregular") {
    const cr = mulberry32(hashStr(`${gp.seed}clumps`)), n = 4 + Math.floor(cr() * 4), clumps = [];
    for (let i = 0; i < n; i++) clumps.push([(cr() - 0.5) * E * 1.2, (cr() - 0.5) * E * 1.2, E * (0.1 + cr() * 0.18)]);
    const [cx, cz, cr2] = clumps[Math.floor(rnd() * n)];
    x = cx + g() * cr2; z = cz + g() * cr2; y = g() * 50; core = rnd() < 0.1;
  } else if (shape === "ring") {
    if (rnd() < 0.15) { const r = Math.abs(g()) * E * 0.15, a = rnd() * Math.PI * 2; x = Math.cos(a) * r; z = Math.sin(a) * r; core = true; }
    else { const r = E * (0.62 + g() * 0.12), a = rnd() * Math.PI * 2; x = Math.cos(a) * r; z = Math.sin(a) * r; }
    y = g() * 35;
  } else {
    const arms = gp.arms ?? 4, twist = gp.twist ?? 4.2;
    if (rnd() < 0.22) {
      const r = Math.abs(g()) * E * 0.24, a = rnd() * Math.PI * 2;
      x = Math.cos(a) * r; z = Math.sin(a) * r; y = g() * 70 * (1 - r / (E * 0.5)); core = true;
    } else {
      const armI = Math.floor(rnd() * arms), r = E * (0.08 + Math.pow(rnd(), 0.8) * 0.9);
      const th = armI * Math.PI * 2 / arms + (gp.rotation ?? 0) + (r / E) * twist + g() * 0.42;
      x = Math.cos(th) * r; z = Math.sin(th) * r; y = g() * 30 * (1 - r / E) + g() * 6;
    }
  }
  const r = Math.hypot(x, z);
  if (r > E * 0.97) { x *= E * 0.97 / r; z *= E * 0.97 / r; }
  return { x, y, z, r: Math.min(r, E * 0.97), core };
}

/** Ways to break a name into 1–3 balanced lines (word boundaries only). */
function nameLayouts(words) {
  const out = [[words.join(" ")]];
  const best = n => {
    let pick = null;
    const rec = (start, left, acc) => {
      if (left === 1) {
        const lines = [...acc, words.slice(start).join(" ")];
        const longest = Math.max(...lines.map(l => l.length));
        if (!pick || longest < pick.longest) pick = { longest, lines };
        return;
      }
      for (let k = start + 1; k <= words.length - left + 1; k++) rec(k, left - 1, [...acc, words.slice(start, k).join(" ")]);
    };
    rec(0, n, []);
    return pick?.lines;
  };
  for (let n = 2; n <= Math.min(3, words.length); n++) out.push(best(n));
  return out;
}

/**
 * Find the largest axis-aligned box of the given aspect (width / height) that lies entirely inside
 * the territory cells equal to `value`. Returns { cx, cy, w, h } in cell units (centre + size) or null.
 */
function fitLabelBox(cells, res, value, aspect, pad = 0.6) {
  const W = res + 1, sat = new Int32Array(W * W);
  let count = 0;
  for (let y = 0; y < res; y++) {
    let row = 0;
    for (let x = 0; x < res; x++) {
      const inside = cells[y * res + x] === value ? 1 : 0;
      row += inside; count += inside;
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  if (!count) return null;
  const full = (x0, y0, x1, y1) => {              // inclusive cell bounds
    if (x0 < 0 || y0 < 0 || x1 >= res || y1 >= res) return false;
    const n = sat[(y1 + 1) * W + x1 + 1] - sat[y0 * W + x1 + 1] - sat[(y1 + 1) * W + x0] + sat[y0 * W + x0];
    return n === (x1 - x0 + 1) * (y1 - y0 + 1);
  };
  const fits = (cx, cy, h) => {
    const w = h * aspect + pad * 2, hh = h + pad * 2;
    return full(Math.floor(cx - w / 2), Math.floor(cy - hh / 2), Math.ceil(cx + w / 2) - 1, Math.ceil(cy + hh / 2) - 1);
  };
  let best = null;
  const step = count > 4000 ? 2 : 1;
  for (let y = 0; y < res; y += step) for (let x = 0; x < res; x += step) {
    if (cells[y * res + x] !== value) continue;
    const cx = x + 0.5, cy = y + 0.5;
    const lo0 = best ? best.h : 0.5;
    if (!fits(cx, cy, lo0 + 0.01)) continue;        // can't beat the current best here
    let lo = lo0, hi = res;
    for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (fits(cx, cy, mid)) lo = mid; else hi = mid; }
    if (!best || lo > best.h) best = { cx, cy, h: lo, w: lo * aspect };
  }
  if (!best) {                                     // territory too thin for a box: centre of mass, tiny text
    let sx = 0, sy = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i] === value) { sx += i % res + 0.5; sy += Math.floor(i / res) + 0.5; }
    best = { cx: sx / count, cy: sy / count, h: 0.8, w: 0.8 * aspect };
  }
  return best;
}

/* -------------------------------------------- */
/*  Data                                        */
/* -------------------------------------------- */

function normalize(raw) {
  const d = foundry.utils.deepClone(raw ?? {});
  d.factions ??= [];
  d.systems ??= [];
  d.gates ??= [];
  for (const g of d.gates) g.links ??= [];
  d.territory ??= { res: RES, cells: "" };
  d.partyAt ??= null;
  d.galaxy ??= { seed: null, shape: "spiral", arms: 4, twist: 4.2 };
  d.backdrop = { src: "", scale: 1, x: 0, z: 0, opacity: 0.85, ...(d.backdrop ?? {}) };
  return d;
}

/** A small starter sector so a fresh map is not empty. */
function defaultData(seed) {
  const rnd = mulberry32(hashStr(seed));
  const factions = [
    { id: uid(), name: "Faction One", color: "#3fa7ff" },
    { id: uid(), name: "Faction Two", color: "#ff6a4d" },
    { id: uid(), name: "Faction Three", color: "#b77dff" }
  ];
  const names = ["Vael", "Korrin", "Dusk Harbor", "Teth", "Ostrava", "Kalyx", "Merrow", "Sable Point", "Ixion",
    "Calder", "Nyx Prime", "Rhune", "Brightwater", "Zephyr", "Tamsin's Star", "Hollow", "Grist", "Ember"];
  const systems = names.map(name => {
    const r = 120 + rnd() * 620, a = rnd() * Math.PI * 2;
    return {
      id: uid(), name, x: Math.cos(a) * r, z: Math.sin(a) * r, y: Math.round((rnd() - 0.5) * 120),
      color: STAR_COLORS[Math.floor(rnd() * STAR_COLORS.length)], size: rnd() < 0.2 ? 2 : 1,
      hidden: false, journal: "", notes: ""
    };
  });
  const gatePos = [[-520, -180], [-120, -560], [430, -330], [520, 260], [40, 560], [-430, 380]];
  const gateNames = ["Gate Alpha", "Gate Beta", "Gate Gamma", "Gate Delta", "Gate Epsilon", "Gate Zeta"];
  const gates = gatePos.map(([x, z], i) => ({ id: uid(), name: gateNames[i], x, z, y: 0, links: [], hidden: false, journal: "", notes: "" }));
  const link = (a, b) => { gates[a].links.push(gates[b].id); gates[b].links.push(gates[a].id); };
  [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 3]].forEach(([a, b]) => link(a, b));

  // Paint a rough blob of territory for each faction.
  const cells = new Uint8Array(RES * RES);
  const centres = [[-420, -250, 30], [400, -100, 34], [-60, 450, 26]];
  centres.forEach(([x, z, r], fi) => {
    const cx = (x + EXTENT) / (2 * EXTENT) * RES, cy = (EXTENT - z) / (2 * EXTENT) * RES, ph = rnd() * 6;
    for (let y = Math.floor(cy - r * 1.4); y <= cy + r * 1.4; y++) for (let xx = Math.floor(cx - r * 1.4); xx <= cx + r * 1.4; xx++) {
      if (xx < 0 || y < 0 || xx >= RES || y >= RES) continue;
      const dx = xx - cx, dy = y - cy, ang = Math.atan2(dy, dx);
      const rr = r * (0.85 + 0.18 * Math.sin(ang * 3 + ph) + 0.08 * Math.sin(ang * 7 + ph * 2));
      if (dx * dx + dy * dy <= rr * rr) cells[y * RES + xx] = fi + 1;
    }
  });

  return { factions, systems, gates, territory: { res: RES, cells: rleEncode(cells) }, partyAt: gates[0].id };
}

/* -------------------------------------------- */
/*  Random galaxy generator                     */
/* -------------------------------------------- */

const SYLLABLES = ["ka", "vel", "or", "tes", "mar", "ix", "an", "zu", "cor", "dra", "sel", "thy", "nor", "bel", "kai", "ra",
  "ven", "sol", "ae", "lu", "myr", "ost", "qua", "rho", "sar", "tal", "ul", "yr", "zan", "gal", "ner", "vos", "ith", "cal", "dun", "es"];
const FACTION_ADJ = ["Ashen", "Crimson", "Free", "Iron", "Silent", "Gilded", "Hollow", "Radiant", "Obsidian", "Azure",
  "Verdant", "Shattered", "Eternal", "Sovereign", "Outer", "Vigilant", "Black", "Golden", "Last", "Burning"];
const FACTION_NOUN = ["Concord", "Syndicate", "Compact", "Hegemony", "League", "Collective", "Dominion", "Covenant",
  "Directorate", "Union", "Accord", "Cartel", "Republic", "Assembly", "Freehold", "Mandate", "Combine", "Tribunal"];
const STAR_WEIGHTS = [3, 5, 8, 12, 14, 22, 36];   // matches STAR_COLORS: rare blue giants … common red dwarfs

/** Returns a function producing unique random system names (names already in `used` are skipped). */
function makeSystemNamer(rnd, used) {
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const lower = new Set([...used].map(n => n.toLowerCase()));
  return () => {
    for (let tries = 0; tries < 80; tries++) {
      let n = ""; const parts = 2 + (rnd() < 0.3 ? 1 : 0);
      for (let i = 0; i < parts; i++) n += pick(SYLLABLES);
      n = n.charAt(0).toUpperCase() + n.slice(1);
      const r = rnd();
      if (r < 0.1) n += " Prime"; else if (r < 0.18) n += ` ${pick(["II", "III", "IV", "VII", "IX"])}`;
      else if (r < 0.23) n += " Major"; else if (r < 0.28) n = `${pick(["New ", "Port ", "Fort ", "Old "])}${n}`;
      if (!lower.has(n.toLowerCase())) { lower.add(n.toLowerCase()); used.add(n); return n; }
    }
    return `System ${used.size + 1}`;
  };
}
function randomStarColor(rnd) {
  let t = rnd() * STAR_WEIGHTS.reduce((a, b) => a + b, 0);
  for (let i = 0; i < STAR_WEIGHTS.length; i++) { t -= STAR_WEIGHTS[i]; if (t <= 0) return STAR_COLORS[i]; }
  return STAR_COLORS.at(-1);
}

function generateGalaxy(opts = {}) {
  const E = EXTENT;
  const seed = String(opts.seed || foundry.utils.randomID(8));
  const rnd = mulberry32(hashStr(seed));
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const g = () => (rnd() + rnd() + rnd() + rnd() - 2) / 2;
  const nSys = clamp(Number(opts.systems) || 80, 5, 400);
  const nGates = clamp(Number(opts.gates) || 0, 0, 40);
  const nFac = clamp(Number(opts.factions) || 0, 0, 12);
  const spread = clamp(Number.isFinite(Number(opts.spread)) && opts.spread !== "" ? Number(opts.spread) : 3, 0, MAX_LEVEL);
  const shape = ["spiral", "elliptical", "irregular", "ring"].includes(opts.shape) ? opts.shape : "spiral";
  const galaxy = { seed, shape, arms: clamp(Number(opts.arms) || 4, 2, 6), twist: 3 + rnd() * 2.5 };

  // Names
  const used = new Set();
  const sysName = makeSystemNamer(rnd, used);
  const weighted = () => randomStarColor(rnd);

  // Star systems, spaced apart, following the galaxy shape, snapped to levels
  const minSep = clamp(E * 1.6 / Math.sqrt(nSys), 18, 90);
  const systems = [];
  for (let tries = 0; systems.length < nSys && tries < nSys * 60; tries++) {
    const p = galaxyPoint(rnd, galaxy);
    if (p.r < E * 0.06) continue;                       // keep the very core clear
    const sep = minSep * Math.max(0.3, 1 - tries / (nSys * 45));
    if (systems.some(s => Math.hypot(s.x - p.x, s.z - p.z) < sep)) continue;
    const lvl = clamp(Math.round(g() * spread * 1.8 * (1 - 0.4 * p.r / E)), -spread, spread);
    const sz = rnd();
    systems.push({
      id: uid(), name: sysName(), x: p.x, z: p.z, y: lvl * LEVEL_STEP, color: weighted(),
      size: sz < 0.015 ? 3 : sz < 0.06 ? 2 : sz < 0.16 ? 1.5 : 1, hidden: false, journal: "", notes: "", sceneId: ""
    });
  }

  // Spread-out picks via farthest-point sampling
  const farthest = (pool, k) => {
    if (!pool.length || k <= 0) return [];
    const chosen = [pool[Math.floor(rnd() * pool.length)]];
    while (chosen.length < Math.min(k, pool.length)) {
      let best = null, bd = -1;
      for (const s of pool) {
        if (chosen.includes(s)) continue;
        const d = Math.min(...chosen.map(c => Math.hypot(c.x - s.x, c.z - s.z))) * (0.75 + rnd() * 0.5);
        if (d > bd) { bd = d; best = s; }
      }
      chosen.push(best);
    }
    return chosen;
  };

  // Fast-travel points near well-spread systems, joined by a minimum spanning tree + a few extra loops
  const gates = farthest(systems, nGates).map(s => {
    const a = rnd() * Math.PI * 2, off = 18 + rnd() * 10;
    return { id: uid(), name: `${s.name} Relay`, x: s.x + Math.cos(a) * off, z: s.z + Math.sin(a) * off, y: s.y, links: [], hidden: false, journal: "", notes: "", sceneId: "" };
  });
  const gd = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const link = (a, b) => { if (!a.links.includes(b.id)) { a.links.push(b.id); b.links.push(a.id); } };
  if (gates.length > 1) {
    const inTree = new Set([gates[0]]);
    while (inTree.size < gates.length) {
      let best = null, bd = Infinity;
      for (const a of inTree) for (const b of gates) if (!inTree.has(b) && gd(a, b) < bd) { bd = gd(a, b); best = [a, b]; }
      link(...best); inTree.add(best[1]);
    }
    for (const a of gates) {
      const near = gates.filter(b => b !== a && !a.links.includes(b.id)).sort((p, q) => gd(a, p) - gd(a, q));
      if (near[0] && rnd() < 0.35) link(a, near[0]);
    }
  }

  // Factions: spread-out capitals, each with a few influence seeds; territory is a noisy weighted Voronoi
  const usedF = new Set();
  const facName = () => { for (let i = 0; i < 40; i++) { const n = `The ${pick(FACTION_ADJ)} ${pick(FACTION_NOUN)}`; if (!usedF.has(n)) { usedF.add(n); return n; } } return `Faction ${usedF.size + 1}`; };
  const hue0 = rnd();
  const factions = [], seeds = [];
  farthest(systems, nFac).forEach((cap0, i) => {
    const color = hslHex((hue0 + i / Math.max(1, nFac)) % 1, 0.75, 0.58);
    factions.push({ id: uid(), name: facName(), color });
    const R = E * (0.14 + rnd() * 0.16);
    seeds.push({ f: i + 1, x: cap0.x, z: cap0.z, R });
    const nearby = systems.filter(s => s !== cap0 && Math.hypot(s.x - cap0.x, s.z - cap0.z) < R * 1.1);
    for (let k = 0; k < 2 && nearby.length; k++) {
      const s = nearby.splice(Math.floor(rnd() * nearby.length), 1)[0];
      seeds.push({ f: i + 1, x: s.x, z: s.z, R: R * (0.45 + rnd() * 0.35) });
    }
    cap0.notes = cap0.notes || `Capital of ${factions[i].name}.`;
  });
  const cells = new Uint8Array(RES * RES);
  if (seeds.length) {
    const ph = [rnd() * 9, rnd() * 9, rnd() * 9, rnd() * 9];
    for (let cy = 0; cy < RES; cy++) for (let cx = 0; cx < RES; cx++) {
      const x = (cx + 0.5) / RES * 2 * E - E, z = E - (cy + 0.5) / RES * 2 * E;
      const n = 0.16 * (Math.sin(x * 0.013 + ph[0]) * Math.sin(z * 0.011 + ph[1]) + 0.6 * Math.sin((x + z) * 0.021 + ph[2]) + 0.4 * Math.sin((x - z) * 0.034 + ph[3]));
      let best = 0, bd = 1;
      for (const sd of seeds) { const d = Math.hypot(x - sd.x, z - sd.z) / sd.R + n; if (d < bd) { bd = d; best = sd.f; } }
      cells[cy * RES + cx] = best;
    }
  }

  const start = gates.length ? pick(gates) : systems[0];
  return { factions, systems, gates, territory: { res: RES, cells: rleEncode(cells) }, partyAt: start?.id ?? null, galaxy };
}

/* -------------------------------------------- */
/*  Shaders                                     */
/* -------------------------------------------- */

const POINT_VS = /* glsl */`
  attribute float aSize; attribute vec3 aColor; attribute float aAlpha;
  uniform float uScale; uniform float uMin; uniform float uMax; uniform float uPR;
  varying vec3 vColor; varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(aSize * uScale / -mv.z, uMin, uMax) * uPR;
    vColor = aColor; vAlpha = aAlpha;
  }`;

const POINT_FS = /* glsl */`
  uniform float uRing; uniform float uOpacity;
  varying vec3 vColor; varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    if (d > 1.0) discard;
    float a; vec3 col;
    if (uRing > 0.5) {
      a = smoothstep(0.16, 0.0, abs(d - 0.72)) + smoothstep(0.32, 0.0, d) * 0.8;
      col = mix(vColor, vec3(1.0), smoothstep(0.25, 0.0, d) * 0.5);
    } else {
      float core = smoothstep(0.28, 0.0, d);
      float halo = exp(-d * d * 7.0);
      a = core + halo * 0.65;
      col = mix(vColor, vec3(1.0), core * 0.55);
    }
    gl_FragColor = vec4(col, a * vAlpha * uOpacity);
  }`;

const TERR_VS = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const TERR_FS = /* glsl */`
  uniform sampler2D map; uniform float uFill; uniform float uBorder; uniform float uTexel;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D(map, vUv);
    vec4 n1 = texture2D(map, vUv + vec2(uTexel, 0.0));
    vec4 n2 = texture2D(map, vUv - vec2(uTexel, 0.0));
    vec4 n3 = texture2D(map, vUv + vec2(0.0, uTexel));
    vec4 n4 = texture2D(map, vUv - vec2(0.0, uTexel));
    float a = t.a;
    if (a < 0.003) discard;
    vec3 col = t.rgb / a;
    float diff = length(n1 - t) + length(n2 - t) + length(n3 - t) + length(n4 - t);
    float border = clamp(diff * 1.6, 0.0, 1.0);
    float o = clamp(a * uFill + border * uBorder, 0.0, 1.0);
    gl_FragColor = vec4(col * o, o);
  }`;

/* -------------------------------------------- */
/*  Galaxy Map                                  */
/* -------------------------------------------- */

class GalaxyMap {
  constructor(scene) {
    this.scene = scene;
    this.data = normalize(scene.getFlag(MODULE_ID, FLAG));
    this.isGM = game.user.isGM;
    this.mode = "navigate";
    this.factionIdx = 0;
    this.brush = 4;
    this.selected = null;    // { kind, id }
    this.hovered = null;     // item
    this.linkFrom = null;    // gate id
    this.cam = { tx: 0, ty: 0, tz: 0, dist: 2400, yaw: 0, pitch: 35 };
    this.level = 0;
    this.keys = new Set();
    this.showAll = false;
    try { this.showBackdrop = localStorage.getItem(`${MODULE_ID}.backdrop`) !== "0"; } catch { this.showBackdrop = true; }
    try { this.labelRadius = Number(game.settings.get(MODULE_ID, "labelRadius")) || 200; } catch { this.labelRadius = 200; }
    try { this.editOpen = localStorage.getItem(`${MODULE_ID}.editOpen`) === "1"; } catch { this.editOpen = false; }
    this.goal = { ...this.cam };
    this.warpStart = -1;
    this.destroyed = false;
    this._listeners = [];
  }

  /* ---------- lifecycle ---------- */

  async mount() {
    await loadThree();
    if (this.destroyed) return;
    const T = THREE;

    const board = document.getElementById("board");
    const root = this.root = document.createElement("div");
    root.id = "galaxy-map";
    if (board) {
      board.after(root);
      const z = getComputedStyle(board).zIndex;
      root.style.zIndex = z === "auto" ? "0" : z;
      this._boardVis = board.style.visibility;
      board.style.visibility = "hidden";
    } else document.body.prepend(root);

    root.innerHTML = `<div class="gm-labels"></div><div class="gm-flash"></div>
      <div class="gm-toolbar"></div><div class="gm-panel hidden"></div>`;
    this.labelsEl = root.querySelector(".gm-labels");
    this.flashEl = root.querySelector(".gm-flash");
    this.toolbarEl = root.querySelector(".gm-toolbar");
    this.panelEl = root.querySelector(".gm-panel");

    const renderer = this.renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x02040a, 1);
    this.canvas = renderer.domElement;
    this.canvas.classList.add("gm-canvas");
    root.prepend(this.canvas);

    this.scene3 = new T.Scene();
    this.camera = new T.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 40000);
    this.ray = new T.Raycaster();
    this.ndc = new T.Vector2();
    this.groundPlane = new T.Plane(new T.Vector3(0, 1, 0), 0);
    this.tmpV = new T.Vector3();

    this.buildStatic();
    this.buildTerritory();
    this.rebuild();
    this.bindEvents();
    this.centerOnParty(true);

    this.last = performance.now();
    const loop = () => {
      if (this.destroyed) return;
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  destroy() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; this.writeSave(); }
    this.destroyed = true;
    clearTimeout(this._labelTimer);
    cancelAnimationFrame(this._raf);
    for (const [el, ev, fn, opt] of this._listeners) el.removeEventListener(ev, fn, opt);
    this.scene3?.traverse(o => {
      o.geometry?.dispose();
      if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
    });
    this.tex?.dispose();
    this.renderer?.dispose();
    this.root?.remove();
    const board = document.getElementById("board");
    if (board) board.style.visibility = this._boardVis ?? "";
  }

  setData(raw) {
    this.data = normalize(raw);
    if (!this.renderer || this.destroyed) return;   // still loading: mount() will use this.data
    if (JSON.stringify(this.data.galaxy) !== this._dustKey) this.buildDust();
    if (this.backdropKey() !== this._backdropKey) this.loadBackdrop();
    this.cells = rleDecode(this.data.territory.cells, this.res * this.res);
    this.factionIdx = clamp(this.factionIdx, 0, Math.max(0, this.data.factions.length - 1));
    this.refreshTerritory();
    this.rebuild();
  }

  /* ---------- saving ---------- */

  save() {
    if (!this.isGM) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.writeSave(); }, 350);
  }
  writeSave() {
    if (!this.isGM) return;
    this.data.territory = { res: this.res, cells: rleEncode(this.cells) };
    return this.scene.update({ [`flags.${MODULE_ID}.${FLAG}`]: foundry.utils.deepClone(this.data) });
  }

  /* ---------- scene building ---------- */

  makePointsMaterial({ scale = 1000, min = 2, max = 64, ring = false, opacity = 1 } = {}) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: scale }, uMin: { value: min }, uMax: { value: max },
        uPR: { value: this.renderer.getPixelRatio() }, uRing: { value: ring ? 1 : 0 }, uOpacity: { value: opacity }
      },
      vertexShader: POINT_VS, fragmentShader: POINT_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
  }

  makePoints(entries, matOpts) {
    const T = THREE, n = entries.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), alpha = new Float32Array(n);
    entries.forEach((e, i) => {
      pos.set([e.x, e.y, e.z], i * 3);
      col.set(e.color, i * 3);
      size[i] = e.size; alpha[i] = e.alpha ?? 1;
    });
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    geo.setAttribute("aColor", new T.BufferAttribute(col, 3));
    geo.setAttribute("aSize", new T.BufferAttribute(size, 1));
    geo.setAttribute("aAlpha", new T.BufferAttribute(alpha, 1));
    const pts = new T.Points(geo, this.makePointsMaterial(matOpts));
    pts.frustumCulled = false;
    return pts;
  }

  /** Decorative galaxy: dust/core glow (shape follows data.galaxy), far starfield, grid, markers. */
  buildStatic() {
    const T = THREE, E = EXTENT, rnd = mulberry32(hashStr(this.scene.id) ^ 0x9e3779b9);
    const white = [0.95, 0.95, 1];
    this.buildDust();
    this.loadBackdrop();

    const far = [];
    for (let i = 0; i < 2500; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = 12000 + rnd() * 6000, s = Math.sqrt(1 - u * u);
      far.push({ x: Math.cos(a) * s * r, y: u * r, z: Math.sin(a) * s * r, color: white, size: 1, alpha: 0.3 + rnd() * 0.6 });
    }
    this.scene3.add(this.makePoints(far, { scale: 1, min: 1, max: 2 }));

    // Galactic plane grid
    this.grid = new T.GridHelper(2 * E, 40, 0x2a4a6a, 0x16283a);
    this.grid.material.transparent = true; this.grid.material.depthWrite = false;
    this.grid.position.y = -2;
    this.scene3.add(this.grid);

    // Brush cursor
    const ringGeo = new T.RingGeometry(0.92, 1, 64); ringGeo.rotateX(-Math.PI / 2);
    this.brushCursor = new T.Mesh(ringGeo, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false, side: T.DoubleSide }));
    this.brushCursor.visible = false; this.brushCursor.renderOrder = 10;
    this.scene3.add(this.brushCursor);

    // Selection ring
    this.selRing = this.makePoints([{ x: 0, y: 0, z: 0, color: [1, 1, 1], size: 1 }], { scale: 1, min: 34, max: 34, ring: true });
    this.selRing.visible = false;
    this.scene3.add(this.selRing);

    // Party marker
    const coneGeo = new T.ConeGeometry(1, 2.2, 4); coneGeo.rotateX(Math.PI);
    this.partyMarker = new T.Mesh(coneGeo, new T.MeshBasicMaterial({ color: 0xffa630 }));
    this.partyMarker.visible = false;
    this.scene3.add(this.partyMarker);

    // Scatter selection box
    const boxLine = new T.BufferGeometry(); boxLine.setAttribute("position", new T.Float32BufferAttribute(new Array(15).fill(0), 3));
    const fillGeo = new T.PlaneGeometry(1, 1); fillGeo.rotateX(-Math.PI / 2);
    this.scatterBox = new T.Group();
    this.scatterBox.add(new T.Line(boxLine, new T.LineBasicMaterial({ color: 0xffa630, transparent: true, opacity: 0.95, depthTest: false })));
    this.scatterBox.add(new T.Mesh(fillGeo, new T.MeshBasicMaterial({ color: 0xffa630, transparent: true, opacity: 0.12, depthWrite: false, depthTest: false, side: T.DoubleSide })));
    this.scatterBox.children.forEach(c => { c.frustumCulled = false; c.renderOrder = 11; });
    this.scatterBox.visible = false;
    this.scene3.add(this.scatterBox);

    // Placement level plane + ghost preview
    this.levelGrid = new T.GridHelper(2 * E, 40, 0x3ff0de, 0x1d6f68);
    this.levelGrid.material.transparent = true; this.levelGrid.material.opacity = 0.22; this.levelGrid.material.depthWrite = false;
    this.levelGrid.visible = false;
    this.scene3.add(this.levelGrid);
    this.ghost = this.makePoints([{ x: 0, y: 0, z: 0, color: [1, 1, 1], size: 1 }], { scale: 1, min: 22, max: 22, opacity: 0.8 });
    this.ghost.visible = false;
    this.scene3.add(this.ghost);
    const gsGeo = new T.BufferGeometry(); gsGeo.setAttribute("position", new T.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    this.ghostStalk = new T.Line(gsGeo, new T.LineBasicMaterial({ color: 0x3ff0de, transparent: true, opacity: 0.7, depthWrite: false }));
    this.ghostStalk.frustumCulled = false; this.ghostStalk.visible = false;
    this.scene3.add(this.ghostStalk);
  }

  /** Background dust + core glow. Rebuilt when the galaxy shape changes. */
  buildDust() {
    const T = THREE, E = EXTENT, gp = this.data.galaxy;
    for (const o of this.dustObjs ?? []) { this.scene3.remove(o); o.geometry?.dispose(); o.material.map?.dispose(); o.material.dispose(); }
    this._dustKey = JSON.stringify(gp);
    const rnd = mulberry32(hashStr(gp.seed ?? this.scene.id));
    const core = [1, 0.84, 0.6], arm = [0.6, 0.76, 1], white = [0.95, 0.95, 1];
    const dust = [];
    for (let i = 0; i < 16000; i++) {
      const p = galaxyPoint(rnd, gp);
      const t = smooth(0, 0.6, p.r / E);
      const c = p.core ? core : rnd() < 0.15 ? white : [lerp(core[0], arm[0], t), lerp(core[1], arm[1], t), lerp(core[2], arm[2], t)];
      dust.push({ x: p.x, y: p.y, z: p.z, color: c, size: 1 + rnd() * 1.4, alpha: 0.25 + rnd() * 0.5 });
    }
    this.dust = this.makePoints(dust, { scale: 700, min: 1, max: 6, opacity: 0.7 });

    const cv = document.createElement("canvas"); cv.width = cv.height = 256;
    const ctx = cv.getContext("2d"), grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, "rgba(255,225,180,0.85)"); grad.addColorStop(0.25, "rgba(255,190,120,0.35)");
    grad.addColorStop(0.6, "rgba(140,120,200,0.08)"); grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 256, 256);
    const glow = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(cv), blending: T.AdditiveBlending, depthWrite: false, transparent: true }));
    const gs = { spiral: 0.9, elliptical: 1.3, irregular: 0.45, ring: 0.5 }[gp.shape] ?? 0.9;
    glow.scale.set(E * gs, E * gs, 1);
    this.dustObjs = [this.dust, glow];
    for (const o of this.dustObjs) this.scene3.add(o);
  }

  /** Image shown under the galaxy in the whole-galaxy view: map override, else scene background, else scene thumbnail. */
  backdropSrc() {
    return this.data.backdrop.src || this.scene.background?.src || this.scene.thumb || "";
  }
  backdropKey() { return JSON.stringify([this.backdropSrc(), this.data.backdrop]); }

  loadBackdrop() {
    const T = THREE, b = this.data.backdrop, src = this.backdropSrc();
    this._backdropKey = this.backdropKey();
    if (this.backdrop) { this.scene3.remove(this.backdrop); this.backdrop.geometry.dispose(); this.backdrop.material.map?.dispose(); this.backdrop.material.dispose(); this.backdrop = null; }
    if (!src) return;
    const url = /^(https?:|data:|blob:|\/)/.test(src) ? src : routeFor(src);
    const token = (this._backdropToken = (this._backdropToken ?? 0) + 1);
    new T.TextureLoader().load(url, tex => {
      if (this.destroyed || token !== this._backdropToken) return tex.dispose();
      tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 8;
      const iw = tex.image?.width || 1, ih = tex.image?.height || 1;
      const w = 2 * EXTENT * (Number(b.scale) || 1), h = w * ih / iw;   // fit image width to the map, then scale
      const geo = new T.PlaneGeometry(w, h); geo.rotateX(-Math.PI / 2);
      const mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide }));
      mesh.position.set(Number(b.x) || 0, -4, Number(b.z) || 0);
      mesh.renderOrder = -2; mesh.frustumCulled = false; mesh.visible = false;
      this.backdrop = mesh;
      this.scene3.add(mesh);
      this.renderToolbar();
    }, undefined, err => {
      console.warn(`${MODULE_ID} | Could not load background image ${url}`, err);
      if (this.isGM) ui.notifications.warn(`Galaxy Map: couldn't load the background image (${src}).`);
    });
  }

  toggleBackdrop(on = !this.showBackdrop) {
    this.showBackdrop = on;
    try { localStorage.setItem(`${MODULE_ID}.backdrop`, on ? "1" : "0"); } catch { /* storage unavailable */ }
    this.renderToolbar();
  }

  async backdropDialog() {
    const b = this.data.backdrop;
    const f = await formDialog("Background Image", `
      <p class="notes">Shown under the galaxy in the whole-galaxy view. Leave the image blank to use this scene's background image (or its thumbnail).</p>
      <div class="form-group"><label>Image path</label><input type="text" name="src" value="${esc(b.src)}" placeholder="${esc(this.scene.background?.src || this.scene.thumb || "scene background")}"></div>
      <div class="form-group"><label>Size (%)</label><input type="number" name="scale" value="${Math.round((Number(b.scale) || 1) * 1000) / 10}" step="0.1" min="5" max="500"></div>
      <div class="form-group"><label>Shift east / west</label><input type="number" name="x" value="${Math.round(Number(b.x) || 0)}" step="1"></div>
      <div class="form-group"><label>Shift south / north</label><input type="number" name="z" value="${Math.round(Number(b.z) || 0)}" step="1"></div>
      <div class="form-group"><label>Opacity (%)</label><input type="number" name="opacity" value="${Math.round((Number.isFinite(Number(b.opacity)) ? Number(b.opacity) : 0.85) * 100)}" min="0" max="100"></div>
      <p class="notes">Map units: the galaxy spans -1000 to 1000. Positive east moves the image right, positive south moves it down.</p>`);
    if (!f) return;
    this.data.backdrop = {
      src: (f.src ?? "").trim(),
      scale: clamp((Number(f.scale) || 100) / 100, 0.05, 5),
      x: Number(f.x) || 0, z: Number(f.z) || 0,
      opacity: clamp((f.opacity === "" || !Number.isFinite(Number(f.opacity)) ? 85 : Number(f.opacity)) / 100, 0, 1)
    };
    this.save(); this.loadBackdrop();
  }

  buildTerritory() {
    const T = THREE;
    this.res = this.data.territory.res || RES;
    const res = this.res;
    this.cells = rleDecode(this.data.territory.cells, res * res);
    this.texData = new Uint8Array(res * res * 4);
    this.tex = new T.DataTexture(this.texData, res, res, T.RGBAFormat);
    this.tex.magFilter = T.LinearFilter; this.tex.minFilter = T.LinearFilter;
    this.terrMat = new T.ShaderMaterial({
      uniforms: { map: { value: this.tex }, uFill: { value: 0.2 }, uBorder: { value: 0.6 }, uTexel: { value: 1 / res } },
      vertexShader: TERR_VS, fragmentShader: TERR_FS,
      transparent: true, depthWrite: false, premultipliedAlpha: true, side: THREE.DoubleSide
    });
    const geo = new T.PlaneGeometry(2 * EXTENT, 2 * EXTENT); geo.rotateX(-Math.PI / 2);
    const mesh = new T.Mesh(geo, this.terrMat);
    mesh.position.y = -1; mesh.renderOrder = -1;
    this.scene3.add(mesh);
    this.refreshTerritory();
  }

  refreshTerritory() {
    const cols = this.data.factions.map(f => hexToRgb(f.color)), d = this.texData;
    for (let i = 0; i < this.cells.length; i++) {
      const v = this.cells[i], c = v ? cols[v - 1] : null, j = i * 4;
      if (c) { d[j] = c[0] * 255; d[j + 1] = c[1] * 255; d[j + 2] = c[2] * 255; d[j + 3] = 255; }
      else { d[j] = d[j + 1] = d[j + 2] = d[j + 3] = 0; }
    }
    this.tex.needsUpdate = true;
    this.scheduleFactionLabels();
  }

  scheduleFactionLabels() {
    clearTimeout(this._labelTimer);
    this._labelTimer = setTimeout(() => { if (!this.destroyed) this.buildFactionLabels(); }, this.facLabels ? 300 : 0);
  }

  /** Lay a faction's name into a canvas: one line, or two if that fits the territory better. */
  layoutFactionName(name, lines) {
    const px = 96, font = `600 ${px}px Signika, "Palatino Linotype", sans-serif`;
    const cv = document.createElement("canvas"), ctx = cv.getContext("2d");
    ctx.font = font;
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${px * 0.08}px`;
    const widths = lines.map(l => ctx.measureText(l).width);
    const lineH = px * 1.05;
    cv.width = Math.ceil(Math.max(...widths) + px * 0.5);
    cv.height = Math.ceil(lineH * lines.length + px * 0.25);
    return { cv, font, px, lineH, lines, aspect: cv.width / cv.height };
  }

  /** Place every faction's name inside its own territory, as large as it can be without crossing a border. */
  buildFactionLabels() {
    const T = THREE, res = this.res, cell = (2 * EXTENT) / res;
    for (const m of this.facLabels ?? []) { this.scene3.remove(m); m.geometry.dispose(); m.material.map?.dispose(); m.material.dispose(); }
    this.facLabels = [];
    this.data.factions.forEach((f, i) => {
      const name = String(f.name ?? "").toUpperCase().trim();
      if (!name) return;
      const words = name.split(/\s+/);
      const options = nameLayouts(words);
      let chosen = null;
      for (const lines of options) {
        const lay = this.layoutFactionName(name, lines);
        const box = fitLabelBox(this.cells, res, i + 1, lay.aspect);
        if (!box) continue;
        const lineSize = box.h / lines.length;      // compare by the size each line of text ends up
        if (!chosen || lineSize > chosen.lineSize) chosen = { lay, box, lineSize };
      }
      if (!chosen) return;
      const { lay, box } = chosen, ctx = lay.cv.getContext("2d");
      ctx.font = lay.font;
      if ("letterSpacing" in ctx) ctx.letterSpacing = `${lay.px * 0.08}px`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const [r, g, b] = hexToRgb(f.color).map(c => Math.round((c * 0.45 + 0.55) * 255));
      lay.lines.forEach((line, li) => {
        const y = lay.px * 0.125 + lay.lineH * (li + 0.5);
        ctx.shadowColor = f.color; ctx.shadowBlur = lay.px * 0.25;
        ctx.lineWidth = lay.px * 0.07; ctx.strokeStyle = "rgba(0,0,0,0.65)";
        ctx.strokeText(line, lay.cv.width / 2, y);
        ctx.shadowBlur = 0; ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillText(line, lay.cv.width / 2, y);
      });
      const tex = new T.CanvasTexture(lay.cv);
      tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4;
      const geo = new T.PlaneGeometry(box.w * cell, box.h * cell); geo.rotateX(-Math.PI / 2);
      const mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, side: T.DoubleSide, opacity: 0 }));
      mesh.position.set(box.cx * cell - EXTENT, 0.6, EXTENT - box.cy * cell);
      mesh.renderOrder = 5; mesh.frustumCulled = false;
      this.scene3.add(mesh);
      this.facLabels.push(mesh);
    });
  }

  /** Rebuild everything that depends on systems / gates. */
  rebuild() {
    const T = THREE, gm = this.isGM, d = this.data;
    for (const o of this.dyn ?? []) { this.scene3.remove(o); o.geometry.dispose(); o.material.dispose(); }
    this.dyn = [];

    const sys = d.systems.filter(s => gm || !s.hidden);
    const gates = d.gates.filter(g => gm || !g.hidden);
    this.items = [...sys.map(obj => ({ kind: "system", obj })), ...gates.map(obj => ({ kind: "gate", obj }))];

    const sysPts = this.makePoints(sys.map(s => ({ x: s.x, y: s.y, z: s.z, color: hexToRgb(s.color), size: 8 * (Number(s.size) || 1), alpha: s.hidden ? 0.35 : 1 })),
      { scale: 1000, min: 5, max: 48 });
    const gatePts = this.makePoints(gates.map(g => ({ x: g.x, y: g.y, z: g.z, color: hexToRgb(GATE_COLOR), size: 14, alpha: g.hidden ? 0.35 : 1 })),
      { scale: 1000, min: 14, max: 56, ring: true });

    const stalkV = [];
    for (const o of [...sys, ...gates]) if (Math.abs(o.y) > 0.5) stalkV.push(o.x, o.y, o.z, o.x, 0, o.z);
    const stalkGeo = new T.BufferGeometry(); stalkGeo.setAttribute("position", new T.Float32BufferAttribute(stalkV, 3));
    this.stalks = new T.LineSegments(stalkGeo, new T.LineBasicMaterial({ color: 0x5c7fa6, transparent: true, opacity: 0.35, depthWrite: false }));

    const byId = new Map(gates.map(g => [g.id, g])), seen = new Set(), linkV = [];
    for (const g of gates) for (const l of g.links) {
      const o = byId.get(l); if (!o) continue;
      const key = [g.id, l].sort().join("|"); if (seen.has(key)) continue; seen.add(key);
      linkV.push(g.x, g.y, g.z, o.x, o.y, o.z);
    }
    const linkGeo = new T.BufferGeometry(); linkGeo.setAttribute("position", new T.Float32BufferAttribute(linkV, 3));
    this.links = new T.LineSegments(linkGeo, new T.LineBasicMaterial({ color: new T.Color(GATE_COLOR), transparent: true, opacity: 0.6, blending: T.AdditiveBlending, depthWrite: false }));

    for (const o of [this.stalks, this.links, sysPts, gatePts]) { o.frustumCulled = false; this.scene3.add(o); this.dyn.push(o); }

    this.labelsEl.innerHTML = "";
    for (const it of this.items) {
      const el = document.createElement("div");
      el.className = `gm-label ${it.kind}${it.obj.hidden ? " is-hidden" : ""}${it.obj.sceneId && game.scenes.get(it.obj.sceneId) ? " has-scene" : ""}`;
      el.textContent = it.obj.name;
      this.labelsEl.append(el);
      it.el = el;
      el.style.display = "none";
    }
    if (this.hovered) this.hovered = this.items.find(i => i.obj.id === this.hovered.obj.id) ?? null;
    this.renderToolbar();
    this.renderPanel();
  }

  /* ---------- per-frame ---------- */

  applyCamera() {
    const c = this.cam;
    this.td = smooth(650, 1700, c.dist);   // 0 = full 3D, 1 = top-down chart
    const pitch = THREE.MathUtils.degToRad(lerp(c.pitch, c.pitch < 0 ? -89.4 : 89.4, this.td)), cp = Math.cos(pitch);
    this.camera.position.set(c.tx + Math.sin(c.yaw) * cp * c.dist, c.ty + Math.sin(pitch) * c.dist, c.tz + Math.cos(c.yaw) * cp * c.dist);
    this.camera.lookAt(c.tx, c.ty, c.tz);
    this.camera.updateMatrixWorld();
  }

  frame() {
    const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000), t = now / 1000;
    this.last = now;
    const k = 1 - Math.exp(-dt * 7);
    if (this.viewLocked) Object.assign(this.goal, LOCKED_VIEW);
    else this.applyKeyMovement(dt);
    for (const key of ["tx", "ty", "tz", "dist", "yaw", "pitch"]) this.cam[key] += (this.goal[key] - this.cam[key]) * k;
    this.applyCamera();
    const td = this.td;

    let fov = 55;
    if (this.warpStart >= 0) {
      const p = (now - this.warpStart) / 1400;
      if (p >= 1) this.warpStart = -1; else fov = 55 + 40 * Math.sin(Math.PI * p);
    }
    if (this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }

    this.terrMat.uniforms.uFill.value = lerp(0.1, 0.3, td);
    this.terrMat.uniforms.uBorder.value = lerp(0.3, 0.9, td);
    this.grid.material.opacity = lerp(0.06, 0.3, td);
    this.stalks.material.opacity = 0.4 * (1 - td);
    this.links.material.opacity = 0.45 + 0.25 * Math.sin(t * 2.5);
    this.dust.material.uniforms.uOpacity.value = lerp(0.75, 0.5, td);
    const labelA = smooth(0.35, 0.9, td) * 0.9;
    if (this.backdrop) {
      const op = Number(this.data.backdrop.opacity), a = this.showBackdrop ? smooth(0.5, 0.95, td) * (Number.isFinite(op) ? op : 0.85) : 0;
      this.backdrop.material.opacity = a; this.backdrop.visible = a > 0.01;
      this.dust.material.uniforms.uOpacity.value *= 1 - 0.8 * a;     // let the image's own stars show through
    }
    for (const m of this.facLabels ?? []) { m.material.opacity = labelA; m.visible = labelA > 0.01; }

    const party = this.items.find(i => i.obj.id === this.data.partyAt);
    this.partyMarker.visible = !!party;
    if (party) {
      const s = this.cam.dist * 0.011, o = party.obj;
      this.partyMarker.scale.setScalar(s);
      this.partyMarker.position.set(o.x, o.y + s * 2.6 + Math.sin(t * 3) * s * 0.3, o.z);
      this.partyMarker.rotation.y = t;
    }

    const sel = this.selectedItem() ?? (this.linkFrom ? this.items.find(i => i.obj.id === this.linkFrom) : null);
    this.selRing.visible = !!sel;
    if (sel) this.selRing.position.set(sel.obj.x, sel.obj.y, sel.obj.z);

    if (this._needsRebuild) { this._needsRebuild = false; this.rebuild(); }
    this.updateLabels();
    this.renderer.render(this.scene3, this.camera);
  }

  /**
   * Labels only appear near the cursor (fading out towards the edge of the label radius),
   * plus the hovered / selected point and the party's location. Hold Alt to show every label.
   * Overlapping labels are dropped, nearest-to-cursor first, so names never pile up.
   */
  updateLabels() {
    const w = window.innerWidth, h = window.innerHeight, v = this.tmpV;
    const sel = this.selectedItem(), mouse = this._lastMouse, R = this.labelRadius;
    const shown = [];
    for (const it of this.items) {
      const o = it.obj;
      v.set(o.x, o.y, o.z).project(this.camera);
      it._vis = false;
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x + 1) / 2 * w, sy = (1 - v.y) / 2 * h;
      if (sx < -200 || sx > w + 50 || sy < -50 || sy > h + 50) continue;
      const focus = it === this.hovered || it === sel || o.id === this.data.partyAt;
      const dist = mouse ? Math.hypot(sx - mouse[0], sy - mouse[1]) : Infinity;
      let alpha, prio;
      if (focus) { alpha = 1; prio = -1; }
      else if (this.showAll) { alpha = 0.85; prio = dist; }
      else if (dist < R) { alpha = 1 - smooth(R * 0.55, R, dist); prio = dist; }
      else continue;
      shown.push({ it, sx, sy, alpha, prio, focus });
    }
    shown.sort((a, b) => a.prio - b.prio);
    const boxes = [];
    for (const s of shown) {
      const it = s.it;
      if (it._w === undefined) { it.el.style.display = ""; it._w = it.el.offsetWidth || it.obj.name.length * 7; }
      const box = [s.sx + 10, s.sy - 10, s.sx + 14 + it._w, s.sy + 8];
      if (!s.focus && boxes.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      boxes.push(box);
      it._vis = true;
      it.el.style.display = "";
      it.el.style.opacity = s.alpha;
      it.el.style.transform = `translate(${s.sx + 12}px, ${s.sy - 9}px)`;
      it.el.classList.toggle("focus", s.focus);
    }
    for (const it of this.items) if (!it._vis && it.el.style.display !== "none") it.el.style.display = "none";
  }

  /* ---------- picking ---------- */

  groundAt(x, y, height = 0) {
    this.ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    this.groundPlane.constant = -height;
    const p = new THREE.Vector3();
    const hit = this.ray.ray.intersectPlane(this.groundPlane, p);
    if (!hit || p.distanceTo(this.camera.position) > this.cam.dist * 6) return null;  // ignore near-horizon hits
    return p;
  }

  get levelY() { return this.level * LEVEL_STEP; }

  /** While placing systems / fast-travel points the GM's view is locked to the whole-galaxy chart. */
  get viewLocked() { return this.isGM && ["system", "gate"].includes(this.mode); }

  setLevel(l) {
    this.level = clamp(Math.round(l), -MAX_LEVEL, MAX_LEVEL);
    const el = this.toolbarEl.querySelector(".gm-level-value");
    if (el) el.textContent = fmtLevel(this.levelY);
    if (this._lastMouse) this.updateGhost(...this._lastMouse);
  }

  updateGhost(x, y) {
    const on = this.isGM && ["system", "gate"].includes(this.mode);
    this.levelGrid.visible = on;
    this.levelGrid.position.y = this.levelY;
    const p = on && !this.down ? this.groundAt(x, y, this.levelY) : null;
    this.ghost.visible = this.ghostStalk.visible = !!p;
    if (!p) return;
    this.ghost.position.copy(p);
    this.ghost.material.uniforms.uRing.value = this.mode === "gate" ? 1 : 0;
    const a = this.ghostStalk.geometry.attributes.position;
    a.setXYZ(0, p.x, p.y, p.z); a.setXYZ(1, p.x, 0, p.z); a.needsUpdate = true;
  }

  isTyping() {
    const ae = document.activeElement;
    return !!ae && (["INPUT", "TEXTAREA", "SELECT"].includes(ae.tagName) || ae.isContentEditable);
  }

  onKey(e) {
    if (e.key === "Alt") { this.showAll = true; e.preventDefault(); return; }
    if (this.isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (MOVE_KEYS[e.code]) {                       // WASD: fly the camera (held keys are applied each frame)
      e.preventDefault(); e.stopImmediatePropagation();
      this.keys.add(e.code);
      this.fastMove = e.shiftKey;
      return;
    }
    if (!this.isGM || !["system", "gate"].includes(this.mode)) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault(); e.stopImmediatePropagation();
    this.setLevel(this.level + (e.key === "ArrowUp" ? 1 : -1));
  }

  onKeyUp(e) {
    if (e.key === "Alt") { this.showAll = false; e.preventDefault(); return; }
    if (!MOVE_KEYS[e.code]) return;
    this.keys.delete(e.code);
    this.fastMove = e.shiftKey;
    e.stopImmediatePropagation();
  }

  /** Move the view relative to where the camera faces. W forward, A left, S back, D right. Shift = faster. */
  applyKeyMovement(dt) {
    if (!this.keys.size) return;
    let f = 0, r = 0;
    for (const k of this.keys) { f += MOVE_KEYS[k][0]; r += MOVE_KEYS[k][1]; }
    if (!f && !r) return;
    const len = Math.hypot(f, r), speed = this.cam.dist * (this.fastMove ? 2.4 : 0.9) * dt / len;
    const sy = Math.sin(this.cam.yaw), cy = Math.cos(this.cam.yaw), lim = EXTENT * 1.2;
    const mx = (-sy * f + cy * r) * speed, mz = (-cy * f - sy * r) * speed;
    this.goal.tx = this.cam.tx = clamp(this.cam.tx + mx, -lim, lim);
    this.goal.tz = this.cam.tz = clamp(this.cam.tz + mz, -lim, lim);
  }

  pick(x, y, radius = 16) {
    const w = window.innerWidth, h = window.innerHeight, v = this.tmpV;
    let best = null, bd = radius;
    for (const it of this.items) {
      v.set(it.obj.x, it.obj.y, it.obj.z).project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      const d = Math.hypot((v.x + 1) / 2 * w - x, (1 - v.y) / 2 * h - y);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  selectedItem() {
    if (!this.selected) return null;
    return this.items?.find(i => i.kind === this.selected.kind && i.obj.id === this.selected.id) ?? null;
  }

  cellOf(x, z) { return [(x + EXTENT) / (2 * EXTENT) * this.res, (EXTENT - z) / (2 * EXTENT) * this.res]; }

  factionAt(x, z) {
    const [cx, cy] = this.cellOf(x, z).map(Math.floor);
    if (cx < 0 || cy < 0 || cx >= this.res || cy >= this.res) return null;
    const v = this.cells[cy * this.res + cx];
    return v ? this.data.factions[v - 1] ?? null : null;
  }

  /* ---------- painting ---------- */

  paintDisc(p, value) {
    const [cx, cy] = this.cellOf(p.x, p.z), r = this.brush, res = this.res;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      if (y < 0 || y >= res) continue;
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || x >= res) continue;
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) this.cells[y * res + x] = value;
      }
    }
  }

  paintStroke(p) {
    if (this.mode === "paint" && !this.data.factions.length) {
      ui.notifications.warn("Create a faction first (the + button in the toolbar).");
      this.painting = false; return;
    }
    const value = this.mode === "erase" ? 0 : this.factionIdx + 1;
    const cell = (2 * EXTENT) / this.res;
    if (this.lastPaint) {
      const dist = Math.hypot(p.x - this.lastPaint.x, p.z - this.lastPaint.z);
      const steps = Math.ceil(dist / (cell * Math.max(1, this.brush * 0.5)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this.paintDisc({ x: lerp(this.lastPaint.x, p.x, t), z: lerp(this.lastPaint.z, p.z, t) }, value);
      }
    } else this.paintDisc(p, value);
    this.lastPaint = { x: p.x, z: p.z };
    this.refreshTerritory();
  }

  updateBrushCursor(x, y) {
    const on = this.isGM && (this.mode === "paint" || this.mode === "erase");
    this.brushCursor.visible = on;
    if (!on) return;
    const p = this.groundAt(x, y);
    if (!p) { this.brushCursor.visible = false; return; }
    this.brushCursor.position.set(p.x, 0, p.z);
    this.brushCursor.scale.setScalar(this.brush * (2 * EXTENT) / this.res);
    const col = this.mode === "erase" ? "#ffffff" : this.data.factions[this.factionIdx]?.color ?? "#ffffff";
    this.brushCursor.material.color.set(col);
  }

  /* ---------- input ---------- */

  listen(el, ev, fn, opt) { el.addEventListener(ev, fn, opt); this._listeners.push([el, ev, fn, opt]); }

  bindEvents() {
    const cv = this.canvas;
    this.listen(cv, "contextmenu", e => e.preventDefault());
    this.listen(cv, "pointerdown", e => this.onDown(e));
    this.listen(cv, "pointermove", e => this.onMove(e));
    this.listen(cv, "pointerup", e => this.onUp(e));
    this.listen(cv, "pointerleave", () => { this._lastMouse = null; this.hovered = null; this.brushCursor.visible = false; if (this.ghost) this.ghost.visible = this.ghostStalk.visible = false; });
    this.listen(window, "keydown", e => this.onKey(e), true);
    this.listen(window, "keyup", e => this.onKeyUp(e), true);
    this.listen(window, "blur", () => { this.keys.clear(); this.showAll = false; });
    this.listen(cv, "wheel", e => this.onWheel(e), { passive: false });
    this.listen(cv, "dblclick", e => {
      const it = this.pick(e.clientX, e.clientY);
      if (!it) return;
      // Double-click a point with a linked scene: GM takes the party there, players view it. Alt+double-click just flies.
      if (it.obj.sceneId && game.scenes.get(it.obj.sceneId) && !e.altKey) this.enterScene(it.obj, this.isGM);
      else this.flyTo(it.obj);
    });
    this.listen(cv, "dragover", e => e.preventDefault());
    this.listen(cv, "drop", e => this.onDrop(e));
    this.listen(window, "resize", () => this.onResize());
    this.listen(this.toolbarEl, "click", e => this.onToolbar(e));
    this.listen(this.toolbarEl, "change", e => this.onToolbarInput(e));
    this.listen(this.toolbarEl, "input", e => this.onToolbarInput(e));
    this.listen(this.panelEl, "click", e => this.onPanel(e));
  }

  onResize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  onDown(e) {
    this.down = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, btn: e.button, moved: false };
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button !== 0 || !this.isGM) return;
    if (this.mode === "paint" || this.mode === "erase") {
      this.painting = true; this.lastPaint = null;
      const p = this.groundAt(e.clientX, e.clientY); if (p) this.paintStroke(p);
    } else if (this.mode === "navigate" && e.shiftKey) {
      const it = this.pick(e.clientX, e.clientY); if (it) this.dragItem = it;
    } else if (this.mode === "scatter") {
      const p = this.groundAt(e.clientX, e.clientY);
      if (p) { this.scatterStart = p; this.setScatterBox(p, p); }
    }
  }

  /** Show the scatter selection rectangle between two ground points (world-axis aligned). */
  setScatterBox(a, b) {
    const lim = v => clamp(v, -EXTENT, EXTENT);
    const x0 = lim(Math.min(a.x, b.x)), x1 = lim(Math.max(a.x, b.x)), z0 = lim(Math.min(a.z, b.z)), z1 = lim(Math.max(a.z, b.z));
    this.scatterRect = { x0, x1, z0, z1 };
    const [line, fill] = this.scatterBox.children, pa = line.geometry.attributes.position;
    [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]].forEach(([x, z], i) => pa.setXYZ(i, x, 0.5, z));
    pa.needsUpdate = true;
    fill.position.set((x0 + x1) / 2, 0.4, (z0 + z1) / 2);
    fill.scale.set(Math.max(0.01, x1 - x0), 1, Math.max(0.01, z1 - z0));
    this.scatterBox.visible = true;
  }

  onMove(e) {
    this._lastMouse = [e.clientX, e.clientY];
    this.updateBrushCursor(e.clientX, e.clientY);
    this.updateGhost(e.clientX, e.clientY);
    const d = this.down;
    if (!d) {
      this.hovered = this.pick(e.clientX, e.clientY);
      const addMode = ["system", "gate"].includes(this.mode) && this.isGM;
      const paintMode = ["paint", "erase", "scatter"].includes(this.mode) && this.isGM;
      this.canvas.style.cursor = paintMode ? "crosshair" : this.hovered ? "pointer" : addMode ? "copy" : "grab";
      return;
    }
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
    const dx = e.clientX - d.lastX, dy = e.clientY - d.lastY;

    if (this.viewLocked && !this.painting && !this.dragItem) { /* view locked while placing */ }
    else if (d.btn === 2) {
      this.goal.yaw -= dx * 0.006;
      this.goal.pitch = clamp(this.goal.pitch + dy * 0.25, -85, 85);
    } else if (this.painting) {
      const p = this.groundAt(e.clientX, e.clientY); if (p) this.paintStroke(p);
    } else if (this.scatterStart) {
      const p = this.groundAt(e.clientX, e.clientY); if (p) this.setScatterBox(this.scatterStart, p);
    } else if (this.dragItem) {
      const p = this.groundAt(e.clientX, e.clientY, this.dragItem.obj.y);
      if (p) { this.dragItem.obj.x = p.x; this.dragItem.obj.z = p.z; this._needsRebuild = true; }
    } else if ((d.btn === 0 || d.btn === 1) && d.moved) {
      const wpp = 2 * this.cam.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / window.innerHeight;
      const sy = Math.sin(this.cam.yaw), cy = Math.cos(this.cam.yaw), lim = EXTENT * 1.2;
      const below = this.camera.position.y < this.cam.ty ? -1 : 1;   // screen "up" flips when looking up from below
      const mx = (-cy * dx - sy * dy * below) * wpp, mz = (sy * dx - cy * dy * below) * wpp;
      this.goal.tx = this.cam.tx = clamp(this.cam.tx + mx, -lim, lim);
      this.goal.tz = this.cam.tz = clamp(this.cam.tz + mz, -lim, lim);
      this.applyCamera();
      this.canvas.style.cursor = "grabbing";
    }
    d.lastX = e.clientX; d.lastY = e.clientY;
  }

  onUp(e) {
    const d = this.down; this.down = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (this.painting) { this.painting = false; this.save(); return; }
    if (this.dragItem) { this.dragItem = null; this.save(); return; }
    if (this.scatterStart) {
      this.scatterStart = null;
      const r = this.scatterRect;
      if (r && r.x1 - r.x0 > 8 && r.z1 - r.z0 > 8) this.scatterDialog(r);
      else this.scatterBox.visible = false;
      return;
    }
    if (d && !d.moved && d.btn === 0) this.onClick(e);
  }

  onWheel(e) {
    e.preventDefault();
    if (this.viewLocked) return;
    const old = this.goal.dist;
    const next = clamp(old * Math.exp(e.deltaY * 0.0012), 40, 2800);
    const p = this.groundAt(e.clientX, e.clientY);
    if (p) {                                        // zoom toward the cursor
      const f = 1 - next / old;
      this.goal.tx += (p.x - this.goal.tx) * f;
      this.goal.tz += (p.z - this.goal.tz) * f;
    }
    this.goal.dist = next;
  }

  async onClick(e) {
    const it = this.pick(e.clientX, e.clientY);
    const gm = this.isGM;
    switch (gm ? this.mode : "navigate") {
      case "navigate": this.select(it); break;
      case "system":
      case "gate": {
        if (it) { this.select(it); break; }
        const p = this.groundAt(e.clientX, e.clientY, this.levelY);
        if (p && Math.abs(p.x) <= EXTENT && Math.abs(p.z) <= EXTENT) await this.createItem(this.mode, p);
        break;
      }
      case "link": {
        if (!it || it.kind !== "gate") { ui.notifications.info("Click a fast-travel point."); break; }
        if (!this.linkFrom) this.linkFrom = it.obj.id;
        else if (this.linkFrom === it.obj.id) this.linkFrom = null;
        else { this.toggleLink(this.linkFrom, it.obj.id); this.linkFrom = null; }
        this.renderToolbar();
        break;
      }
    }
  }

  async onDrop(e) {
    e.preventDefault();
    if (!this.isGM) return;
    let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
    const isJournal = ["JournalEntry", "JournalEntryPage"].includes(data?.type), isScene = data?.type === "Scene";
    if ((!isJournal && !isScene) || !data.uuid) return;
    const it = this.pick(e.clientX, e.clientY, 30);
    if (!it) return ui.notifications.warn(`Drop the ${isScene ? "scene" : "journal"} onto a star system or fast-travel point.`);
    if (isScene) {
      const s = await fromUuid(data.uuid);
      if (!s || s.id === this.scene.id) return;
      it.obj.sceneId = s.id;
      ui.notifications.info(`Linked scene "${s.name}" to ${it.obj.name}.`);
    } else {
      it.obj.journal = data.uuid;
      ui.notifications.info(`Linked journal to ${it.obj.name}.`);
    }
    this.save(); this.rebuild();
  }

  /** Dive into the scene linked to a point. everyone=true (GM) activates it for all players. */
  async enterScene(o, everyone = false) {
    const target = game.scenes.get(o.sceneId);
    if (!target) return ui.notifications.warn("The linked scene no longer exists.");
    if (!this.isGM && !target.testUserPermission(game.user, "LIMITED")) return ui.notifications.warn("You can't view that scene yet.");
    if (everyone && this.isGM) {
      this.data.partyAt = o.id;
      clearTimeout(this._saveTimer); this._saveTimer = null;
      await this.writeSave();
      game.socket.emit(SOCKET, { type: "dive", sceneId: this.scene.id, to: o.id });
    }
    this.dive(o);
    setTimeout(() => (everyone && this.isGM ? target.activate() : target.view()), 950);
  }

  /** Zoom-in-and-flash effect used before switching scenes. */
  dive(o) {
    this.goal.tx = o.x; this.goal.tz = o.z; this.goal.dist = 45;
    this.warpStart = performance.now();
    this.flashEl.classList.remove("go"); void this.flashEl.offsetWidth; this.flashEl.classList.add("go");
  }

  /* ---------- camera moves ---------- */

  flyTo(o, dist = 260) {
    this.goal.tx = o.x; this.goal.tz = o.z;
    this.goal.dist = Math.min(this.goal.dist, dist);
  }

  centerOnParty(instant = false) {
    const party = this.items.find(i => i.obj.id === this.data.partyAt);
    if (party) { this.goal.tx = party.obj.x; this.goal.tz = party.obj.z; this.goal.dist = 420; }
    else Object.assign(this.goal, { tx: 0, tz: 0, dist: 2400 });
    if (instant) { Object.assign(this.cam, this.goal); this.cam.dist = 2600; }
  }

  doJump(gateId) {
    const g = this.data.gates.find(x => x.id === gateId);
    if (!g || (!this.isGM && g.hidden)) return;
    this.warpStart = performance.now();
    this.flashEl.classList.remove("go"); void this.flashEl.offsetWidth; this.flashEl.classList.add("go");
    this.goal.tx = g.x; this.goal.tz = g.z; this.goal.dist = 260;
    this.selected = { kind: "gate", id: g.id };
    this.renderPanel();
  }

  /* ---------- editing ---------- */

  itemForm(kind, o) {
    const sizes = [[1, "Normal"], [1.5, "Large"], [2, "Giant"], [3, "Supergiant"]];
    return `
      <div class="form-group"><label>Name</label><input type="text" name="name" value="${esc(o.name)}" autofocus></div>
      ${kind === "system" ? `
        <div class="form-group"><label>Star colour</label><input type="color" name="color" value="${esc(o.color)}"></div>
        <div class="form-group"><label>Star size</label><select name="size">${sizes.map(([v, l]) => `<option value="${v}" ${Number(o.size) === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>` : ""}
      <div class="form-group"><label>Height above plane</label><input type="number" name="y" value="${Math.round(o.y ?? 0)}" step="5"></div>
      <div class="form-group"><label>Linked scene</label><select name="sceneId"><option value="">None</option>${
        game.scenes.filter(s => s.id !== this.scene.id).sort((a, b) => a.name.localeCompare(b.name))
          .map(s => `<option value="${s.id}" ${o.sceneId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>
      <div class="form-group"><label>Journal UUID</label><input type="text" name="journal" value="${esc(o.journal)}" placeholder="Or drag a journal onto the point"></div>
      <div class="form-group"><label>Hidden from players</label><input type="checkbox" name="hidden" ${o.hidden ? "checked" : ""}></div>
      <div class="form-group stacked"><label>Notes (shown to players)</label><textarea name="notes" rows="3">${esc(o.notes)}</textarea></div>`;
  }

  applyForm(o, f) {
    o.name = f.name?.trim() || o.name;
    if (f.color) o.color = f.color;
    if (f.size) o.size = Number(f.size) || 1;
    o.y = Number(f.y) || 0;
    o.journal = (f.journal ?? "").trim();
    o.sceneId = f.sceneId ?? "";
    o.hidden = !!f.hidden;
    o.notes = f.notes ?? "";
  }

  async createItem(kind, p) {
    const isSys = kind === "system";
    const o = {
      id: uid(), name: isSys ? "New System" : "New Fast-Travel Point", x: p.x, z: p.z, y: p.y,
      hidden: false, journal: "", notes: "",
      ...(isSys ? { color: STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)], size: 1 } : { links: [] })
    };
    const f = await formDialog(isSys ? "New Star System" : "New Fast-Travel Point", this.itemForm(kind, o), "Create");
    if (!f) return;
    this.applyForm(o, f);
    (isSys ? this.data.systems : this.data.gates).push(o);
    this.selected = { kind, id: o.id };
    this.save(); this.rebuild();
  }

  async editItem(it) {
    const f = await formDialog(`Edit ${it.obj.name}`, this.itemForm(it.kind, it.obj));
    if (!f) return;
    this.applyForm(it.obj, f);
    this.save(); this.rebuild();
  }

  async deleteItem(it) {
    const ok = await confirmDialog("Delete", `<p>Delete <b>${esc(it.obj.name)}</b>?</p>`);
    if (!ok) return;
    const d = this.data;
    if (it.kind === "system") d.systems = d.systems.filter(s => s.id !== it.obj.id);
    else {
      d.gates = d.gates.filter(g => g.id !== it.obj.id);
      for (const g of d.gates) g.links = g.links.filter(l => l !== it.obj.id);
    }
    if (d.partyAt === it.obj.id) d.partyAt = null;
    this.selected = null;
    this.save(); this.rebuild();
  }

  toggleLink(a, b) {
    const ga = this.data.gates.find(g => g.id === a), gb = this.data.gates.find(g => g.id === b);
    if (!ga || !gb) return;
    if (ga.links.includes(b)) {
      ga.links = ga.links.filter(l => l !== b); gb.links = gb.links.filter(l => l !== a);
      ui.notifications.info(`Removed route ${ga.name} ↔ ${gb.name}.`);
    } else {
      ga.links.push(b); gb.links.push(a);
      ui.notifications.info(`Added route ${ga.name} ↔ ${gb.name}.`);
    }
    this.save(); this.rebuild();
  }

  factionForm(f, allowDelete) {
    return `
      <div class="form-group"><label>Name</label><input type="text" name="name" value="${esc(f.name)}" autofocus></div>
      <div class="form-group"><label>Colour</label><input type="color" name="color" value="${esc(f.color)}"></div>
      ${allowDelete ? `<div class="form-group"><label>Delete this faction</label><input type="checkbox" name="delete"></div>` : ""}`;
  }

  async scatterDialog(r) {
    const areaLy = `${fmtLy(r.x1 - r.x0)} × ${fmtLy(r.z1 - r.z0)}`;
    const f = await formDialog("Scatter Systems", `
      <p class="notes">Add randomly named star systems inside the highlighted area (${areaLy}).</p>
      <div class="form-group"><label>Number of systems</label><input type="number" name="count" value="10" min="1" max="500" autofocus></div>
      <div class="form-group"><label>Lowest level</label><input type="number" name="minLevel" value="-3" min="${-MAX_LEVEL}" max="${MAX_LEVEL}"></div>
      <div class="form-group"><label>Highest level</label><input type="number" name="maxLevel" value="3" min="${-MAX_LEVEL}" max="${MAX_LEVEL}"></div>
      <div class="form-group"><label>Hidden from players</label><input type="checkbox" name="hidden"></div>`, "Add systems");
    this.scatterBox.visible = false;
    if (!f) return;
    const count = clamp(Math.round(Number(f.count) || 0), 1, 500);
    let lo = clamp(Math.round(Number(f.minLevel) || 0), -MAX_LEVEL, MAX_LEVEL), hi = clamp(Math.round(Number(f.maxLevel) || 0), -MAX_LEVEL, MAX_LEVEL);
    if (lo > hi) [lo, hi] = [hi, lo];
    const added = this.scatterSystems(r, count, lo, hi, !!f.hidden);
    ui.notifications[added.length < count ? "warn" : "info"](added.length < count
      ? `Only room for ${added.length} of ${count} systems in that area without overlapping.`
      : `Added ${added.length} systems.`);
  }

  /** Place `count` random systems inside rect r on levels lo..hi, keeping them apart from existing points. */
  scatterSystems(r, count, lo, hi, hidden) {
    const rnd = Math.random, d = this.data;
    const namer = makeSystemNamer(rnd, new Set(d.systems.map(s => s.name)));
    const w = r.x1 - r.x0, h = r.z1 - r.z0;
    let sep = clamp(Math.sqrt((w * h) / count) * 0.55, 3, 40);
    const taken = [...d.systems, ...d.gates].map(o => [o.x, o.z]);
    const added = [];
    for (let tries = 0; added.length < count && tries < count * 400; tries++) {
      if (tries && tries % (count * 60) === 0) sep = Math.max(2.5, sep * 0.8);
      const x = r.x0 + rnd() * w, z = r.z0 + rnd() * h;
      if (taken.some(([a, b]) => Math.hypot(a - x, b - z) < sep)) continue;
      const lvl = lo + Math.floor(rnd() * (hi - lo + 1)), sz = rnd();
      const sys = {
        id: uid(), name: namer(), x, z, y: lvl * LEVEL_STEP, color: randomStarColor(rnd),
        size: sz < 0.015 ? 3 : sz < 0.06 ? 2 : sz < 0.16 ? 1.5 : 1, hidden, journal: "", notes: "", sceneId: ""
      };
      d.systems.push(sys); taken.push([x, z]); added.push(sys.id);
    }
    if (added.length) {
      this.lastScatter = added;
      this.save(); this.rebuild();
    }
    return added;
  }

  undoScatter() {
    if (!this.lastScatter?.length) return;
    const ids = new Set(this.lastScatter);
    const n = this.data.systems.length;
    this.data.systems = this.data.systems.filter(s => !ids.has(s.id));
    if (ids.has(this.data.partyAt)) this.data.partyAt = null;
    this.lastScatter = null;
    if (this.selected && ids.has(this.selected.id)) this.selected = null;
    this.save(); this.rebuild();
    ui.notifications.info(`Removed ${n - this.data.systems.length} scattered systems.`);
  }

  async generateDialog() {
    const shapes = [["spiral", "Spiral"], ["elliptical", "Elliptical"], ["irregular", "Irregular clusters"], ["ring", "Ring"]];
    const f = await formDialog("Generate Random Galaxy", `
      <p class="notes"><b>This replaces everything on this map</b> (systems, fast-travel points, factions, territory). Export first with the macro API if you want a backup.</p>
      <div class="form-group"><label>Seed</label><input type="text" name="seed" value="${foundry.utils.randomID(8)}"></div>
      <div class="form-group"><label>Shape</label><select name="shape">${shapes.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
      <div class="form-group"><label>Spiral arms</label><input type="number" name="arms" value="4" min="2" max="6"></div>
      <div class="form-group"><label>Star systems</label><input type="number" name="systems" value="80" min="5" max="400"></div>
      <div class="form-group"><label>Fast-travel points</label><input type="number" name="gates" value="10" min="0" max="40"></div>
      <div class="form-group"><label>Factions</label><input type="number" name="factions" value="4" min="0" max="12"></div>
      <div class="form-group"><label>Vertical spread (levels)</label><input type="number" name="spread" value="3" min="0" max="${MAX_LEVEL}"></div>`, "Generate");
    if (!f) return;
    const data = generateGalaxy(f);
    this.selected = null; this.factionIdx = 0;
    this.setData(data);
    clearTimeout(this._saveTimer); this._saveTimer = null;
    await this.writeSave();
    Object.assign(this.goal, { tx: 0, ty: 0, tz: 0, dist: 2600 });
    ui.notifications.info(`Generated ${data.systems.length} systems, ${data.gates.length} fast-travel points and ${data.factions.length} factions (seed "${data.galaxy.seed}").`);
  }

  async addFaction() {
    const hue = Math.floor(Math.random() * 360);
    const color = new THREE.Color().setHSL(hue / 360, 0.8, 0.6).getHexString();
    const f = await formDialog("New Faction", this.factionForm({ name: "New Faction", color: `#${color}` }, false), "Create");
    if (!f) return;
    this.data.factions.push({ id: uid(), name: f.name?.trim() || "New Faction", color: f.color });
    this.factionIdx = this.data.factions.length - 1;
    this.refreshTerritory(); this.save(); this.renderToolbar();
  }

  async editFaction() {
    const fac = this.data.factions[this.factionIdx];
    if (!fac) return;
    const f = await formDialog(`Edit ${fac.name}`, this.factionForm(fac, true));
    if (!f) return;
    if (f.delete) {
      const n = this.factionIdx + 1;
      for (let i = 0; i < this.cells.length; i++) {
        if (this.cells[i] === n) this.cells[i] = 0;
        else if (this.cells[i] > n) this.cells[i]--;
      }
      this.data.factions.splice(this.factionIdx, 1);
      this.factionIdx = Math.max(0, this.factionIdx - 1);
    } else {
      fac.name = f.name?.trim() || fac.name;
      fac.color = f.color || fac.color;
    }
    this.refreshTerritory(); this.save(); this.renderToolbar(); this.renderPanel();
  }

  /* ---------- UI ---------- */

  setMode(mode) {
    if (!["system", "gate"].includes(mode) && !["system", "gate"].includes(this.mode)) this._savedView = null;
    this.mode = mode;
    this.linkFrom = null;
    this.brushCursor.visible = false;
    if (this.scatterBox) this.scatterBox.visible = false;
    this.scatterStart = null;
    const placing = ["system", "gate"].includes(mode);
    if (placing && !this._savedView) this._savedView = { ...this.goal };
    else if (!placing && this._savedView) { Object.assign(this.goal, this._savedView); this._savedView = null; }
    this.renderToolbar();
    if (this._lastMouse) this.updateGhost(...this._lastMouse); else this.updateGhost(-1, -1);
  }

  hint() {
    if (!this.isGM || !this.editOpen) return "WASD or drag to move · Right-drag to rotate (drag down to look up from below) · Scroll to zoom · Names show near your cursor (hold Alt for all) · Click a point for details";
    switch (this.mode) {
      case "paint": return "Drag to paint territory for the selected faction.";
      case "erase": return "Drag to clear territory.";
      case "scatter": return "Drag a box over part of the map, then choose how many random systems to add there · Right-drag rotates, scroll zooms, WASD moves.";
      case "system": return "View locked to the whole galaxy · Click to place a star system on the highlighted level · ↑ / ↓ change level.";
      case "gate": return "View locked to the whole galaxy · Click to place a fast-travel point on the highlighted level · ↑ / ↓ change level.";
      case "link": {
        const from = this.data.gates.find(g => g.id === this.linkFrom);
        return from ? `Linking from ${esc(from.name)}: click another fast-travel point to add or remove the route.`
          : "Click a fast-travel point, then another, to add or remove a route between them.";
      }
      default: return "WASD or drag to move · Right-drag to rotate · Scroll to zoom · Shift-drag to move a point · Drop a journal on a point to link it";
    }
  }

  renderToolbar() {
    const gm = this.isGM, m = this.mode, editing = gm && this.editOpen;
    const btn = (mode, icon, label) =>
      `<button type="button" data-mode="${mode}" class="${m === mode ? "active" : ""}" data-tooltip="${label}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`;
    const act = (a, icon, label, cls = "") => `<button type="button" data-act="${a}" class="${cls}" data-tooltip="${label}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`;

    // Always-visible row
    let h = `<div class="gm-row">`;
    if (gm) h += act("edit-toggle", editing ? "fa-xmark" : "fa-pen-ruler", editing ? "Close editor" : "Edit map", editing ? "active" : "") + `<span class="sep"></span>`;
    h += act("party", "fa-location-crosshairs", "Find party") + act("reset", "fa-expand", "Whole galaxy");
    if (this.backdropSrc()) h += act("backdrop", "fa-image", "Background", this.showBackdrop ? "active" : "");
    if (gm) h += act("sync", "fa-eye", "Show players my view");
    h += `</div>`;

    // Editor rows (GM, only while the editor is open)
    if (editing) {
      h += `<div class="gm-row gm-edit">`
        + btn("navigate", "fa-arrow-pointer", "Select") + btn("paint", "fa-paintbrush", "Paint") + btn("erase", "fa-eraser", "Erase")
        + btn("system", "fa-sun", "Add system") + btn("gate", "fa-circle-nodes", "Add fast-travel") + btn("scatter", "fa-wand-magic-sparkles", "Scatter systems") + btn("link", "fa-link", "Link routes")
        + `<span class="sep"></span>`
        + act("backdrop-edit", "fa-crop-simple", "Adjust background")
        + act("generate", "fa-dice", "Generate galaxy") + act("import", "fa-file-import", "Import") + act("export", "fa-file-export", "Export")
        + `</div>`;
      if (m === "paint" || m === "erase") {
        const opts = this.data.factions.map((f, i) => `<option value="${i}" ${i === this.factionIdx ? "selected" : ""}>${esc(f.name)}</option>`).join("");
        h += `<div class="gm-row gm-edit">
          ${m === "paint" ? `<label>Faction</label><select name="faction">${opts || "<option>(none)</option>"}</select>
          <button type="button" data-act="faction-add" data-tooltip="New faction"><i class="fa-solid fa-plus"></i></button>
          <button type="button" data-act="faction-edit" data-tooltip="Edit faction"><i class="fa-solid fa-pen"></i></button>` : ""}
          <label>Brush</label><input type="range" name="brush" min="1" max="20" value="${this.brush}"></div>`;
      }
      if (m === "scatter" && this.lastScatter?.length) {
        h += `<div class="gm-row gm-edit">${act("undo-scatter", "fa-rotate-left", `Undo last scatter (${this.lastScatter.length})`)}</div>`;
      }
      if (m === "system" || m === "gate") {
        h += `<div class="gm-row gm-edit"><label>Level</label>
          <button type="button" data-act="level-down" data-tooltip="Down a level (↓)"><i class="fa-solid fa-chevron-down"></i></button>
          <span class="gm-level-value">${fmtLevel(this.levelY)}</span>
          <button type="button" data-act="level-up" data-tooltip="Up a level (↑)"><i class="fa-solid fa-chevron-up"></i></button></div>`;
      }
    }
    h += `<div class="gm-legend">${this.data.factions.map(f => `<span><i style="background:${esc(f.color)}"></i>${esc(f.name)}</span>`).join("")}</div>`;
    h += `<div class="gm-hint">${this.hint()}</div>`;
    this.toolbarEl.innerHTML = h;
  }

  toggleEditor(open = !this.editOpen) {
    this.editOpen = open;
    try { localStorage.setItem(`${MODULE_ID}.editOpen`, open ? "1" : "0"); } catch { /* storage unavailable */ }
    if (!open && this.mode !== "navigate") this.setMode("navigate");
    else this.renderToolbar();
  }

  onToolbar(e) {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.mode) return this.setMode(b.dataset.mode);
    switch (b.dataset.act) {
      case "party": return this.centerOnParty();
      case "reset": return Object.assign(this.goal, { tx: 0, tz: 0, dist: 2600, pitch: 35 });
      case "sync":
        game.socket.emit(SOCKET, { type: "view", sceneId: this.scene.id, goal: { ...this.goal } });
        return ui.notifications.info("Sent your view to players on this map.");
      case "faction-add": return this.addFaction();
      case "level-up": return this.setLevel(this.level + 1);
      case "level-down": return this.setLevel(this.level - 1);
      case "edit-toggle": return this.toggleEditor();
      case "generate": return this.generateDialog();
      case "undo-scatter": return this.undoScatter();
      case "backdrop": return this.toggleBackdrop();
      case "backdrop-edit": return this.backdropDialog();
      case "export": return exportGalaxy(this.scene);
      case "import": return importGalaxy(this.scene);
      case "faction-edit": return this.editFaction();
    }
  }

  onToolbarInput(e) {
    if (e.target.name === "faction") this.factionIdx = Number(e.target.value) || 0;
    if (e.target.name === "brush") this.brush = Number(e.target.value) || 4;
  }

  select(it) {
    this.selected = it ? { kind: it.kind, id: it.obj.id } : null;
    this.renderPanel();
  }

  renderPanel() {
    const it = this.selectedItem();
    if (!it) { this.panelEl.classList.add("hidden"); this.panelEl.innerHTML = ""; return; }
    const o = it.obj, gm = this.isGM, fac = this.factionAt(o.x, o.z), isGate = it.kind === "gate";
    let h = `<header>
        <div><span class="kind">${isGate ? "Fast-travel point" : "Star system"}</span>
        <h3>${esc(o.name)}</h3></div>
        <a class="close" data-action="close"><i class="fa-solid fa-xmark"></i></a></header>`;
    if (o.hidden) h += `<div class="badge">Hidden from players</div>`;
    h += `<div class="row"><span>Elevation</span><b>${fmtLevel(o.y)}</b></div>`;
    h += `<div class="row"><span>Controlled by</span><b style="color:${esc(fac?.color ?? "#9aa")}">${esc(fac?.name ?? "Unclaimed")}</b></div>`;
    if (this.data.partyAt === o.id) h += `<div class="row party"><i class="fa-solid fa-caret-down"></i> The party is here</div>`;
    if (o.notes) h += `<p class="notes">${esc(o.notes)}</p>`;
    if (isGate) {
      const dests = o.links.map(id => this.data.gates.find(g => g.id === id)).filter(g => g && (gm || !g.hidden));
      h += `<h4>Jump routes</h4>`;
      h += dests.length ? dests.map(g => {
        const ly = fmtLy(Math.hypot(g.x - o.x, g.y - o.y, g.z - o.z));
        return `<div class="dest"><span class="name">${esc(g.name)}</span><span class="dist">${ly}</span>
          <button type="button" data-action="view-jump" data-id="${g.id}" data-tooltip="Jump your view there"><i class="fa-solid fa-eye"></i></button>
          ${gm ? `<button type="button" data-action="party-jump" data-id="${g.id}" data-tooltip="Move the party and everyone's view"><i class="fa-solid fa-rocket"></i></button>` : ""}</div>`;
      }).join("") : `<p class="muted">No routes linked.</p>`;
    }
    h += `<div class="actions">
      <button type="button" data-action="fly"><i class="fa-solid fa-crosshairs"></i> Fly to</button>
      ${o.journal ? `<button type="button" data-action="journal"><i class="fa-solid fa-book-open"></i> Journal</button>` : ""}`;
    const linked = o.sceneId ? game.scenes.get(o.sceneId) : null;
    if (linked && (gm || linked.testUserPermission(game.user, "LIMITED")))
      h += `<button type="button" data-action="scene-view" data-tooltip="View ${esc(linked.name)} yourself"><i class="fa-solid fa-arrow-down-to-bracket"></i> Enter</button>`;
    if (linked && gm)
      h += `<button type="button" data-action="scene-activate" data-tooltip="Activate ${esc(linked.name)} for everyone"><i class="fa-solid fa-users"></i> Take party there</button>`;
    if (gm) h += `
      <button type="button" data-action="party-here"><i class="fa-solid fa-flag"></i> Party here</button>
      <button type="button" data-action="edit"><i class="fa-solid fa-pen"></i> Edit</button>
      <button type="button" data-action="toggle-hidden"><i class="fa-solid ${o.hidden ? "fa-eye" : "fa-eye-slash"}"></i> ${o.hidden ? "Reveal" : "Hide"}</button>
      <button type="button" data-action="delete" class="danger"><i class="fa-solid fa-trash"></i> Delete</button>`;
    h += `</div>`;
    this.panelEl.innerHTML = h;
    this.panelEl.classList.remove("hidden");
  }

  async onPanel(e) {
    const b = e.target.closest("[data-action]"); if (!b) return;
    const it = this.selectedItem(); if (!it) return;
    switch (b.dataset.action) {
      case "close": return this.select(null);
      case "fly": return this.flyTo(it.obj);
      case "journal": return this.openJournal(it.obj.journal);
      case "scene-view": return this.enterScene(it.obj, false);
      case "scene-activate": return this.enterScene(it.obj, true);
      case "edit": return this.editItem(it);
      case "delete": return this.deleteItem(it);
      case "toggle-hidden": it.obj.hidden = !it.obj.hidden; this.save(); return this.rebuild();
      case "party-here": this.data.partyAt = it.obj.id; this.save(); return this.renderPanel();
      case "view-jump": return this.doJump(b.dataset.id);
      case "party-jump":
        this.data.partyAt = b.dataset.id;
        this.save();
        game.socket.emit(SOCKET, { type: "jump", sceneId: this.scene.id, to: b.dataset.id });
        return this.doJump(b.dataset.id);
    }
  }

  async openJournal(uuid) {
    const doc = await fromUuid(uuid);
    if (!doc) return ui.notifications.warn("The linked journal could not be found.");
    if (!doc.testUserPermission(game.user, "OBSERVER")) return ui.notifications.warn("You don't have permission to view that journal.");
    if (doc.documentName === "JournalEntryPage") doc.parent.sheet.render(true, { pageId: doc.id });
    else doc.sheet.render(true);
  }
}

/* -------------------------------------------- */
/*  Mounting & hooks                            */
/* -------------------------------------------- */

function syncMount() {
  const scene = canvas?.scene;
  const on = !!scene?.getFlag(MODULE_ID, "enabled");
  if (activeMap && (!on || activeMap.scene !== scene)) { activeMap.destroy(); activeMap = null; }
  if (on && !activeMap) {
    activeMap = new GalaxyMap(scene);
    activeMap.mount().catch(err => {
      console.error(`${MODULE_ID} | Failed to start galaxy map`, err);
      ui.notifications.error("Galaxy Map failed to load three.js. Check the console, or add lib/three.module.js to the module folder.");
      activeMap?.destroy(); activeMap = null;
    });
  }
}

async function toggleGalaxy(scene) {
  if (!game.user.isGM || !scene) return;
  const on = !scene.getFlag(MODULE_ID, "enabled");
  const update = { [`flags.${MODULE_ID}.enabled`]: on };
  if (on && !scene.getFlag(MODULE_ID, FLAG)) update[`flags.${MODULE_ID}.${FLAG}`] = defaultData(scene.id);
  await scene.update(update);
  ui.notifications.info(`Galaxy Map ${on ? "enabled" : "disabled"} for ${scene.name}.`);
}

/* -------------------------------------------- */
/*  Import / export                             */
/* -------------------------------------------- */

function downloadJSON(obj, filename) {
  const text = JSON.stringify(obj, null, 2);
  const save = foundry.utils.saveDataToFile ?? globalThis.saveDataToFile;
  if (save) return save(text, "application/json", filename);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportGalaxy(scene) {
  scene ??= canvas.scene;
  if (activeMap?.scene === scene && activeMap._saveTimer) { clearTimeout(activeMap._saveTimer); activeMap._saveTimer = null; activeMap.writeSave(); }
  const data = activeMap?.scene === scene
    ? { ...foundry.utils.deepClone(activeMap.data), territory: { res: activeMap.res, cells: rleEncode(activeMap.cells) } }
    : scene?.getFlag(MODULE_ID, FLAG);
  if (!data) return ui.notifications.warn("This scene has no galaxy map to export.");
  const slug = (scene.name || "galaxy").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  downloadJSON({ module: MODULE_ID, version: game.modules.get(MODULE_ID).version, exportedAt: new Date().toISOString(), name: scene.name, data },
    `galaxy-map-${slug || "export"}.json`);
  ui.notifications.info(`Exported galaxy map "${scene.name}".`);
}

/** Check and tidy imported data. Returns { data, notes } or throws with a readable message. */
function validateImport(json) {
  const raw = json?.data ?? json;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.systems)) throw new Error("This file doesn't look like a Galaxy Map export.");
  const d = normalize(raw), notes = [];
  if (!Array.isArray(d.gates)) d.gates = [];
  if (!Array.isArray(d.factions)) d.factions = [];
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const ids = new Set();
  const fixId = o => { if (!o.id || ids.has(o.id)) o.id = uid(); ids.add(o.id); };
  d.systems = d.systems.filter(o => o && typeof o === "object");
  d.gates = d.gates.filter(o => o && typeof o === "object");
  for (const o of [...d.systems, ...d.gates]) {
    fixId(o);
    o.x = clamp(num(o.x), -EXTENT, EXTENT); o.z = clamp(num(o.z), -EXTENT, EXTENT); o.y = num(o.y);
    o.name = String(o.name ?? "Unnamed"); o.hidden = !!o.hidden; o.notes = String(o.notes ?? ""); o.journal = String(o.journal ?? "");
    if (o.sceneId && typeof game !== "undefined" && !game.scenes.get(o.sceneId)) { o.sceneId = ""; notes.push("scene"); }
  }
  const gateIds = new Set(d.gates.map(g => g.id));
  for (const g of d.gates) g.links = [...new Set((Array.isArray(g.links) ? g.links : []).filter(l => gateIds.has(l) && l !== g.id))];
  for (const g of d.gates) for (const l of g.links) { const o = d.gates.find(x => x.id === l); if (!o.links.includes(g.id)) o.links.push(g.id); }
  d.factions = d.factions.filter(f => f && typeof f === "object").map(f => ({ id: f.id || uid(), name: String(f.name ?? "Faction"), color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : "#888888" }));
  if (Number(d.territory?.res) !== RES || typeof d.territory?.cells !== "string") {
    d.territory = { res: RES, cells: "" };
    notes.push("territory");
  } else {
    const cells = rleDecode(d.territory.cells, RES * RES), max = d.factions.length;
    for (let i = 0; i < cells.length; i++) if (!(cells[i] <= max)) cells[i] = 0;
    d.territory.cells = rleEncode(cells);
  }
  if (d.partyAt && !ids.has(d.partyAt)) d.partyAt = null;
  const bd = d.backdrop;
  d.backdrop = { src: String(bd.src ?? ""), scale: clamp(Number(bd.scale) || 1, 0.05, 5), x: Number(bd.x) || 0, z: Number(bd.z) || 0,
    opacity: clamp(Number.isFinite(Number(bd.opacity)) ? Number(bd.opacity) : 0.85, 0, 1) };
  const gx = d.galaxy;
  d.galaxy = {
    seed: gx.seed ?? null, shape: ["spiral", "elliptical", "irregular", "ring"].includes(gx.shape) ? gx.shape : "spiral",
    arms: clamp(Number(gx.arms) || 4, 1, 8), twist: Number.isFinite(Number(gx.twist)) ? Number(gx.twist) : 4.2,
    rotation: Number(gx.rotation) || 0, ...(Number(gx.lyPerUnit) > 0 ? { lyPerUnit: Number(gx.lyPerUnit) } : {})
  };
  return { data: d, notes };
}

function pickJSONFile() {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".json,application/json";
    input.addEventListener("change", async () => resolve(input.files?.[0] ? await input.files[0].text() : null), { once: true });
    input.click();
  });
}

async function importGalaxy(scene) {
  scene ??= canvas.scene;
  if (!game.user.isGM || !scene) return;
  const text = await pickJSONFile();
  if (!text) return;
  let json, result;
  try { json = JSON.parse(text); result = validateImport(json); }
  catch (err) { return ui.notifications.error(`Import failed: ${err instanceof SyntaxError ? "the file isn't valid JSON." : err.message}`); }
  const { data, notes } = result;
  const ok = await confirmDialog("Import Galaxy Map", `
    <p>Import <b>${esc(json.name ?? "galaxy map")}</b> into <b>${esc(scene.name)}</b>?</p>
    <p>${data.systems.length} systems · ${data.gates.length} fast-travel points · ${data.factions.length} factions</p>
    <p><b>This replaces the current map on this scene.</b></p>`);
  if (!ok) return;
  await writeMapData(scene, data);
  if (!scene.getFlag(MODULE_ID, "enabled")) await scene.update({ [`flags.${MODULE_ID}.enabled`]: true });
  const msgs = [];
  if (notes.includes("scene")) msgs.push("links to scenes that don't exist in this world were removed");
  if (notes.includes("territory")) msgs.push("faction territory couldn't be read and was cleared");
  ui.notifications.info(`Imported galaxy map into ${scene.name}.${msgs.length ? ` Note: ${msgs.join("; ")}.` : ""}`);
}

/** Write map data to a scene and refresh the open map (our own update echo is otherwise ignored). */
async function writeMapData(scene, data) {
  scene ??= canvas.scene;
  if (activeMap?.scene === scene) { clearTimeout(activeMap._saveTimer); activeMap._saveTimer = null; activeMap.selected = null; }
  await scene.update({ [`flags.${MODULE_ID}.${FLAG}`]: data });
  if (activeMap?.scene === scene) activeMap.setData(scene.getFlag(MODULE_ID, FLAG));
}

/** Find the galaxy map that links to the current scene (or any galaxy map) and go back to it. */
async function returnToGalaxy() {
  const here = canvas?.scene?.id;
  const galaxies = game.scenes.filter(s => s.getFlag(MODULE_ID, "enabled"));
  const linksHere = s => { const d = s.getFlag(MODULE_ID, FLAG); return [...(d?.systems ?? []), ...(d?.gates ?? [])].some(o => o.sceneId === here); };
  const target = galaxies.find(linksHere) ?? galaxies[0];
  if (!target) return ui.notifications.warn("No Galaxy Map scene found.");
  return game.user.isGM ? target.activate() : target.view();
}

const contextEntry = {
  name: "Toggle Galaxy Map",
  icon: '<i class="fa-solid fa-star"></i>',
  condition: () => game.user.isGM,
  callback: li => {
    const el = li instanceof HTMLElement ? li : li?.[0];
    const id = el?.dataset?.entryId ?? el?.dataset?.documentId ?? el?.dataset?.sceneId;
    toggleGalaxy(game.scenes.get(id));
  }
};
const sceneFromLi = li => { const el = li instanceof HTMLElement ? li : li?.[0]; return game.scenes.get(el?.dataset?.entryId ?? el?.dataset?.documentId ?? el?.dataset?.sceneId); };
const extraEntries = [
  { name: "Export Galaxy Map", icon: '<i class="fa-solid fa-file-export"></i>',
    condition: li => game.user.isGM && !!sceneFromLi(li)?.getFlag(MODULE_ID, FLAG), callback: li => exportGalaxy(sceneFromLi(li)) },
  { name: "Import Galaxy Map", icon: '<i class="fa-solid fa-file-import"></i>',
    condition: () => game.user.isGM, callback: li => importGalaxy(sceneFromLi(li)) }
];
const addContext = (_app, options) => {
  for (const entry of [contextEntry, ...extraEntries]) if (!options.some(o => o.name === entry.name)) options.push(entry);
};
Hooks.on("getSceneContextOptions", addContext);          // Scenes sidebar (v13+)
Hooks.on("getSceneNavigationContextOptions", addContext); // top scene navigation bar

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "labelRadius", {
    name: "Galaxy Map: label radius",
    hint: "How close (in screen pixels) the cursor must be for star system and fast-travel names to appear. Hold Alt on the map to show every name.",
    scope: "client", config: true, type: Number, range: { min: 60, max: 800, step: 20 }, default: 200,
    onChange: v => { if (activeMap) activeMap.labelRadius = Number(v) || 200; }
  });
  game.keybindings.register(MODULE_ID, "returnToGalaxy", {
    name: "Return to Galaxy Map",
    hint: "Go back to the galaxy map that links to the current scene (GM: activates it for everyone).",
    editable: [{ key: "KeyG", modifiers: ["Shift"] }],
    onDown: () => { if (!activeMap) returnToGalaxy(); return true; }
  });
  game.modules.get(MODULE_ID).api = {
    toggle: scene => toggleGalaxy(scene ?? canvas.scene),
    get map() { return activeMap; },
    exportData: scene => foundry.utils.deepClone((scene ?? canvas.scene)?.getFlag(MODULE_ID, FLAG) ?? null),
    importData: (data, scene) => writeMapData(scene, validateImport(data).data),
    exportFile: scene => exportGalaxy(scene),
    importFile: scene => importGalaxy(scene),
    returnToGalaxy: () => returnToGalaxy(),
    generate: (options = {}, scene) => writeMapData(scene, generateGalaxy(options)),
    resetSampleData: scene => writeMapData(scene, defaultData(`${(scene ?? canvas.scene).id}${Date.now()}`))
  };
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, msg => {
    if (!activeMap || activeMap.scene.id !== msg?.sceneId) return;
    if (msg.type === "view") Object.assign(activeMap.goal, msg.goal);
    if (msg.type === "jump") { activeMap.data.partyAt = msg.to; activeMap.doJump(msg.to); }
    if (msg.type === "dive") {
      const o = [...activeMap.data.systems, ...activeMap.data.gates].find(x => x.id === msg.to);
      if (o) activeMap.dive(o);
    }
  });
});

Hooks.on("canvasReady", () => syncMount());

Hooks.on("updateScene", (doc, change, _opts, userId) => {
  if (doc.id !== canvas?.scene?.id) return;
  const f = foundry.utils.getProperty(change, `flags.${MODULE_ID}`);
  if (!f) return;
  if ("enabled" in f || "-=enabled" in f) return syncMount();
  if (activeMap && userId !== game.user.id && FLAG in f) activeMap.setData(doc.getFlag(MODULE_ID, FLAG));
});

Hooks.on("updateScene", (doc, change) => {
  if (!activeMap || doc !== activeMap.scene) return;
  if ("background" in change || "img" in change || "thumb" in change) {
    if (activeMap.backdropKey() !== activeMap._backdropKey) { activeMap.loadBackdrop(); activeMap.renderToolbar(); }
  }
});

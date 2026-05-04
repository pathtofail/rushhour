#!/usr/bin/env node
// Estimate per-arrow exit probability for Rush Hour's roulette mode.
//
// For each round we count which ring slots had ≥1 exit. Average across
// many rounds → P_i. Print a JSON-ish RUSH_ARROW_ODDS table sized so
// betting equally on every arrow yields ~95% RTP (odds_i = 0.95 / P_i).
//
// CLI: `node scripts/sim-arrows.mjs [spins=20000] [seed=42] [target=0.95]`

import fs from 'node:fs';
import vm from 'node:vm';

const HTML = fs.readFileSync('index.html', 'utf8');
let code = [...HTML.matchAll(/<script(?:\s+type=["']module["'])?[^>]*>([\s\S]*?)<\/script>/g)]
  .map(b => b[1]).join('\n;\n');
code = code.replace(/^\s*import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '');
code = `;(async () => {
  try { ${code} } catch (e) { __setError(e); } finally { __ready(); }
})().catch(e => __setError(e));`;

const noop = () => {};
let _ready, _error = null;
const ready = new Promise(r => { _ready = r; });

class ContainerStub {
  constructor() {
    this.children = [];
    this.x = 0; this.y = 0;
    this.scale = { x: 1, y: 1, set(a, b) { this.x = a; this.y = b ?? a; } };
    this.position = { set: noop };
    this.alpha = 1; this.visible = true; this.rotation = 0;
    this.eventMode = 'none'; this.cursor = 'default';
    this.sortableChildren = false;
  }
  addChild(c) { this.children.push(c); return c; }
  addChildAt(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
  removeChildren() { this.children.length = 0; }
  destroy() { this.destroyed = true; }
  on() { return this; } off() { return this; }
}
class SpriteStub extends ContainerStub {
  constructor() { super(); this.anchor = { set: noop }; this.tint = 0xFFFFFF; this.texture = null; }
}
class GraphicsStub extends ContainerStub {
  beginFill() { return this; } endFill() { return this; }
  lineStyle() { return this; } drawRect() { return this; }
  drawRoundedRect() { return this; } drawCircle() { return this; }
  drawPolygon() { return this; } moveTo() { return this; }
  lineTo() { return this; } clear() { return this; }
}
class TextStub extends ContainerStub {
  constructor(t) { super(); this.text = t; this.anchor = { set: noop }; this.style = {}; this.width = 0; this.height = 0; }
}
const PIXIStub = {
  Assets: { load: async () => ({ width: 400, height: 400, baseTexture: { width: 400, height: 400 } }) },
  Application: class {
    constructor() {
      this.screen = { width: 1024, height: 768 };
      this.stage = new ContainerStub();
      this.view = { addEventListener: noop, removeEventListener: noop, style: {}, id: '' };
      this.renderer = { resize: noop };
    }
  },
  Container: ContainerStub, Sprite: SpriteStub, Graphics: GraphicsStub, Text: TextStub,
  Rectangle: class { constructor(x = 0, y = 0, w = 0, h = 0) { this.x = x; this.y = y; this.width = w; this.height = h; } },
  RoundedRectangle: class { constructor() {} },
  Circle: class { constructor() {} },
  Point: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
  Texture: { from: () => ({}) },
};
const gsapStub = new Proxy(() => gsapStub, { get: () => gsapStub, apply: () => gsapStub });

const sandbox = {
  PIXI: PIXIStub, gsap: gsapStub, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Math, Date, JSON, Promise, Set, Map,
  Array, Object, Number, String, Boolean, RegExp, Error,
  Proxy, Reflect, Symbol,
  Float32Array, Uint8Array, Int32Array, Uint16Array,
  parseInt, parseFloat, isNaN, isFinite,
  document: {
    addEventListener: noop, removeEventListener: noop,
    body: { appendChild: noop, style: {} },
    createElement: () => ({ style: {}, appendChild: noop, addEventListener: noop }),
    querySelector: () => null, getElementById: () => ({ remove: noop }),
    fonts: { load: async () => ({}) },
  },
  navigator: { userAgent: 'sim' },
  performance: { now: () => Date.now() },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  __ready: () => _ready(),
  __setError: (e) => { _error = e; },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.requestAnimationFrame = noop;
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
sandbox.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
sandbox.innerWidth = 1024; sandbox.innerHeight = 768; sandbox.devicePixelRatio = 1;

const ctx = vm.createContext(sandbox);
try { vm.runInContext(code, ctx, { filename: 'index.html' }); }
catch (e) { console.error('vm.runInContext threw:', e?.stack || e?.message || e); process.exit(1); }
process.on('unhandledRejection', (r) => console.error('UNHANDLED:', r?.stack || r?.message || r));

await Promise.race([
  ready,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
]).catch(e => { console.error('Engine init failed:', e.message); process.exit(1); });
if (_error) { console.error('Engine error:', _error?.stack || _error?.message || _error); process.exit(1); }

const RushHour = sandbox.window.RushHour;
if (!RushHour) { console.error('RushHour not exposed'); process.exit(1); }

const N      = parseInt(process.argv[2] || '20000', 10);
const SEED   = parseInt(process.argv[3] || '42', 10);
const TARGET = parseFloat(process.argv[4] || '0.95');

RushHour.setRng(RushHour.makeSeededRng(SEED));
const RING_SIZE = RushHour.RING_SIZE;
console.log(`\nRush Hour arrow probability sim · spins=${N} · seed=${SEED} · target_RTP=${TARGET}`);
console.log(`Ring size: ${RING_SIZE} (${RushHour.GAME.ROWS}×${RushHour.GAME.COLS} grid)\n`);

const hits   = new Array(RING_SIZE + 1).fill(0); // index by pos 1..RING_SIZE
const counts = new Array(RING_SIZE + 1).fill(0); // total exits per pos (for diagnostics)
const state  = { conveyor: [], freeSpinsBank: 0, inFreeSpin: false };

const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const r = RushHour.runSpin(1, state);
  // Count per-arrow exits this spin.
  const seen = new Set();
  for (const ev of r.events) {
    if (ev.type !== 'rushMovePass') continue;
    for (const m of ev.moves || []) {
      if (m.kind !== 'exit' || m.ringPos == null) continue;
      counts[m.ringPos] += 1;
      seen.add(m.ringPos);
    }
  }
  for (const p of seen) hits[p] += 1;
}
const dt = Date.now() - t0;
console.log(`Done in ${dt}ms · ${(N / dt * 1000).toFixed(0)} spins/sec\n`);

const C = RushHour.GAME.COLS, R = RushHour.GAME.ROWS;
const edgeName = (pos) =>
  (pos >= 1 && pos <= C)                       ? 'top' :
  (pos >= C + 1 && pos <= C + R)               ? 'right' :
  (pos >= C + R + 1 && pos <= 2 * C + R)       ? 'bottom' :
  (pos >= 2 * C + R + 1 && pos <= 2 * (C + R)) ? 'left' : '';

// The engine has gravity (top→bottom), so it's left-right symmetric but
// NOT vertically symmetric. Each ring slot has exactly one mirror partner
// across the vertical centre line; we average their measured probabilities
// to eliminate sampling noise from a real symmetry.
function mirrorSlot(pos) {
  // Top edge 1..C → mirror within top edge: 1↔C, 2↔C-1, …
  if (pos >= 1 && pos <= C) return C + 1 - pos;
  // Right edge C+1..C+R ↔ Left edge 2C+R+1..2(C+R) by row.
  // Right slot at row r (pos = C+1+r) mirrors to left slot at row r
  //   (left pos = 2(C+R) - r).
  if (pos >= C + 1 && pos <= C + R) {
    const r = pos - C - 1;
    return 2 * (C + R) - r;
  }
  // Bottom edge C+R+1..2C+R: mirror within bottom edge.
  if (pos >= C + R + 1 && pos <= 2 * C + R) {
    const off = pos - (C + R);    // 1..C
    return (C + R) + (C + 1 - off);
  }
  // Left edge mirrors to right edge.
  if (pos >= 2 * C + R + 1 && pos <= 2 * (C + R)) {
    const r = 2 * (C + R) - pos;
    return C + 1 + r;
  }
  return pos;
}

console.log('pos | edge   | P(raw)  | P(sym)  | odds (0.95/P_sym) | E[exits]');
console.log('----|--------|---------|---------|-------------------|---------');
const pSym = new Array(RING_SIZE + 1).fill(0);
const odds = {};
for (let pos = 1; pos <= RING_SIZE; pos++) {
  const pa = hits[pos] / N;
  const pb = hits[mirrorSlot(pos)] / N;
  pSym[pos] = (pa + pb) / 2;
  const o = pSym[pos] > 0 ? TARGET / pSym[pos] : 0;
  odds[pos] = +o.toFixed(3);
}
for (let pos = 1; pos <= RING_SIZE; pos++) {
  const p = hits[pos] / N;
  const e = counts[pos] / N;
  console.log(
    `${String(pos).padStart(3)} | ${edgeName(pos).padEnd(6)} | ${p.toFixed(4)} | ${pSym[pos].toFixed(4)} | ${odds[pos].toFixed(3).padStart(17)} | ${e.toFixed(3)}`
  );
}

// Verify RTP under symmetric odds with a uniform stake on every arrow.
// (Uses the RAW measured probabilities — the noise WITHIN a mirror pair
// cancels out across the pair, so per-pair RTP is exactly 0.95 in
// expectation; the printed number measures it on this run.)
let expectedReturn = 0;
for (let pos = 1; pos <= RING_SIZE; pos++) {
  const p = hits[pos] / N;
  expectedReturn += p * odds[pos];
}
const rtp = expectedReturn / RING_SIZE;
console.log(`\nAll-arrows uniform-stake RTP: ${(rtp * 100).toFixed(2)}%`);
console.log('\nPaste into index.html — RUSH_ARROW_ODDS:');
console.log(JSON.stringify(odds, null, 2));

#!/usr/bin/env node
// Estimate the rate at which a Traffic Jam round clears the entire grid
// (every car exits) versus partial clearance (some cars stay put when
// the grid jams).
//
// CLI: `node scripts/sim-clearance.mjs [spins=20000] [seed=42]`

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
  Texture: { from: () => ({}), EMPTY: {} },
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
const N    = parseInt(process.argv[2] || '20000', 10);
const SEED = parseInt(process.argv[3] || '42', 10);

RushHour.setRng(RushHour.makeSeededRng(SEED));
const ROWS = RushHour.GAME.ROWS, COLS = RushHour.GAME.COLS;
const TOTAL_CELLS = ROWS * COLS;

console.log(`\nTraffic Jam clearance sim · spins=${N} · seed=${SEED}`);
console.log(`Grid: ${ROWS}×${COLS} = ${TOTAL_CELLS} cars per round\n`);

let totalClears = 0;
const exitsPerRound = [];
const state = { conveyor: [], freeSpinsBank: 0, inFreeSpin: false };

const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const r = RushHour.runSpin(1, state);
  let exits = 0;
  for (const ev of r.events) {
    if (ev.type !== 'rushMovePass') continue;
    for (const m of ev.moves || []) {
      if (m.kind === 'exit') exits += 1;
    }
  }
  exitsPerRound.push(exits);
  if (exits >= TOTAL_CELLS) totalClears += 1;
}
const dt = Date.now() - t0;
console.log(`Done in ${dt}ms · ${(N / dt * 1000).toFixed(0)} spins/sec\n`);

const clearRate = totalClears / N;
const avgExits = exitsPerRound.reduce((a, b) => a + b, 0) / N;

// Distribution buckets
const dist = new Array(TOTAL_CELLS + 1).fill(0);
for (const e of exitsPerRound) dist[Math.min(e, TOTAL_CELLS)] += 1;

console.log(`TOTAL CLEARANCE rate (all ${TOTAL_CELLS} cars exit): ${(clearRate * 100).toFixed(2)}%   (${totalClears} / ${N})`);
console.log(`Average exits per round: ${avgExits.toFixed(2)} of ${TOTAL_CELLS}\n`);

console.log('Exits per round distribution (buckets of 1):');
console.log('exits | count    | %');
console.log('------|----------|--------');
for (let e = 0; e <= TOTAL_CELLS; e++) {
  if (dist[e] === 0) continue;
  const pct = (dist[e] / N * 100).toFixed(2);
  console.log(`${String(e).padStart(5)} | ${String(dist[e]).padStart(8)} | ${pct.padStart(6)}%`);
}

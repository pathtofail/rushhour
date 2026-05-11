#!/usr/bin/env node
// Tune Traffic Jam ante / special-bet RTPs.
//
// For each ante mode (base, ante1, super1, super2):
//   - sets the engine into that mode
//   - simulates N rounds where the player stakes 1 unit on each of
//     the 16 arrows (uniform strategy — every officer fire lands on a
//     staked arrow, so officer EV is fully realised)
//   - per round: rolls officer boosts, runs the engine, sums per-exit
//     wins (stake × arrowOdds × carPayMult × officerBoost), adds the
//     clearance bonus (+10× total wager) when applicable
//   - per round: deducts the bet (16 units) AND the ante surcharge
//     (16 × costMult)
//   - reports RTP = totalReturn / totalWagered
//
// CLI: `node scripts/sim-ante.mjs [spins=20000] [seed=42]`
//
// Re-run after adjusting ANTE_MODES in index.html. Target ~95% per mode.

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
  drawPolygon() { return this; } drawEllipse() { return this; }
  arc() { return this; }
  moveTo() { return this; } lineTo() { return this; } clear() { return this; }
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

const N    = parseInt(process.argv[2] || '20000', 10);
const SEED = parseInt(process.argv[3] || '42', 10);

const STAKE_PER_ARROW = 1;
const RING_SIZE = RushHour.RING_SIZE;
const TOTAL_WAGER_PER_ROUND = STAKE_PER_ARROW * RING_SIZE;   // 16 with 16 arrows

const COLOR_BY_NAME = RushHour.COLOR_BY_NAME;

console.log(`\nTraffic Jam ante-RTP sim · spins=${N} · seed=${SEED}`);
console.log(`Ring size: ${RING_SIZE}, stake-per-arrow: ${STAKE_PER_ARROW}, base wager/round: ${TOTAL_WAGER_PER_ROUND}\n`);

function simMode(modeKey) {
  RushHour.setAnteMode(modeKey);
  // Reset RNG so every mode sees the same engine sequence — that
  // isolates ante-mode effects from RNG variance.
  RushHour.setRng(RushHour.makeSeededRng(SEED));
  const ante = RushHour.getAnteDef();
  // Cost = TOTAL multiplier on the per-arrow stake. base.costMult=1
  // means cost = stake; ante1.costMult=2 means each arrow's stake
  // is deducted ×2 (e.g. $1 chip → $2 deducted), total ×2 wager.
  // Win calc still uses base stake (the extra is the ante fee).
  const totalCostPerRound = TOTAL_WAGER_PER_ROUND * ante.costMult;
  const state = { conveyor: [], freeSpinsBank: 0, inFreeSpin: false };

  let totalReturn   = 0;
  let baseReturn    = 0;     // exit pays only (no boosts, no clearance)
  let officerBoosts = 0;     // extra from officer multipliers
  let clearanceBoost = 0;    // +10× wager on full clearance
  let nClearances   = 0;
  let nFires        = 0;     // total officer fires across all rounds

  for (let i = 0; i < N; i++) {
    // 1. Roll the round's officer boosts (mode-aware via getAnteDef).
    const { boosts, fired } = RushHour.getModeDef().rollRoundBoosts(STAKE_PER_ARROW);
    nFires += fired.length;
    // 2. Run the spin.
    const r = RushHour._runSpinRaw(STAKE_PER_ARROW, state);
    // 3. Sum exits.
    let exitCount = 0;
    for (const ev of r.events) {
      if (ev.type !== 'rushMovePass') continue;
      for (const m of (ev.moves || [])) {
        if (m.kind !== 'exit') continue;
        exitCount += 1;
        const ringPos = m.ringPos;
        if (ringPos == null) continue;
        const stake = STAKE_PER_ARROW;
        const odds  = RushHour.arrowOddsFor(ringPos);
        const carDef = m.color && COLOR_BY_NAME[m.color];
        const carMult = (carDef && typeof carDef.payMult === 'number') ? carDef.payMult : 1;
        const base = stake * odds * carMult;
        const boost = boosts[ringPos] || 1;
        baseReturn    += base;
        officerBoosts += base * (boost - 1);
        totalReturn   += base * boost;
      }
    }
    // 4. Total clearance bonus: every grid cell drove off.
    // Multiplier should match the engine constant in onSpinClick
    // (currently 1× — bumped down from 10× to keep base RTP near 95%).
    const CLEARANCE_BONUS_MULT = 1;
    const totalCells = RushHour.GAME.ROWS * RushHour.GAME.COLS;
    if (exitCount >= totalCells) {
      const bonus = CLEARANCE_BONUS_MULT * TOTAL_WAGER_PER_ROUND;
      totalReturn    += bonus;
      clearanceBoost += bonus;
      nClearances += 1;
    }
  }

  const totalWagered = totalCostPerRound * N;
  const rtp = totalReturn / totalWagered;
  return {
    modeKey,
    name: ante.name,
    costMult: ante.costMult,
    totalWagered,
    totalReturn,
    baseReturn,
    officerBoosts,
    clearanceBoost,
    nClearances,
    nFires,
    avgFiresPerRound: nFires / N,
    clearanceRate: nClearances / N,
    rtp,
  };
}

const modes = ['base', 'ante1', 'super1', 'super2'];
const results = [];
const t0 = Date.now();
for (const m of modes) results.push(simMode(m));
const dt = Date.now() - t0;
console.log(`Done in ${dt}ms · ${(N * modes.length / dt * 1000).toFixed(0)} spins/sec\n`);

const fmt = (n, p = 2) => Number(n).toFixed(p);
console.log('mode    | cost  | wagered     | returned    | base      | officer   | clear     | fires/rd | clr%   | RTP');
console.log('--------|-------|-------------|-------------|-----------|-----------|-----------|----------|--------|--------');
for (const r of results) {
  console.log(
    `${r.modeKey.padEnd(7)} | ${(r.costMult + 'x').padStart(5)} | ` +
    `${fmt(r.totalWagered).padStart(11)} | ` +
    `${fmt(r.totalReturn).padStart(11)} | ` +
    `${fmt(r.baseReturn).padStart(9)} | ` +
    `${fmt(r.officerBoosts).padStart(9)} | ` +
    `${fmt(r.clearanceBoost).padStart(9)} | ` +
    `${fmt(r.avgFiresPerRound).padStart(8)} | ` +
    `${fmt(r.clearanceRate * 100).padStart(5)}% | ` +
    `${fmt(r.rtp * 100).padStart(6)}%`
  );
}

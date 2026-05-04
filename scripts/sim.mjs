#!/usr/bin/env node
// Trail Catcher RTP / variance sim.
//
// Extracts the inline engine from index.html, stubs the PIXI / DOM
// globals it references for boot-up, evaluates the engine in a vm
// sandbox, then runs runSpin in a loop with persistent conveyor state.
//
// CLI: `node scripts/sim.mjs [spins=10000] [bet=1] [seed=42]`

import fs from 'node:fs';
import vm from 'node:vm';

// CLI: spins=10000 bet=1 seed=42 mode=base|allAround|activator
const ARG_MODE = (process.argv[5] || 'base').trim();
if (!['base', 'allAround', 'activator', 'rush'].includes(ARG_MODE)) {
  console.error(`Unknown mode "${ARG_MODE}" — expected base | allAround | activator | rush`);
  process.exit(1);
}

const HTML = fs.readFileSync('index.html', 'utf8');
const blocks = [...HTML.matchAll(/<script(?:\s+type=["']module["'])?[^>]*>([\s\S]*?)<\/script>/g)];
let code = blocks.map(b => b[1]).join('\n;\n');

// Strip ESM imports — Trail Catcher doesn't import PIXI yet, but harmless.
code = code.replace(/^\s*import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '');

// Wrap so any top-level await / errors propagate predictably.
code = `
;(async () => {
  try {
    ${code}
  } catch (e) {
    __setError(e);
  } finally {
    __ready();
  }
})()
.catch(e => __setError(e));
`;

// ── DOM + PIXI stubs ─────────────────────────────────────────────────────
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
  addChild(c)    { this.children.push(c); return c; }
  addChildAt(c)  { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
  removeChildren() { this.children.length = 0; }
  destroy() { this.destroyed = true; }
  on() { return this; }
  off() { return this; }
}
class SpriteStub extends ContainerStub {
  constructor() {
    super();
    this.anchor = { set: noop };
    this.tint = 0xFFFFFF; this.texture = null;
  }
}
class GraphicsStub extends ContainerStub {
  beginFill() { return this; }
  endFill()   { return this; }
  lineStyle() { return this; }
  drawRect()  { return this; }
  drawRoundedRect() { return this; }
  drawCircle() { return this; }
  drawPolygon() { return this; }
  moveTo() { return this; }
  lineTo() { return this; }
  clear() { return this; }
}
class TextStub extends ContainerStub {
  constructor(t) {
    super();
    this.text = t;
    this.anchor = { set: noop };
    this.style = {}; this.width = 0; this.height = 0;
  }
}
const PIXIStub = {
  Assets: { load: async () => ({ width: 400, height: 400, baseTexture: { width: 400, height: 400 } }) },
  Application: class {
    constructor() {
      this.screen = { width: 1024, height: 768 };
      this.stage  = new ContainerStub();
      this.view   = { addEventListener: noop, removeEventListener: noop, style: {}, id: '' };
      this.renderer = { resize: noop };
    }
  },
  Container: ContainerStub,
  Sprite:    SpriteStub,
  Graphics:  GraphicsStub,
  Text:      TextStub,
  Rectangle: class { constructor(x = 0, y = 0, w = 0, h = 0) { this.x = x; this.y = y; this.width = w; this.height = h; } },
  RoundedRectangle: class { constructor(x = 0, y = 0, w = 0, h = 0) { this.x = x; this.y = y; this.width = w; this.height = h; } },
  Circle: class { constructor(x = 0, y = 0, r = 0) { this.x = x; this.y = y; this.radius = r; } },
  Point: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
  Texture: { from: () => ({}) },
};
const gsapStub = new Proxy(() => gsapStub, {
  get: () => gsapStub,
  apply: () => gsapStub,
});

const sandbox = {
  PIXI: PIXIStub,
  gsap: gsapStub,
  console,
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
    querySelector: () => null,
    getElementById: () => ({ remove: noop }),
    fonts: { load: async () => ({}) },
  },
  navigator: { userAgent: 'sim' },
  performance: { now: () => Date.now() },
  // Pin mode via localStorage stub so the engine's load-time mode
  // resolver picks up our requested mode.
  localStorage: {
    getItem: (k) => (k === 'trail_catcher_mode' ? ARG_MODE : null),
    setItem: noop, removeItem: noop,
  },
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
sandbox.innerWidth = 1024;
sandbox.innerHeight = 768;
sandbox.devicePixelRatio = 1;

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(code, ctx, { filename: 'index.html' });
} catch (e) {
  console.error('vm.runInContext threw:', e && (e.stack || e.message || e));
  process.exit(1);
}
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason && (reason.stack || reason.message || reason));
});

const TIMEOUT = 5000;
await Promise.race([
  ready,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`engine init timed out after ${TIMEOUT}ms`)), TIMEOUT)),
]).catch(e => {
  console.error('Engine ready wait failed:', e.message);
  if (_error) console.error('Caught error in IIFE:', _error && (_error.stack || _error.message || _error));
  process.exit(1);
});
if (_error) {
  console.error('Engine init error:', _error && (_error.stack || _error.message || _error));
  process.exit(1);
}

const TrailCatcher = sandbox.window.TrailCatcher;
if (!TrailCatcher) {
  console.error('TrailCatcher not exposed on window — engine likely failed to load');
  process.exit(1);
}

// ── Sim ──────────────────────────────────────────────────────────────────
const N    = parseInt(process.argv[2] || '10000', 10);
const BET  = parseFloat(process.argv[3] || '1');
const SEED = parseInt(process.argv[4] || '42', 10);

TrailCatcher.setRng(TrailCatcher.makeSeededRng(SEED));

console.log(`\nSimulating ${N} spins · bet=${BET} · seed=${SEED} · mode=${ARG_MODE}\n`);
const t0 = Date.now();

// Persistent conveyor state across all spins (token shift carries spin to spin).
const state = { conveyor: [], freeSpinsBank: 0, inFreeSpin: false };

let totalCluster = 0, totalJackpot = 0;
let nWin = 0, nBigWin = 0;
let totalCascades = 0;
let totalClusterCount = 0;          // cluster events across all spins
let cascadeHistogram = [0,0,0,0,0,0,0,0,0,0,0,0]; // 0..11+
const returns = new Float64Array(N);

// Clean separation between base cluster pay and token-induced boost.
// `baseClusterPay`  = sum of basePay × cluster_size (no modifiers at all)
// `actualClusterPay` = sum of cl.pay (what was actually paid)
// boost = actual − base (caused by multiplier/wild/sticky-stamp effects)
let totalBaseCluster = 0;
let totalActualCluster = 0;
let totalMultiplierBoost = 0;       // attributed to multiplier tokens specifically
let totalFreeSpinWin = 0;           // total finalWin during bonus spins
let totalPaidWagered = 0;           // bets only on paid (non-free) spins
// Free-spin / wild boost remainder = actualCluster - baseCluster - multiplierBoost

// Per-token-type tally
const tally = {
  spawned: { multiplier: 0, wild: 0, freespins: 0, tiny: 0, mini: 0, major: 0, grand: 0 },
  fired:   { multiplier: 0, wild: 0, freespins: 0, tiny: 0, mini: 0, major: 0, grand: 0 },
  pay:     { multiplier: 0, wild: 0, freespins: 0, tiny: 0, mini: 0, major: 0, grand: 0 },
};
let droppedCount = 0;
let freeSpinsAwardedTotal = 0, freeSpinsPlayed = 0;

// Track spawn vs fire by snooping the conveyor snapshot events.
const seenTokens = new Set(); // referenced by object identity isn't useful; use a tag

// Quick patch — instrument by counting tokens added to the conveyor each
// spin. We diff conveyor before/after the spawn event.
function snapshotKey(t) { return `${t.type}:${t.pos}:${t.multValue || ''}`; }

let spinIdx = 0;
while (spinIdx < N) {
  const beforeConveyor = state.conveyor.map(snapshotKey);

  // Burn any banked free spins INSIDE this loop iteration so they count
  // toward N. (You could choose to NOT count them as "spins" — easy to flip.)
  if (state.freeSpinsBank > 0) {
    state.inFreeSpin = true;
    state.freeSpinsBank -= 1;
    freeSpinsPlayed += 1;
  } else {
    state.inFreeSpin = false;
  }

  const wasInFreeSpin = state.inFreeSpin;
  if (!wasInFreeSpin) totalPaidWagered += BET;

  const r = TrailCatcher.runSpin(BET, state);
  totalCluster += r.clusterWin;
  totalJackpot += r.jackpotWin;
  returns[spinIdx] = r.finalWin;
  if (r.finalWin > 0)        nWin++;
  if (r.finalWin >= 10 * BET) nBigWin++;
  if (wasInFreeSpin) totalFreeSpinWin += r.finalWin;

  // Cascade + cluster counts AND base/actual cluster-pay split.
  // For each cluster event, we have cl.basePay (no token effects) and
  // cl.pay (with all stamps + cascade multiplier). Diff = boost from
  // tokens. Attribute the multiplier portion separately by walking
  // intercepts in cascade order.
  let casThisSpin = 0;
  // Track multipliers fired BEFORE each cascade resolves so we know
  // how much of each cluster's boost is multiplier-attributable.
  // Engine fires all this-cascade multipliers BEFORE paying clusters,
  // so the boost = baseClusterPay × (cascadeMultiplier − 1)
  // attributable to multiplier tokens fired this cascade.
  const cascadeMultByIdx = {};
  for (const ev of r.events) {
    if (ev.type === 'clusters') {
      const idx = ev.cascadeIndex;
      cascadeMultByIdx[idx] = ev.cascadeMultiplier || 1;
      casThisSpin += 1;
      totalClusterCount += ev.clusters.length;
      for (const cl of ev.clusters) {
        totalBaseCluster   += cl.basePay * BET;
        totalActualCluster += cl.pay     * BET;
      }
    }
  }
  totalCascades += casThisSpin;
  cascadeHistogram[Math.min(casThisSpin, cascadeHistogram.length - 1)] += 1;

  // Detect newly-spawned token by comparing pre-spin conveyor (before
  // the spin's spawn) to the conveyor seen in the conveyorSnapshot event.
  // Simpler: compare beforeConveyor (PRE-spawn) to the snapshot taken
  // right after spawn (events[0]).
  const snapEv = r.events.find(e => e.type === 'conveyorSnapshot');
  if (snapEv) {
    const after = snapEv.tokens.map(snapshotKey);
    const beforeSet = new Set(beforeConveyor);
    for (const k of after) {
      if (!beforeSet.has(k)) {
        const type = k.split(':')[0];
        if (tally.spawned[type] != null) tally.spawned[type] += 1;
      }
      // Token may also have shifted+matched; this is approximate.
    }
  }

  // Tally fired tokens + per-token pay attribution.
  // For multipliers: contribution = sum over (fires this cascade) of
  //   (M / cascadeMult) × baseClusterPay_this_cascade × (cascadeMult − 1)
  // which fairly distributes the cluster's boost among the multipliers
  // that contributed to that cascade. For tier jackpots: direct flat pay.
  // For wilds and free spins: attribution is INDIRECT and computed
  // outside this loop (free-spin total tracked above; wild boost lives
  // in the modifier-boost remainder).
  for (const ic of r.intercepts) {
    const type = ic.token.type;
    if (tally.fired[type] != null) tally.fired[type] += 1;
    if (ic.fired && ic.fired.type === 'jackpot') {
      tally.pay[type] += ic.fired.payBet * BET;
    } else if (ic.fired && ic.fired.type === 'multiplier') {
      // Find this cascade's total multiplier and base cluster pay.
      const idx = ic.cascade;
      const cascadeMult = cascadeMultByIdx[idx] || 1;
      const ev = r.events.find(e => e.type === 'clusters' && e.cascadeIndex === idx);
      const baseThisCas = ev ? ev.clusters.reduce((s, cl) => s + cl.basePay, 0) : 0;
      // Multiplier's share of the boost: M out of cascadeMult, applied
      // to baseClusterPay × (cascadeMult − 1) total boost.
      if (cascadeMult > 1) {
        const share = ic.fired.value / cascadeMult;
        const boost = baseThisCas * (cascadeMult - 1);
        const attributed = share * boost * BET;
        tally.pay[type] += attributed;
        totalMultiplierBoost += attributed;
      }
    }
    // Wild: contribution sits in remainder (actualCluster − base − multBoost).
    // Free spins: handled by totalFreeSpinWin (all wins during bonus rounds).
  }
  freeSpinsAwardedTotal += r.freeSpinsAwarded;
  droppedCount += r.droppedTokens.length;

  spinIdx += 1;
}

const dt = Date.now() - t0;
// Use PAID wagered as the RTP denominator (free spins aren't a wager).
const denom = Math.max(totalPaidWagered, 1e-9);

let m2 = 0, mn = +Infinity, mx = -Infinity;
const meanRet = (totalCluster + totalJackpot) / N;
for (let i = 0; i < N; i++) {
  const d = returns[i] - meanRet;
  m2 += d * d;
  if (returns[i] < mn) mn = returns[i];
  if (returns[i] > mx) mx = returns[i];
}
const stddev = Math.sqrt(m2 / N);
const sorted = Array.from(returns).sort((a, b) => a - b);
const pct = p => sorted[Math.min(N - 1, Math.floor(p * N))];

// Decompose total RTP into clean buckets:
//   base cluster pay  (no token effects)
//   multiplier boost  (attributable to multiplier tokens)
//   wild + sticky     (residual cluster boost not from multipliers)
//   free-spin wins    (everything paid during bonus rounds)
//   tier jackpots     (direct, per tier)
//
// totalActualCluster INCLUDES bonus-round cluster pay. To avoid
// double-counting we report free-spin total separately and remove its
// share from the cluster buckets.
const baseClusterRtp     = (totalBaseCluster) / denom;
const multBoostRtp       = (totalMultiplierBoost) / denom;
const wildPlusStampRtp   = (totalActualCluster - totalBaseCluster - totalMultiplierBoost) / denom;
const freeSpinRtp        = totalFreeSpinWin / denom;
const tinyRtp  = tally.pay.tiny  / denom;
const miniRtp  = tally.pay.mini  / denom;
const majorRtp = tally.pay.major / denom;
const grandRtp = tally.pay.grand / denom;
const totalRtp = (totalCluster + totalJackpot) / denom;

console.log(`Done in ${dt}ms · ${(N / (dt / 1000)).toFixed(0)} spins/sec\n`);

console.log(`── RTP (paid wagered = ${totalPaidWagered.toFixed(0)}× bet, free spins excluded) ──`);
console.log(`  Total RTP                : ${(totalRtp * 100).toFixed(2)}%`);
console.log(`    base cluster pay       : ${(baseClusterRtp   * 100).toFixed(2)}%`);
console.log(`    multiplier boost       : ${(multBoostRtp     * 100).toFixed(2)}%`);
console.log(`    wild + sticky stamp    : ${(wildPlusStampRtp * 100).toFixed(2)}%   (residual)`);
console.log(`    free-spin total*       : ${(freeSpinRtp      * 100).toFixed(2)}%   (* overlaps the rows above — bonus-round wins)`);
console.log(`    Tiny  jackpots         : ${(tinyRtp  * 100).toFixed(2)}%`);
console.log(`    Mini  jackpots         : ${(miniRtp  * 100).toFixed(2)}%`);
console.log(`    Major jackpots         : ${(majorRtp * 100).toFixed(2)}%`);
console.log(`    Grand jackpots         : ${(grandRtp * 100).toFixed(2)}%`);
console.log(`  Std deviation            : ${stddev.toFixed(2)}× bet`);
console.log(`  σ / mean                 : ${(stddev / Math.max(meanRet, 1e-9)).toFixed(2)}`);
console.log(`  Min / Max                : ${mn.toFixed(2)} / ${mx.toFixed(2)}× bet`);

console.log(`\n── Hit rates ──`);
console.log(`  Dead spins (0)   : ${((1 - nWin / N) * 100).toFixed(2)}%`);
console.log(`  Any win > 0      : ${(nWin    / N * 100).toFixed(2)}%`);
console.log(`  Big win ≥ 10×    : ${(nBigWin / N * 100).toFixed(2)}%`);

console.log(`\n── Cascades ──`);
console.log(`  Avg cascades/spin   : ${(totalCascades / N).toFixed(2)}`);
console.log(`  Avg clusters/cascade: ${(totalClusterCount / Math.max(totalCascades, 1)).toFixed(2)}`);
for (let n = 0; n < cascadeHistogram.length; n++) {
  const pp = cascadeHistogram[n] / N * 100;
  if (pp < 0.005) continue;
  const label = (n === cascadeHistogram.length - 1) ? `${n}+` : `${n} `;
  console.log(`    ${label.padStart(3)} cascades : ${pp.toFixed(2)}%`);
}

console.log(`\n── Token table ──`);
console.log(`  ${'type'.padEnd(11)} ${'spawned'.padStart(8)} ${'fired'.padStart(8)} ${'hit %'.padStart(7)} ${'avg pay × bet'.padStart(14)} ${'RTP %'.padStart(8)}`);
const TYPES = ['multiplier','wild','freespins','tiny','mini','major','grand'];
const totalPayoutByType = { ...tally.pay };
// freespins attribution = freespin-round wins, distributed to fires.
totalPayoutByType.freespins = totalFreeSpinWin;
// wild attribution = residual cluster boost not from multipliers.
totalPayoutByType.wild = (totalActualCluster - totalBaseCluster - totalMultiplierBoost);
for (const t of TYPES) {
  const sp = tally.spawned[t], fi = tally.fired[t];
  const rate = sp > 0 ? (fi / sp * 100).toFixed(1) + '%' : '-';
  const totalPay = totalPayoutByType[t];
  const avgPay = fi > 0 ? (totalPay / fi).toFixed(2) + '×' : '-';
  const rtp = (totalPay / denom * 100).toFixed(2) + '%';
  console.log(`  ${t.padEnd(11)} ${sp.toString().padStart(8)} ${fi.toString().padStart(8)} ${rate.padStart(7)} ${avgPay.padStart(14)} ${rtp.padStart(8)}`);
}
console.log(`  dropped (off-edge): ${droppedCount}`);
console.log(`  free spins awarded: ${freeSpinsAwardedTotal}, played: ${freeSpinsPlayed}`);

console.log(`\n── Per-spin percentiles (× bet) ──`);
console.log(`   1% : ${pct(0.01).toFixed(2).padStart(8)}    25% : ${pct(0.25).toFixed(2).padStart(8)}    75% : ${pct(0.75).toFixed(2).padStart(8)}    99% : ${pct(0.99).toFixed(2).padStart(8)}`);
console.log(`   5% : ${pct(0.05).toFixed(2).padStart(8)}    50% : ${pct(0.50).toFixed(2).padStart(8)}    95% : ${pct(0.95).toFixed(2).padStart(8)}   99.9%: ${pct(0.999).toFixed(2).padStart(8)}`);

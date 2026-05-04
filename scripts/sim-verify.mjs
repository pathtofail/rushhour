#!/usr/bin/env node
// Independent RTP cross-check. Loads the live engine from index.html the
// same way scripts/sim.mjs does, but counts ONLY:
//   - total wagered (bet × paid spins, free spins excluded)
//   - total paid out (sum of result.finalWin)
//   - dead-spin count (finalWin === 0)
//
// No per-token attribution, no cluster/jackpot decomposition. If this and
// scripts/sim.mjs agree on Total RTP and Dead-spin %, the original sim's
// math is honest.
//
// CLI: `node scripts/sim-verify.mjs [spins=100000] [bet=1] [seed=42]`

import fs from 'node:fs';
import vm from 'node:vm';

const HTML = fs.readFileSync('index.html', 'utf8');
const blocks = [...HTML.matchAll(/<script(?:\s+type=["']module["'])?[^>]*>([\s\S]*?)<\/script>/g)];
let code = blocks.map(b => b[1]).join('\n;\n');
code = code.replace(/^\s*import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '');
code = `;(async () => { try { ${code} } catch (e) { __setError(e); } finally { __ready(); } })();`;

const noop = () => {};
let _ready, _error = null;
const ready = new Promise(r => { _ready = r; });

class ContainerStub {
  constructor() {
    this.children = []; this.x = 0; this.y = 0;
    this.scale = { x: 1, y: 1, set(a,b){this.x=a;this.y=b??a;} };
    this.position = { set: noop };
    this.alpha = 1; this.visible = true; this.rotation = 0;
    this.eventMode = 'none'; this.cursor = 'default';
    this.sortableChildren = false;
  }
  addChild(c){this.children.push(c);return c;}
  addChildAt(c){this.children.push(c);return c;}
  removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);}
  removeChildren(){this.children.length=0;}
  destroy(){this.destroyed=true;}
  on(){return this;} off(){return this;}
}
class SpriteStub extends ContainerStub {
  constructor() { super(); this.anchor = { set: noop }; this.tint = 0xFFFFFF; this.texture = null; }
}
class GraphicsStub extends ContainerStub {
  beginFill(){return this;} endFill(){return this;} lineStyle(){return this;}
  drawRect(){return this;} drawRoundedRect(){return this;} drawCircle(){return this;}
  drawPolygon(){return this;} moveTo(){return this;} lineTo(){return this;} clear(){return this;}
}
class TextStub extends ContainerStub {
  constructor(t) { super(); this.text = t; this.anchor = { set: noop }; this.style = {}; this.width = 0; this.height = 0; }
}
const PIXIstub = {
  Container: ContainerStub, Sprite: SpriteStub, Graphics: GraphicsStub, Text: TextStub,
  Rectangle: class { constructor(x=0,y=0,w=0,h=0){this.x=x;this.y=y;this.width=w;this.height=h;} },
  RoundedRectangle: class { constructor(x=0,y=0,w=0,h=0){this.x=x;this.y=y;this.width=w;this.height=h;} },
  Circle: class { constructor(x=0,y=0,r=0){this.x=x;this.y=y;this.radius=r;} },
  Point: class { constructor(x=0,y=0){this.x=x;this.y=y;} },
  Application: class { constructor(){this.stage=new ContainerStub();this.screen={width:1024,height:768};this.view={addEventListener:noop,removeEventListener:noop,style:{},id:''};this.renderer={resize:noop};} },
  Assets: { load: async () => ({ width: 400, height: 400, baseTexture:{width:400,height:400} }) },
  Texture: { from: () => ({}) },
};
const gsapStub = new Proxy(()=>gsapStub, {
  get: () => gsapStub,
  apply: () => ({ kill: noop, then: (cb) => cb && cb() }),
});

const sandbox = {
  PIXI: PIXIstub, gsap: gsapStub,
  console, Math, Date, JSON, Promise, Array, Object, Number, String, Boolean,
  Symbol, Map, Set, WeakMap, WeakSet, Float64Array, Int32Array, Uint8Array, RegExp, Error, TypeError,
  setTimeout: (cb) => { try { cb(); } catch(_) {} return 0; },
  clearTimeout: noop, setInterval: noop, clearInterval: noop, queueMicrotask: noop,
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
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
sandbox.requestAnimationFrame = noop;
sandbox.addEventListener = noop; sandbox.removeEventListener = noop;
sandbox.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
sandbox.innerWidth = 1024; sandbox.innerHeight = 768; sandbox.devicePixelRatio = 1;

const ctx = vm.createContext(sandbox);
try { vm.runInContext(code, ctx, { filename: 'index.html' }); }
catch (e) { console.error('vm threw:', e && (e.stack || e.message)); process.exit(1); }

await Promise.race([
  ready,
  new Promise((_, rej) => setTimeout(() => rej(new Error('engine init timeout')), 5000)),
]).catch(e => {
  console.error('Engine ready failed:', e.message);
  if (_error) console.error('IIFE error:', _error && (_error.stack || _error.message));
  process.exit(1);
});
if (_error) { console.error('Engine init error:', _error && (_error.stack || _error.message)); process.exit(1); }

const PP = sandbox.window.TrailCatcher;
if (!PP) { console.error('TrailCatcher not exposed'); process.exit(1); }

const N    = parseInt(process.argv[2] || '100000', 10);
const BET  = parseFloat(process.argv[3] || '1');
const SEED = parseInt(process.argv[4] || '42', 10);

PP.setRng(PP.makeSeededRng(SEED));

console.log(`Cross-check sim · ${N} spins · bet=${BET} · seed=${SEED}\n`);
const state = { conveyor: [], freeSpinsBank: 0, inFreeSpin: false };

let wagered = 0, paidOut = 0, dead = 0, paidSpins = 0;
const t0 = Date.now();

for (let i = 0; i < N; i++) {
  let isFree = false;
  if (state.freeSpinsBank > 0) {
    state.inFreeSpin = true; state.freeSpinsBank -= 1; isFree = true;
  } else {
    state.inFreeSpin = false;
  }
  if (!isFree) { wagered += BET; paidSpins += 1; }
  const r = PP.runSpin(BET, state);
  paidOut += r.finalWin || 0;
  if ((r.finalWin || 0) === 0) dead += 1;
}

const dtMs = Date.now() - t0;
console.log(`Done in ${dtMs}ms · ${(N / (dtMs / 1000)).toFixed(0)} spins/sec\n`);
console.log(`paidWagered (bet × paid spins, free spins excluded): ${wagered.toFixed(2)}`);
console.log(`totalPayout (sum of finalWin)                       : ${paidOut.toFixed(2)}`);
console.log(`Total RTP   = totalPayout / paidWagered             : ${(paidOut / wagered * 100).toFixed(2)}%`);
console.log(`Dead spins  = ${(dead / N * 100).toFixed(2)}% (${dead} of ${N})`);
console.log(`Hit rate    = ${(100 - dead / N * 100).toFixed(2)}%`);

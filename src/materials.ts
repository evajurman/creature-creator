import * as THREE from 'three';

export type StyleId = 'clay' | 'felt' | 'lowpoly' | 'plastic' | 'toon' | 'glass' | 'patchwork' | 'knit' | 'metal';

export const STYLES: { id: StyleId; name: string; desc: string }[] = [
  { id: 'clay', name: 'Clay', desc: 'Hand-moulded, fingerprinted' },
  { id: 'felt', name: 'Felt', desc: 'Needle-felted wool' },
  { id: 'lowpoly', name: 'Low-poly', desc: 'Chunky flat facets' },
  { id: 'plastic', name: 'Toy', desc: 'Glossy vinyl toy' },
  { id: 'toon', name: 'Toon', desc: 'Cel-shaded with ink lines' },
  { id: 'glass', name: 'Glass', desc: 'Clear or frosted, refracts' },
  { id: 'patchwork', name: 'Patchwork', desc: 'Stitched fabric patches' },
  { id: 'knit', name: 'Knitted', desc: 'Cosy knitted yarn' },
  { id: 'metal', name: 'Metal', desc: 'Polished, hammered or rusty' },
];

/** Materials whose textures are laid out on the creature's rest pose. */
export function isTextured(style: StyleId) {
  return style === 'clay' || style === 'felt' || style === 'patchwork' || style === 'knit' || style === 'metal';
}

/** A per-material slider. `geometry` ones change the mesh itself, not just the shader. */
export interface StyleParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  geometry?: boolean;
}

export const STYLE_PARAMS: Record<StyleId, StyleParam[]> = {
  clay: [
    { key: 'prints', label: 'Fingerprints', min: 0, max: 14, step: 0.1, value: 6 },
    { key: 'lumps', label: 'Lumpiness', min: 0, max: 3, step: 0.05, value: 1, geometry: true },
    { key: 'wax', label: 'Waxy sheen', min: 0, max: 1, step: 0.01, value: 0.35 },
    { key: 'matte', label: 'Matte', min: 0.25, max: 1, step: 0.01, value: 0.62 },
  ],
  felt: [
    { key: 'fuzz', label: 'Fuzz length', min: 0, max: 0.06, step: 0.001, value: 0.022 },
    { key: 'density', label: 'Fuzz density', min: 0, max: 1, step: 0.01, value: 0.5 },
    { key: 'hairs', label: 'Stray hairs', min: 0, max: 3, step: 0.05, value: 1 },
    { key: 'glow', label: 'Edge glow', min: 0, max: 1.5, step: 0.01, value: 0.55 },
  ],
  lowpoly: [
    { key: 'facets', label: 'Facet size', min: 0.4, max: 2.5, step: 0.05, value: 1, geometry: true },
    { key: 'variation', label: 'Color variation', min: 0, max: 0.5, step: 0.01, value: 0.14, geometry: true },
    { key: 'matte', label: 'Matte', min: 0.05, max: 1, step: 0.01, value: 0.85 },
  ],
  plastic: [
    { key: 'shine', label: 'Shininess', min: 0, max: 1, step: 0.01, value: 0.7 },
    { key: 'coat', label: 'Clear coat', min: 0, max: 1, step: 0.01, value: 1 },
    { key: 'metal', label: 'Metallic', min: 0, max: 1, step: 0.01, value: 0 },
  ],
  glass: [
    { key: 'clarity', label: 'Clarity', min: 0, max: 1, step: 0.01, value: 0.97 },
    { key: 'tint', label: 'Tint strength', min: 0, max: 1, step: 0.01, value: 0.7 },
    { key: 'thick', label: 'Thickness', min: 0, max: 1, step: 0.01, value: 0.08 },
    { key: 'ior', label: 'Refraction', min: 1, max: 2.2, step: 0.01, value: 1.45 },
  ],
  patchwork: [
    { key: 'size', label: 'Patch size', min: 0.3, max: 6, step: 0.05, value: 1 },
    { key: 'variety', label: 'Color variety', min: 0, max: 1, step: 0.01, value: 0.7 },
    { key: 'prints', label: 'Prints', min: 0, max: 1, step: 0.01, value: 0.6 },
    { key: 'stitches', label: 'Stitching', min: 0, max: 1, step: 0.01, value: 0.8 },
    { key: 'puff', label: 'Quilting', min: 0, max: 3, step: 0.05, value: 1 },
  ],
  knit: [
    { key: 'size', label: 'Stitch size', min: 0.3, max: 4, step: 0.05, value: 1 },
    { key: 'puff', label: 'Yarn depth', min: 0, max: 3, step: 0.05, value: 1 },
    { key: 'stripes', label: 'Stripes', min: 0, max: 1, step: 0.01, value: 0 },
    { key: 'fluff', label: 'Fluffiness', min: 0, max: 1.5, step: 0.01, value: 0.45 },
  ],
  metal: [
    { key: 'polish', label: 'Polish', min: 0, max: 1, step: 0.01, value: 0.75 },
    { key: 'hammer', label: 'Hammered', min: 0, max: 1, step: 0.01, value: 0 },
    { key: 'brush', label: 'Brushed', min: 0, max: 1, step: 0.01, value: 0 },
    { key: 'patina', label: 'Patina', min: 0, max: 1, step: 0.01, value: 0 },
    { key: 'tone', label: 'Rust → verdigris', min: 0, max: 1, step: 0.01, value: 0 },
  ],
  toon: [
    { key: 'ink', label: 'Ink width', min: 0, max: 0.04, step: 0.001, value: 0.012 },
    { key: 'bands', label: 'Shade steps', min: 2, max: 6, step: 1, value: 3 },
    { key: 'shadow', label: 'Shadow depth', min: 0, max: 0.95, step: 0.01, value: 0.55 },
  ],
};

export type StyleSettings = Record<string, number>;

/** Felt fuzz is also on this layer, so it can be drawn on its own after ambient occlusion. */
export const FUR_LAYER = 1;

let glassEnv: THREE.Texture | null = null;
/** The reflection environment glass uses (set once by the app). */
export function setGlassEnvironment(tex: THREE.Texture) {
  glassEnv = tex;
}

/** Defaults for a style, with any saved overrides applied. */
export function styleSettings(style: StyleId, overrides?: StyleSettings): StyleSettings {
  const out: StyleSettings = {};
  for (const p of STYLE_PARAMS[style]) out[p.key] = overrides?.[p.key] ?? p.value;
  return out;
}

// ---------------------------------------------------------------------------
// Procedural, seamlessly tiling height fields

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable fractal value noise, values roughly 0..1. */
function tileNoise(size: number, baseFreq: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  const r = rng(seed);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const f = baseFreq << o;
    const grid = new Float32Array(f * f).map(() => r());
    const g = (i: number, j: number) => grid[(j % f) * f + (i % f)];
    for (let y = 0; y < size; y++) {
      const gy = (y / size) * f;
      const y0 = Math.floor(gy), ty = gy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * f;
        const x0 = Math.floor(gx), tx = gx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
        const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
        out[y * size + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function toGrayTexture(size: number, values: Float32Array, srgb = false): THREE.CanvasTexture {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < values.length; i++) {
    const v = ((values[i] - lo) / (hi - lo || 1)) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return wrapTexture(c, srgb);
}

function wrapTexture(c: HTMLCanvasElement, srgb = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Add `fn(dx, dy)` over a disc of radius r around (cx, cy), wrapping at edges. */
function stamp(buf: Float32Array, size: number, cx: number, cy: number, r: number, fn: (dx: number, dy: number) => number) {
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) {
    const wy = ((y % size) + size) % size;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const wx = ((x % size) + size) % size;
      buf[wy * size + wx] += fn(dx, dy);
    }
  }
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

let clayBump: THREE.Texture | null = null;
/** Clay: soft lumps, fingerprint whorls pressed into the surface, and tool drags. */
function getClayBump(): THREE.Texture {
  if (clayBump) return clayBump;
  const size = 1024;
  const r = rng(99);
  const lumps = tileNoise(size, 3, 5, 7);
  const warp = tileNoise(size, 12, 3, 21);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = lumps[i] * 0.9;

  // fingerprints: a shallow thumb dent carrying fine elliptical ridges
  for (let i = 0; i < 18; i++) {
    const cx = r() * size, cy = r() * size;
    const R = 80 + r() * 50;
    const ang = r() * Math.PI;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const aspect = 0.62 + r() * 0.2;
    const period = 6.5 + r() * 1.5;
    const loopShift = (r() - 0.5) * 0.8; // offsets the core so it reads as a loop, not a target
    const depth = 0.1 + r() * 0.1;
    const ridge = 0.07 + r() * 0.04;
    stamp(h, size, cx, cy, R, (dx, dy) => {
      const u = (dx * ca + dy * sa) / R;
      const v = (-dx * sa + dy * ca) / R / aspect;
      const d = Math.hypot(u, v);
      const fall = 1 - smooth(0.3, 1.0, d);
      if (fall <= 0) return 0;
      const wx = ((Math.round(cx + dx) % size) + size) % size;
      const wy = ((Math.round(cy + dy) % size) + size) % size;
      const wv = warp[wy * size + wx];
      const core = Math.hypot(u, v - loopShift * (1 - Math.abs(u)));
      const rings = Math.sin(((core * R) / period + wv * 3.5) * Math.PI * 2);
      return -depth * fall * fall + ridge * rings * fall;
    });
  }

  // sculpting-tool drags: parallel grooves along a short stroke
  for (let i = 0; i < 14; i++) {
    const cx = r() * size, cy = r() * size;
    const len = 60 + r() * 120;
    const w = 10 + r() * 10;
    const ang = r() * Math.PI;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    stamp(h, size, cx, cy, len, (dx, dy) => {
      const along = (dx * ca + dy * sa) / len;
      const across = (-dx * sa + dy * ca) / w;
      if (Math.abs(across) > 1) return 0;
      const f = (1 - smooth(0.6, 1, Math.abs(along))) * (1 - smooth(0.5, 1, Math.abs(across)));
      return f * (0.08 * Math.sin(across * w * 1.4) - 0.08);
    });
  }

  // grit
  for (let i = 0; i < h.length; i++) h[i] += (r() - 0.5) * 0.035;
  clayBump = toGrayTexture(size, h);
  return clayBump;
}

/** Several 0..1 fields as the channels of one texture (unscaled, so their strengths stay comparable). */
function channelTexture(size: number, r: Float32Array, g?: Float32Array, b?: Float32Array): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < size * size; i++) {
    img.data[i * 4] = to(r[i]);
    img.data[i * 4 + 1] = to(g ? g[i] : 0);
    img.data[i * 4 + 2] = to(b ? b[i] : 0);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return wrapTexture(c);
}

/** Stretch a field to fill 0..1. */
function normalize01(v: Float32Array): Float32Array {
  let lo = Infinity, hi = -Infinity;
  for (const x of v) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  for (let i = 0; i < v.length; i++) v[i] = (v[i] - lo) / (hi - lo || 1);
  return v;
}

let metalTex: { bump: THREE.Texture; patina: THREE.Texture } | null = null;
/**
 * Metal: a bump texture holding hammer dents (R) and brushed streaks (G), and
 * a patina texture holding where tarnish creeps in first (R) and its mottling (G).
 */
function getMetalTex() {
  if (metalTex) return metalTex;
  const size = 1024;
  const r = rng(53);

  // hammered: overlapping shallow round dents, meeting in soft ridges
  const dents = new Float32Array(size * size);
  for (let i = 0; i < 560; i++) {
    const cx = r() * size, cy = r() * size;
    const R = 20 + r() * 30;
    const depth = 0.6 + r() * 0.4;
    const x0 = Math.floor(cx - R), x1 = Math.ceil(cx + R), y0 = Math.floor(cy - R), y1 = Math.ceil(cy + R);
    for (let y = y0; y <= y1; y++) {
      const wy = ((y % size) + size) % size;
      for (let x = x0; x <= x1; x++) {
        const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (R * R);
        if (d2 > 1) continue;
        const wx = ((x % size) + size) % size;
        const k = wy * size + wx;
        dents[k] = Math.min(dents[k], -(1 - d2) * depth);
      }
    }
  }
  for (let i = 0; i < dents.length; i++) dents[i] = 1 + dents[i];

  // brushed: fine streaks along one direction, each fading in and out along its length
  const rows = Float32Array.from({ length: size }, () => r());
  // the odd deeper scratch
  for (let i = 0; i < 24; i++) rows[Math.floor(r() * size)] = r() < 0.5 ? 0 : 1;
  const fade = tileNoise(size, 6, 3, 61);
  const streaks = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = (rows[y] + rows[(y + 1) % size] * 0.5) / 1.5;
    for (let x = 0; x < size; x++) streaks[y * size + x] = 0.5 + (v - 0.5) * (0.4 + 0.6 * fade[y * size + x]);
  }

  // patina: big blotches (where it starts) and fine mottling inside them
  const where = normalize01(tileNoise(size, 4, 6, 67));
  const mottle = normalize01(tileNoise(size, 28, 3, 71));
  metalTex = { bump: channelTexture(size, dents, streaks), patina: channelTexture(size, where, mottle) };
  return metalTex;
}

let feltTex: { map: THREE.Texture; bump: THREE.Texture; hair: THREE.Texture } | null = null;

/** Draw one curly wool fibre (a wandering, spiralling stroke), wrapped for tiling. */
function curl(ctx: CanvasRenderingContext2D, size: number, r: () => number, len: number, turn: number) {
  const pts: [number, number][] = [];
  let x = r() * size, y = r() * size;
  let a = r() * Math.PI * 2;
  let da = (r() - 0.5) * turn;
  const steps = Math.max(4, Math.round(len / 2));
  for (let i = 0; i <= steps; i++) {
    pts.push([x, y]);
    x += Math.cos(a) * (len / steps);
    y += Math.sin(a) * (len / steps);
    a += da;
    da += (r() - 0.5) * turn * 0.5; // curliness wanders along the fibre
  }
  for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px + dx, py + dy) : ctx.moveTo(px + dx, py + dy)));
    ctx.stroke();
  }
}

function getFelt() {
  if (feltTex) return feltTex;
  const size = 512;
  const r = rng(5);

  // matted wool surface (bump): soft clumps under a mat of curly fibres
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const base = tileNoise(size, 12, 4, 3);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < base.length; i++) {
    const v = 110 + base[i] * 40;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineCap = ctx.lineJoin = 'round';
  for (let i = 0; i < 5000; i++) {
    const light = r() < 0.55;
    ctx.strokeStyle = light ? `rgba(255,255,255,${0.12 + r() * 0.2})` : `rgba(0,0,0,${0.1 + r() * 0.15})`;
    ctx.lineWidth = 0.6 + r() * 0.8;
    curl(ctx, size, r, 10 + r() * 30, 0.9);
  }
  const bump = wrapTexture(c);

  // color map: near-white so it only tints, with warm and cool fibres mixed
  // in the way dyed wool roving blends (an orange beak shows reds and yellows)
  const cm = document.createElement('canvas');
  cm.width = cm.height = size;
  const mctx = cm.getContext('2d')!;
  mctx.fillStyle = '#f4f4f4';
  mctx.fillRect(0, 0, size, size);
  mctx.globalAlpha = 0.3;
  mctx.drawImage(c, 0, 0);
  mctx.globalAlpha = 1;
  mctx.lineCap = mctx.lineJoin = 'round';
  const tints = ['255,214,150', '255,170,150', '200,225,255', '255,250,200', '220,255,200'];
  for (let i = 0; i < 1800; i++) {
    mctx.strokeStyle = `rgba(${tints[Math.floor(r() * tints.length)]},${0.25 + r() * 0.35})`;
    mctx.lineWidth = 0.8 + r() * 1.2;
    curl(mctx, size, r, 12 + r() * 30, 0.8);
  }
  const map = wrapTexture(cm, true);

  // fibre field for the fuzz shells: R = how far the fibre stands up, G = tint
  const hs = 512;
  const hc = document.createElement('canvas');
  hc.width = hc.height = hs;
  const hctx = hc.getContext('2d')!;
  hctx.fillStyle = '#000';
  hctx.fillRect(0, 0, hs, hs);
  hctx.lineCap = hctx.lineJoin = 'round';
  for (let i = 0; i < 4200; i++) {
    const height = Math.floor(60 + Math.pow(r(), 0.7) * 195);
    const tint = Math.floor(r() * 255);
    hctx.strokeStyle = `rgb(${height},${tint},0)`;
    hctx.lineWidth = 0.9 + r() * 0.9;
    curl(hctx, hs, r, 14 + r() * 36, 1.1);
  }
  const hair = wrapTexture(hc);
  feltTex = { map, bump, hair };
  return feltTex;
}

// Patchwork: fabric patches sewn together. The color map is a "gain" around
// mid-grey (doubled in the shader), so patches are lighter, darker and
// warmer or cooler versions of the part's own color, and blending colors
// between parts still works. The bump map puffs each patch up like a quilt
// and sinks the seams.
const patchworkTex = new Map<string, { map: THREE.Texture; bump: THREE.Texture }>();

function getPatchwork(variety: number, prints: number, stitches: number) {
  const key = [variety, prints, stitches].map((v) => v.toFixed(2)).join();
  const hit = patchworkTex.get(key);
  if (hit) return hit;
  if (patchworkTex.size > 12) patchworkTex.clear();
  const size = 1024;
  const cells = 4;
  const cs = size / cells;
  const r = rng(31);
  const mapC = document.createElement('canvas');
  const bumpC = document.createElement('canvas');
  mapC.width = mapC.height = bumpC.width = bumpC.height = size;
  const m = mapC.getContext('2d')!;
  const b = bumpC.getContext('2d')!;
  m.fillStyle = 'rgb(128,128,128)';
  m.fillRect(0, 0, size, size);
  b.fillStyle = 'rgb(100,100,100)';
  b.fillRect(0, 0, size, size);
  // a color gain (1 = the part's own color) as canvas rgb
  const rgb = (g: number[], a = 1) => `rgba(${g.map((v) => Math.round(Math.min(2, Math.max(0, v)) * 127.5)).join(',')},${a})`;

  // cut the grid into patches: whole squares, triangles, halves, quarters
  type Poly = [number, number][];
  const patches: Poly[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x0 = i * cs, y0 = j * cs, x1 = x0 + cs, y1 = y0 + cs;
      const xm = x0 + cs / 2, ym = y0 + cs / 2;
      const t = r();
      if (t < 0.4) patches.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
      else if (t < 0.6) {
        if (r() < 0.5) patches.push([[x0, y0], [x1, y0], [x1, y1]], [[x0, y0], [x1, y1], [x0, y1]]);
        else patches.push([[x0, y0], [x1, y0], [x0, y1]], [[x1, y0], [x1, y1], [x0, y1]]);
      } else if (t < 0.8) {
        if (r() < 0.5) patches.push([[x0, y0], [x1, y0], [x1, ym], [x0, ym]], [[x0, ym], [x1, ym], [x1, y1], [x0, y1]]);
        else patches.push([[x0, y0], [xm, y0], [xm, y1], [x0, y1]], [[xm, y0], [x1, y0], [x1, y1], [xm, y1]]);
      } else {
        for (const [ax, ay] of [[x0, y0], [xm, y0], [x0, ym], [xm, ym]]) patches.push([[ax, ay], [ax + cs / 2, ay], [ax + cs / 2, ay + cs / 2], [ax, ay + cs / 2]]);
      }
    }
  }
  const path = (ctx: CanvasRenderingContext2D, p: Poly) => {
    ctx.beginPath();
    p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  };

  for (const p of patches) {
    // the fabric: lighter or darker, and nudged warmer or cooler
    const bright = 1 + (r() - 0.5) * 0.75 * variety;
    const fabric = [0, 1, 2].map(() => bright * (1 + (r() - 0.5) * 0.55 * variety));
    m.save();
    path(m, p);
    m.clip();
    m.fillStyle = rgb(fabric);
    m.fillRect(0, 0, size, size);
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
    if (r() < prints) {
      // a print in a lighter or darker shade (or cream) of the fabric
      const ink = r() < 0.3 ? [1.75, 1.7, 1.55] : fabric.map((v) => v * (r() < 0.5 ? 0.62 : 1.4));
      m.fillStyle = m.strokeStyle = rgb(ink, 0.85);
      const kind = Math.floor(r() * 4);
      if (kind === 0) {
        // polka dots
        const step = 16 + r() * 18, rad = step * (0.15 + r() * 0.15);
        for (let y = by; y < by + bh + step; y += step) {
          for (let x = bx + ((y - by) / step) % 2 * step / 2; x < bx + bw + step; x += step) {
            m.beginPath();
            m.arc(x, y, rad, 0, Math.PI * 2);
            m.fill();
          }
        }
      } else if (kind === 1) {
        // stripes, straight or slanted
        const step = 10 + r() * 18;
        m.lineWidth = step * (0.25 + r() * 0.3);
        const ang = [0, Math.PI / 2, Math.PI / 4][Math.floor(r() * 3)];
        const cx = bx + bw / 2, cy = by + bh / 2, reach = Math.hypot(bw, bh);
        for (let o = -reach; o < reach; o += step) {
          m.beginPath();
          m.moveTo(cx + Math.cos(ang) * o - Math.sin(ang) * reach, cy + Math.sin(ang) * o + Math.cos(ang) * reach);
          m.lineTo(cx + Math.cos(ang) * o + Math.sin(ang) * reach, cy + Math.sin(ang) * o - Math.cos(ang) * reach);
          m.stroke();
        }
      } else if (kind === 2) {
        // gingham: see-through bands both ways, darker where they cross
        const step = 14 + r() * 14;
        m.fillStyle = rgb(ink, 0.45);
        for (let x = bx; x < bx + bw; x += step * 2) m.fillRect(x, by, step, bh);
        for (let y = by; y < by + bh; y += step * 2) m.fillRect(bx, y, bw, step);
      } else {
        // little flowers: five petals round a contrasting middle
        const n = Math.round((bw * bh) / 1400);
        for (let k = 0; k < n; k++) {
          const fx = bx + r() * bw, fy = by + r() * bh, pr = 3 + r() * 4;
          m.fillStyle = rgb(ink, 0.9);
          for (let q = 0; q < 5; q++) {
            const a = (q / 5) * Math.PI * 2;
            m.beginPath();
            m.arc(fx + Math.cos(a) * pr, fy + Math.sin(a) * pr, pr * 0.75, 0, Math.PI * 2);
            m.fill();
          }
          m.fillStyle = rgb([1.8, 1.6, 0.9], 0.9);
          m.beginPath();
          m.arc(fx, fy, pr * 0.6, 0, Math.PI * 2);
          m.fill();
        }
      }
    }
    m.restore();

    // quilting: each patch puffs up towards its middle
    const cx = xs.reduce((a, v) => a + v, 0) / p.length, cy = ys.reduce((a, v) => a + v, 0) / p.length;
    const g = b.createRadialGradient(cx, cy, 0, cx, cy, Math.max(bw, bh) * 0.7);
    g.addColorStop(0, 'rgb(200,200,200)');
    g.addColorStop(1, 'rgb(110,110,110)');
    b.save();
    path(b, p);
    b.clip();
    b.fillStyle = g;
    b.fillRect(bx, by, bw, bh);
    b.restore();
  }

  // seams: sunk and a touch darker, with dashed thread stitched just inside
  for (const p of patches) {
    path(m, p);
    m.strokeStyle = 'rgba(70,70,70,0.6)';
    m.lineWidth = 3;
    m.stroke();
    path(b, p);
    b.strokeStyle = 'rgb(20,20,20)';
    b.lineWidth = 7;
    b.stroke();
  }
  if (stitches > 0) {
    m.setLineDash([7, 6]);
    b.setLineDash([7, 6]);
    for (const p of patches) {
      // the outline pulled 9px towards the patch's middle
      const cx = p.reduce((a, q) => a + q[0], 0) / p.length, cy = p.reduce((a, q) => a + q[1], 0) / p.length;
      const inner = p.map(([x, y]): [number, number] => {
        const d = Math.hypot(cx - x, cy - y) || 1;
        return [x + ((cx - x) / d) * 11, y + ((cy - y) / d) * 11];
      });
      path(m, inner);
      m.strokeStyle = `rgba(242,238,226,${0.9 * stitches})`;
      m.lineWidth = 2.2;
      m.stroke();
      path(b, inner);
      b.strokeStyle = `rgba(235,235,235,${stitches})`;
      b.lineWidth = 2.5;
      b.stroke();
    }
  }
  // a fine woven grain over everything
  const bi = b.getImageData(0, 0, size, size);
  const gr = rng(77);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = (y * size + x) * 4;
      const weave = ((x >> 1) + (y >> 1)) % 2 ? 4 : -4;
      const v = bi.data[k] + weave + (gr() - 0.5) * 6;
      bi.data[k] = bi.data[k + 1] = bi.data[k + 2] = v;
    }
  }
  b.putImageData(bi, 0, 0);
  const out = { map: wrapTexture(mapC), bump: wrapTexture(bumpC) };
  patchworkTex.set(key, out);
  return out;
}

// Knitted: rows of V-shaped stockinette stitches. Like patchwork, the color
// map is a gain around mid-grey, so the yarn takes the part's own color.
const knitTex = new Map<string, { map: THREE.Texture; bump: THREE.Texture }>();

function getKnit(stripes: number) {
  const key = stripes.toFixed(2);
  const hit = knitTex.get(key);
  if (hit) return hit;
  if (knitTex.size > 8) knitTex.clear();
  const size = 512;
  const cols = 16;
  const rows = 24; // stripes come in bands of 3 rows, so this still tiles
  const w = size / cols, h = size / rows;
  const bumpC = document.createElement('canvas');
  bumpC.width = bumpC.height = size;
  const b = bumpC.getContext('2d')!;
  b.fillStyle = 'rgb(18,18,18)';
  b.fillRect(0, 0, size, size);
  // each stitch is two plump legs leaning apart into a V
  const legs: { x: number; y: number; a: number }[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = (i + 0.5) * w, cy = (j + 0.5) * h;
      for (const side of [-1, 1]) legs.push({ x: cx + side * w * 0.21, y: cy, a: side * 0.5 });
    }
  }
  const leg = (l: { x: number; y: number; a: number }, fn: () => void) => {
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
      b.save();
      b.translate(l.x + dx, l.y + dy);
      b.rotate(l.a);
      b.scale(w * 0.29, h * 0.95);
      fn();
      b.restore();
    }
  };
  // 'lighten': where legs overlap, the higher yarn wins
  b.globalCompositeOperation = 'lighten';
  for (const l of legs) {
    leg(l, () => {
      const g = b.createRadialGradient(0, -0.1, 0, 0, 0, 1);
      g.addColorStop(0, 'rgb(235,235,235)');
      g.addColorStop(0.55, 'rgb(190,190,190)');
      g.addColorStop(0.85, 'rgb(110,110,110)');
      g.addColorStop(1, 'rgb(18,18,18)');
      b.fillStyle = g;
      b.beginPath();
      b.arc(0, 0, 1, 0, Math.PI * 2);
      b.fill();
    });
  }
  // the plies twisting round each leg: fine slanted grooves
  b.globalCompositeOperation = 'source-over';
  b.strokeStyle = 'rgba(0,0,0,0.22)';
  for (const l of legs) {
    leg(l, () => {
      b.beginPath();
      b.arc(0, 0, 0.92, 0, Math.PI * 2);
      b.clip();
      b.lineWidth = 0.07;
      for (let k = -1.4; k <= 1.4; k += 0.32) {
        b.beginPath();
        b.moveTo(-1, k - 0.5);
        b.lineTo(1, k + 0.5);
        b.stroke();
      }
    });
  }
  // a little fibre grain over everything
  const grain = tileNoise(size, 64, 2, 13);
  const bi = b.getImageData(0, 0, size, size);
  for (let i = 0; i < grain.length; i++) {
    const v = bi.data[i * 4] + (grain[i] - 0.5) * 30;
    bi.data[i * 4] = bi.data[i * 4 + 1] = bi.data[i * 4 + 2] = v;
  }
  b.putImageData(bi, 0, 0);

  // color gain: yarn tops a touch lighter, the gaps between stitches darker;
  // stripes lighten every other band of three rows
  const mapC = document.createElement('canvas');
  mapC.width = mapC.height = size;
  const m = mapC.getContext('2d')!;
  const mi = m.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const band = Math.floor(y / h / 3) % 2 === 1 ? 1 + 0.55 * stripes : 1;
    for (let x = 0; x < size; x++) {
      const k = (y * size + x) * 4;
      const gain = (0.55 + 0.55 * (bi.data[k] / 255)) * band;
      mi.data[k] = mi.data[k + 1] = mi.data[k + 2] = Math.min(255, Math.round(gain * 127.5));
      mi.data[k + 3] = 255;
    }
  }
  m.putImageData(mi, 0, 0);
  const out = { map: wrapTexture(mapC), bump: wrapTexture(bumpC) };
  knitTex.set(key, out);
  return out;
}

const toonGradients = new Map<string, THREE.DataTexture>();
/** Stepped lighting ramp: `bands` flat tones from the shadow tone up to full light. */
function getToonGradient(bands: number, shadow: number) {
  const key = `${bands}:${shadow}`;
  let t = toonGradients.get(key);
  if (t) return t;
  const low = (1 - shadow) * 0.6;
  const data = new Uint8Array(bands);
  for (let i = 0; i < bands; i++) data[i] = Math.round(255 * (low + (1 - low) * (i / (bands - 1))));
  t = new THREE.DataTexture(data, bands, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  toonGradients.set(key, t);
  return t;
}

// ---------------------------------------------------------------------------
// Triplanar texturing in object space: no stretching on the steep sides of
// inflated shapes, and the pattern stays glued to the part when posed.

interface TriOptions {
  tiling: number;
  /** Fuzz shell: push out along the normal and discard pixels between fibres. */
  shell?: { offset: number; level: number; hair: THREE.Texture; hairTiling: number };
  /** Grazing-angle glow, faking light scattering through loose fibres. */
  rim?: number;
  /**
   * One projection per spot instead of a blend of three (patches, not ghosted
   * overlaps). Where it switches, a seam is sewn, with this much stitching.
   */
  hard?: { stitches: number };
  /** the color map is a gain around mid-grey: multiplied by 2 */
  mapGain?: number;
  /**
   * The bump map holds several height fields, one per channel: the height is
   * their mix by these weights (so sliders reweight them without new textures).
   */
  bumpMix?: THREE.Vector3;
  /** Extra shader code: its own uniforms, and GLSL run after the color and after roughness/metalness are worked out. */
  custom?: { id: string; uniforms: Record<string, THREE.IUniform>; pars: string; color?: string; surface?: string };
}

const TRI_COMMON = /* glsl */ `
varying vec3 vTriPos;
varying vec3 vTriNormal;
varying vec3 vMaskPos;
uniform float triTiling;
vec3 triWeights() {
#ifdef TRI_HARD
  // whichever side the surface mostly faces
  vec3 a = abs(normalize(vTriNormal));
  if (a.x >= a.y && a.x >= a.z) return vec3(1.0, 0.0, 0.0);
  return a.y >= a.z ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
#else
  vec3 w = pow(abs(normalize(vTriNormal)), vec3(4.0));
  return w / (w.x + w.y + w.z);
#endif
}
vec4 triS(sampler2D t, vec3 p, float k) {
  vec3 w = triWeights();
  return texture2D(t, p.yz * k) * w.x + texture2D(t, p.xz * k) * w.y + texture2D(t, p.xy * k) * w.z;
}
#ifdef TRI_BUMP_MIX
uniform vec3 bumpMix;
float triH(sampler2D t, vec3 p, float k) { return dot(triS(t, p, k).rgb, bumpMix); }
#else
float triH(sampler2D t, vec3 p, float k) { return triS(t, p, k).x; }
#endif
`;

function triplanar<T extends THREE.Material>(mat: T, o: TriOptions): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.triTiling = { value: o.tiling };
    // where the texture is laid out: the creature's rest pose (see setTextureSpace)
    shader.uniforms.triRest = { value: (mat.userData.triRest as THREE.Matrix4 | undefined) ?? new THREE.Matrix4() };
    if (o.hard) {
      shader.defines = { ...shader.defines, TRI_HARD: '' };
      shader.uniforms.seamStitches = { value: o.hard.stitches };
    }
    shader.uniforms.rimStrength = { value: o.rim ?? 0 };
    if (o.bumpMix) {
      shader.defines = { ...shader.defines, TRI_BUMP_MIX: '' };
      shader.uniforms.bumpMix = { value: o.bumpMix };
    }
    if (o.custom) Object.assign(shader.uniforms, o.custom.uniforms);
    if (o.shell) {
      shader.uniforms.shellOffset = { value: o.shell.offset };
      shader.uniforms.shellLevel = { value: o.shell.level };
      shader.uniforms.hairMap = { value: o.shell.hair };
      shader.uniforms.hairTiling = { value: o.shell.hairTiling };
      // spots to keep bare (under eyes); updated in place by setFuzzMask
      shader.uniforms.eyeMask = { value: (mat.userData.eyeMask ??= emptyMask()) };
    }
    shader.vertexShader =
      `varying vec3 vTriPos;
       varying vec3 vTriNormal;
       varying vec3 vMaskPos;
       uniform float shellOffset;
       uniform mat4 triRest;
       #ifdef TRI_REST_ATTR
         attribute vec3 restPos;
         attribute vec3 restNormal;
       #endif
      ` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         #ifdef TRI_REST_ATTR
           vTriPos = restPos;
           vTriNormal = restNormal;
         #else
           vTriPos = (triRest * vec4(position, 1.0)).xyz;
           vTriNormal = mat3(triRest) * normal;
         #endif
         vMaskPos = position;
         ${o.shell ? 'transformed += normal * shellOffset;' : ''}`,
      );
    let fs = TRI_COMMON + 'uniform float rimStrength;\nuniform float seamStitches;\n' + shader.fragmentShader;
    fs = fs.replace(
      '#include <bumpmap_pars_fragment>',
      /* glsl */ `
      #ifdef USE_BUMPMAP
        uniform sampler2D bumpMap;
        uniform float bumpScale;
        vec2 dHdxy_fwd() {
          vec3 p = vTriPos;
          float h = triH(bumpMap, p, triTiling);
          return bumpScale * vec2(triH(bumpMap, p + dFdx(p), triTiling) - h, triH(bumpMap, p + dFdy(p), triTiling) - h);
        }
        vec3 perturbNormalArb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
          vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
          vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
          vec3 R1 = cross(vSigmaY, surf_norm);
          vec3 R2 = cross(surf_norm, vSigmaX);
          float fDet = dot(vSigmaX, R1) * faceDirection;
          vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
          return normalize(abs(fDet) * surf_norm - vGrad);
        }
      #endif`,
    );
    fs = fs.replace(
      '#include <map_fragment>',
      /* glsl */ `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = triS(map, vTriPos, triTiling);
        sampledDiffuseColor.rgb *= ${(o.mapGain ?? 1).toFixed(2)};
        diffuseColor *= sampledDiffuseColor;
      #endif
      #ifdef TRI_HARD
      {
        // Sew the line where the projection switches, like the seams in the
        // texture. How far we are from it: the gap between the two biggest
        // normal components, over how fast that gap changes across the surface.
        vec3 a = abs(normalize(vTriNormal));
        float m1 = max(a.x, max(a.y, a.z));
        float m3 = min(a.x, min(a.y, a.z));
        float gap = m1 - (a.x + a.y + a.z - m1 - m3);
        float perPx = 1024.0 * triTiling; // texture pixels per unit
        float d = gap * length(fwidth(vTriPos)) / max(fwidth(gap), 1e-5) * perPx;
        // dark seam, like the texture's
        diffuseColor.rgb *= mix(1.0, 0.72, 1.0 - smoothstep(1.5, 2.5, d));
        // dashed thread just beside it (7 on, 6 off), running along the seam:
        // the seam between two faces runs along the third axis
        vec3 p = vTriPos * perPx;
        float along = a.x == m3 ? p.x : (a.y == m3 ? p.y : p.z);
        float dash = step(6.0, mod(along, 13.0));
        float band = smoothstep(9.5, 10.5, d) * (1.0 - smoothstep(12.0, 13.0, d));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * 1.85, band * dash * seamStitches);
      }
      #endif`,
    );
    if (o.rim) {
      // light bleeding through the fibre halo at the silhouette, plus a little
      // wrap-around so the terminator is soft like wool rather than hard like plastic
      fs = fs.replace(
        '#include <opaque_fragment>',
        `{
           float facing = clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
           float rim = pow(1.0 - facing, 2.2);
           outgoingLight += diffuseColor.rgb * rim * rimStrength;
           outgoingLight = mix(outgoingLight, outgoingLight + diffuseColor.rgb * 0.06, 1.0 - facing);
         }
         #include <opaque_fragment>`,
      );
    }
    if (o.shell) {
      fs = 'uniform float shellLevel;\nuniform sampler2D hairMap;\nuniform float hairTiling;\nuniform vec4 eyeMask[8];\n' + fs;
      fs = fs.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         vec4 fibre = triS(hairMap, vTriPos, hairTiling);
         if (fibre.r < shellLevel) discard;
         for (int i = 0; i < 8; i++) {
           if (eyeMask[i].w > 0.0 && distance(vMaskPos, eyeMask[i].xyz) < eyeMask[i].w) discard;
         }`,
      );
      // deeper fibres sit in shadow, tips catch the light; each fibre gets a warm/cool tint
      fs = fs.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         diffuseColor.rgb *= mix(0.62, 1.12, shellLevel) * mix(vec3(0.92, 0.97, 1.08), vec3(1.1, 1.0, 0.86), fibre.g);`,
      );
    }
    if (o.custom) {
      const cu = o.custom;
      fs = cu.pars + '\n' + fs;
      if (cu.color) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n{\n${cu.color}\n}`);
      if (cu.surface) fs = fs.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n{\n${cu.surface}\n}`);
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () =>
    `tri-${o.shell ? 'shell' : 'base'}-${o.rim ? 'rim' : 'norim'}-${o.mapGain ?? 1}-${o.hard ? 'hard' : 'soft'}-${o.bumpMix ? 'mix' : ''}-${o.custom?.id ?? ''}`;
  return mat;
}

/**
 * Where a mesh's textures are laid out, for every triplanar material on it
 * (fuzz shells included). Body parts pass their bone's rest-pose frame, so
 * every part shares one texture space that then bends and turns with the
 * pose like real fabric; a seamless skin carries rest positions per vertex
 * instead (restPos / restNormal attributes). Call before the first render.
 */
export function setTextureSpace(root: THREE.Object3D, rest: THREE.Matrix4 | 'attributes') {
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      if (rest === 'attributes') m.defines = { ...m.defines, TRI_REST_ATTR: '' };
      else m.userData.triRest = rest;
    }
  });
}

// ---------------------------------------------------------------------------

/**
 * The color a material shows for a part's color: glass is only tinted by
 * it (full tint strength = the plain color). Used wherever colors get baked
 * into a mesh (blended colors), so baking doesn't change the look.
 */
export function surfaceColor(style: StyleId, color: string, k: StyleSettings): THREE.Color {
  const c = new THREE.Color(color);
  return style === 'glass' ? new THREE.Color(1, 1, 1).lerp(c, k.tint) : c;
}

export function makeMaterial(style: StyleId, color: string, settings: StyleSettings = styleSettings(style)): THREE.Material {
  const c = new THREE.Color(color);
  const k = settings;
  switch (style) {
    case 'clay':
      return triplanar(
        new THREE.MeshPhysicalMaterial({
          color: c,
          roughness: k.matte,
          metalness: 0,
          bumpMap: getClayBump(),
          bumpScale: k.prints,
          // a faint sheen fakes the soft, waxy falloff of plasticine at grazing angles
          sheen: k.wax,
          sheenRoughness: 0.8,
          sheenColor: c.clone().lerp(new THREE.Color('#ffffff'), 0.4),
        }),
        { tiling: 1.25 },
      );
    case 'felt': {
      const f = getFelt();
      return triplanar(
        new THREE.MeshPhysicalMaterial({
          color: c,
          roughness: 1,
          metalness: 0,
          map: f.map,
          bumpMap: f.bump,
          bumpScale: 2.5,
          sheen: 1,
          sheenRoughness: 0.35,
          sheenColor: c.clone().lerp(new THREE.Color('#ffffff'), 0.6),
        }),
        { tiling: 2.2, rim: k.glow },
      );
    }
    case 'lowpoly':
      return new THREE.MeshStandardMaterial({ color: c, roughness: k.matte, metalness: 0, flatShading: true, vertexColors: true });
    case 'plastic':
      return new THREE.MeshPhysicalMaterial({
        color: c,
        roughness: 0.04 + (1 - k.shine) * 0.8,
        metalness: k.metal,
        clearcoat: k.coat,
        clearcoatRoughness: 0.04 + (1 - k.shine) * 0.3,
      });
    case 'glass': {
      // real transmission: things behind and inside are refracted and tinted
      const white = new THREE.Color(1, 1, 1);
      return new THREE.MeshPhysicalMaterial({
        color: surfaceColor('glass', color, k),
        metalness: 0,
        roughness: (1 - k.clarity) * 0.55,
        transmission: 1,
        ior: k.ior,
        thickness: 0.005 + k.thick * 0.6,
        attenuationColor: white.clone().lerp(c, 0.3 + k.tint * 0.7),
        attenuationDistance: 0.1 + (1 - k.tint) * 3,
        specularIntensity: 0.8,
        clearcoat: 0.25,
        clearcoatRoughness: (1 - k.clarity) * 0.3,
        // the scene's environment is kept dim for the matte materials; glass
        // gets its own brighter copy so it has crisp reflections. Not too
        // bright: a hollow jar stacks four reflective walls.
        envMap: glassEnv,
        envMapIntensity: 0.75,
      });
    }
    case 'metal': {
      const t = getMetalTex();
      // tarnish: dull rust brown through to copper's blue-green verdigris
      const patinaColor = new THREE.Color('#4a200d').lerp(new THREE.Color('#3f7f6c'), k.tone);
      return triplanar(
        new THREE.MeshPhysicalMaterial({
          color: c,
          metalness: 1,
          roughness: 0.04 + (1 - k.polish) * 0.6,
          bumpMap: t.bump,
          bumpScale: 1,
          // metal is all reflection: like glass it gets the brighter environment
          // (the scene's own is kept dim for the matte materials)
          envMap: glassEnv,
          envMapIntensity: 1.1,
        }),
        {
          tiling: 1.5,
          bumpMix: new THREE.Vector3(k.hammer * 2.2, k.brush * 0.9, 0),
          custom: {
            id: 'metal',
            uniforms: {
              patinaMap: { value: t.patina },
              patinaAmount: { value: k.patina },
              patinaColor: { value: patinaColor },
            },
            pars: 'uniform sampler2D patinaMap;\nuniform float patinaAmount;\nuniform vec3 patinaColor;',
            // the tarnish takes over in blotches as Patina goes up: there it's
            // dull and not metallic at all
            surface: /* glsl */ `
              vec3 pt = triS(patinaMap, vTriPos, triTiling * 0.8).rgb;
              // the fine mottling frays the edges, so it creeps in rather than being painted on
              float h = pt.r + (pt.g - 0.5) * 0.3;
              float edge = 1.0 - pow(patinaAmount, 1.4) * 1.12;
              float p = smoothstep(edge - 0.12, edge + 0.08, h) * step(0.001, patinaAmount);
              // thin at the edges (the metal still glints through), crusty and uneven inside
              vec3 crust = patinaColor * (0.45 + 1.1 * pt.g * pt.g);
              diffuseColor.rgb = mix(diffuseColor.rgb, crust, p);
              roughnessFactor = mix(roughnessFactor, 0.9, p);
              metalnessFactor = mix(metalnessFactor, 0.0, p);`,
          },
        },
      );
    }
    case 'toon':
      return new THREE.MeshToonMaterial({ color: c, gradientMap: getToonGradient(Math.round(k.bands), k.shadow) });
    case 'patchwork': {
      const p = getPatchwork(k.variety, k.prints, k.stitches);
      return triplanar(
        new THREE.MeshPhysicalMaterial({
          color: c,
          roughness: 0.92,
          metalness: 0,
          map: p.map,
          bumpMap: p.bump,
          bumpScale: 2.2 * k.puff,
          // cotton catches a soft sheen at grazing angles
          sheen: 0.5,
          sheenRoughness: 0.6,
          sheenColor: c.clone().lerp(new THREE.Color('#ffffff'), 0.5),
        }),
        { tiling: 0.8 / k.size, hard: { stitches: k.stitches }, mapGain: 2 },
      );
    }
    case 'knit': {
      const t = getKnit(k.stripes);
      return triplanar(
        new THREE.MeshPhysicalMaterial({
          color: c,
          roughness: 0.95,
          metalness: 0,
          map: t.map,
          bumpMap: t.bump,
          bumpScale: 2.6 * k.puff,
          // soft wool sheen at grazing angles
          sheen: 0.9,
          sheenRoughness: 0.45,
          sheenColor: c.clone().lerp(new THREE.Color('#ffffff'), 0.55),
        }),
        // one projection per spot, so stitches never ghost over each other;
        // where it switches reads as a sewn seam (without patchwork's thread)
        { tiling: 1.5 / k.size, hard: { stitches: 0 }, mapGain: 2, rim: k.fluff },
      );
    }
  }
}

/** Share of felt fuzz shells actually drawn (lower = faster; see Settings > Performance). */
let fuzzQuality = 1;
export function setFuzzQuality(q: number) {
  fuzzQuality = q;
}

/** Concentric fuzz shells for felt: a halo of curly fibres standing off the surface. */
export function makeFuzzShells(geo: THREE.BufferGeometry, color: string, settings: StyleSettings, layers = 12, unit = 1): THREE.Mesh[] {
  const f = getFelt();
  layers = Math.max(3, Math.round(layers * fuzzQuality));
  // unit = how much the mesh is scaled up in the world; fuzz keeps its world length
  const height = settings.fuzz / unit;
  if (height <= 0) return [];
  // denser fuzz keeps more fibres alive in each shell
  const floor = 0.42 - 0.4 * settings.density;
  const base = new THREE.Color(color);
  const out: THREE.Mesh[] = [];
  for (let i = 1; i <= layers; i++) {
    const level = i / (layers + 1);
    const m = triplanar(
      new THREE.MeshStandardMaterial({ color: base, roughness: 1, metalness: 0 }),
      {
        tiling: unit,
        rim: settings.glow * 1.6,
        shell: { offset: height * Math.pow(level, 1.3), level: floor + level * 0.74, hair: f.hair, hairTiling: 2.4 * unit },
      },
    );
    // bare spots (under eyes), filled by setFuzzMask before or after the shader compiles
    m.userData.eyeMask = emptyMask();
    const mesh = new THREE.Mesh(geo, m);
    mesh.raycast = () => {};
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.fx = true;
    mesh.layers.enable(FUR_LAYER);
    out.push(mesh);
  }
  return out;
}

/** Loose curly wisps sticking out of felt. */
export function makeStrayHairs(geo: THREE.BufferGeometry, color: string, seed: number, amount = 1, tintFromGeometry = false, unit = 1): THREE.LineSegments {
  const r = rng(seed);
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  // blended skins carry per-vertex colors: each wisp takes the color where it grows
  const vcol = tintFromGeometry ? (geo.getAttribute('color') as THREE.BufferAttribute | undefined) : undefined;
  const rootCol = new THREE.Color();
  const index = geo.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);

  // area-weighted triangle picking
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const cdf: number[] = [];
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, vi(t, 0));
    b.fromBufferAttribute(pos, vi(t, 1));
    c.fromBufferAttribute(pos, vi(t, 2));
    total += b.sub(a).cross(c.sub(a)).length() / 2;
    cdf.push(total);
  }
  const count = Math.round(Math.min(1400, Math.max(60, total * unit * unit * 900)) * amount);
  const verts: number[] = [];
  const roots: number[] = [];
  const cols: number[] = [];
  const baseCol = new THREE.Color(color);
  const warm = new THREE.Color(1.1, 1.0, 0.85), cool = new THREE.Color(0.92, 0.98, 1.08);
  const p = new THREE.Vector3(), n = new THREE.Vector3(), tmp = new THREE.Vector3();
  const tangent = new THREE.Vector3(), dir = new THREE.Vector3(), axis = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const x = r() * total;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    let u = r(), v = r();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    p.set(0, 0, 0).addScaledVector(tmp.fromBufferAttribute(pos, vi(lo, 0)), w)
      .addScaledVector(tmp.fromBufferAttribute(pos, vi(lo, 1)), u)
      .addScaledVector(tmp.fromBufferAttribute(pos, vi(lo, 2)), v);
    n.set(0, 0, 0).addScaledVector(tmp.fromBufferAttribute(nor, vi(lo, 0)), w)
      .addScaledVector(tmp.fromBufferAttribute(nor, vi(lo, 1)), u)
      .addScaledVector(tmp.fromBufferAttribute(nor, vi(lo, 2)), v).normalize();
    tangent.set(r() - 0.5, r() - 0.5, r() - 0.5).cross(n).normalize();
    // most wisps lie close to the surface; a few spring out
    const len = (0.015 + Math.pow(r(), 2) * 0.055) / unit;
    const lift = 0.25 + r() * 0.7;
    dir.copy(tangent).addScaledVector(n, lift).normalize();
    axis.set(r() - 0.5, r() - 0.5, r() - 0.5).addScaledVector(n, 0.8).normalize();
    const turn = (0.35 + r() * 0.8) * (r() < 0.5 ? -1 : 1);
    const steps = 9;
    roots.push(p.x, p.y, p.z);
    if (vcol) {
      rootCol.setRGB(0, 0, 0);
      for (const [vtx, wt] of [[vi(lo, 0), w], [vi(lo, 1), u], [vi(lo, 2), v]] as const) {
        rootCol.r += vcol.getX(vtx) * wt;
        rootCol.g += vcol.getY(vtx) * wt;
        rootCol.b += vcol.getZ(vtx) * wt;
      }
    } else rootCol.copy(baseCol);
    col.copy(rootCol).multiply(r() < 0.5 ? warm : cool).multiplyScalar(0.9 + r() * 0.25);
    const cur = p.clone().addScaledVector(n, -0.001 / unit);
    for (let s = 0; s < steps; s++) {
      const next = cur.clone().addScaledVector(dir, len / steps);
      verts.push(cur.x, cur.y, cur.z, next.x, next.y, next.z);
      cols.push(col.r, col.g, col.b, col.r, col.g, col.b);
      cur.copy(next);
      dir.applyAxisAngle(axis, turn);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }));
  lines.raycast = () => {};
  lines.userData.fx = true;
  lines.layers.enable(FUR_LAYER);
  // for setFuzzMask: where each wisp grows from, and the untouched positions
  lines.userData.hairRoots = Float32Array.from(roots);
  lines.userData.hairVerts = 18; // 9 segments x 2 ends
  lines.userData.orig = Float32Array.from(verts);
  return lines;
}

/** A bare spot on felt (under an eye): centre and radius in the part's local space. */
export interface FuzzSpot {
  x: number;
  y: number;
  z: number;
  r: number;
}

function emptyMask(): THREE.Vector4[] {
  return Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0));
}

/**
 * Keep felt fuzz and stray hairs off the given spots, so e.g. a button eye
 * sits on a clean patch rather than having wisps poke through it.
 * Pass no spots to grow everything back.
 */
export function setFuzzMask(part: THREE.Object3D, spots: FuzzSpot[]) {
  part.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
    const mask = mat?.userData?.eyeMask as THREE.Vector4[] | undefined;
    if (mask) mask.forEach((v, i) => (spots[i] ? v.set(spots[i].x, spots[i].y, spots[i].z, spots[i].r) : v.set(0, 0, 0, 0)));
    const roots = o.userData.hairRoots as Float32Array | undefined;
    if (roots && o instanceof THREE.LineSegments) {
      const pos = o.geometry.getAttribute('position') as THREE.BufferAttribute;
      const orig = o.userData.orig as Float32Array;
      const per = o.userData.hairVerts as number;
      for (let h = 0; h < roots.length / 3; h++) {
        const x = roots[h * 3], y = roots[h * 3 + 1], z = roots[h * 3 + 2];
        const bare = spots.some((sp) => (sp.x - x) ** 2 + (sp.y - y) ** 2 + (sp.z - z) ** 2 < sp.r * sp.r);
        for (let v = h * per; v < (h + 1) * per; v++) {
          // a hidden wisp collapses onto its root (a zero-length, invisible line)
          if (bare) pos.setXYZ(v, x, y, z);
          else pos.setXYZ(v, orig[v * 3], orig[v * 3 + 1], orig[v * 3 + 2]);
        }
      }
      pos.needsUpdate = true;
    }
  });
}

/**
 * See-through for any material: applies `opacity` to a part's material and its
 * fuzz shells / ink. Opaque parts stay on the fast, correctly-sorted path.
 */
export function setOpacity(root: THREE.Object3D, opacity: number) {
  const see = opacity < 0.999;
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (!m || !(o instanceof THREE.Mesh)) return;
    const base = (m.userData.baseOpacity as number | undefined) ?? 1;
    if (m.transparent !== see) m.needsUpdate = true;
    m.transparent = see;
    m.opacity = base * opacity;
  });
}

/** Glass shouldn't cast a solid black shadow. */
export function castsShadow(style: StyleId) {
  return style !== 'glass';
}

/**
 * Inverted-hull ink outline for the toon style. With `smooth`, the hull is
 * pushed out along the geometry's `inkNormal` attribute (see inkNormals), so
 * shapes with hard edges get one unbroken outline instead of split shards.
 */
export function makeOutlineMaterial(width = 0.012, smooth = false): THREE.Material {
  const m = new THREE.MeshBasicMaterial({ color: 0x2b2024, side: THREE.BackSide });
  if (smooth) m.defines = { INK_NORMAL: '' };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = { value: width };
    shader.vertexShader =
      'uniform float outlineWidth;\n#ifdef INK_NORMAL\nattribute vec3 inkNormal;\n#endif\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#ifdef INK_NORMAL
           vec3 transformed = position + inkNormal * outlineWidth;
         #else
           vec3 transformed = position + normal * outlineWidth;
         #endif`,
      );
  };
  m.userData.ink = true;
  return m;
}

/**
 * Give a geometry an `inkNormal` attribute: the normals averaged over every
 * vertex at the same spot, so creased corners (split vertices) push the ink
 * hull out together and it stays closed. Done once per geometry.
 */
export function inkNormals(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geo.getAttribute('inkNormal')) return geo;
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  if (!pos || !nor) return geo;
  const key = (i: number) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const sums = new Map<string, THREE.Vector3>();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    let s = sums.get(k);
    if (!s) sums.set(k, (s = new THREE.Vector3()));
    s.add(v.fromBufferAttribute(nor, i));
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    v.copy(sums.get(key(i))!);
    if (v.lengthSq() < 1e-10) v.fromBufferAttribute(nor, i);
    v.normalize();
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  geo.setAttribute('inkNormal', new THREE.BufferAttribute(out, 3));
  return geo;
}

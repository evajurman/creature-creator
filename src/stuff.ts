import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bounds, buildInflatedGeometry, cleanOutline, getMeshDetail, type Vec2 } from './inflate';
import {
  castsShadow,
  inkNormals,
  makeFuzzShells,
  makeMaterial,
  makeOutlineMaterial,
  makeStrayHairs,
  setOpacity,
  styleSettings,
  type StyleId,
  type StyleSettings,
} from './materials';

/**
 * "Stuff": props made of drawn pieces (a sword, a shield, glasses...) that
 * can be attached to any body part. Coordinates are drawn on the XY plane;
 * the origin is the attach point and +Z faces out of the body.
 */
export interface Piece {
  id: string;
  outline: Vec2[];
  /** cut-outs; only used by flat pieces */
  holes: Vec2[][];
  /**
   * flat = a cut-out with rounded edges; puffy = inflated like a body part;
   * turned = the silhouette spun around the centre line (jars, cups, bottles)
   */
  kind: 'flat' | 'puffy' | 'turned';
  /** flat: depth in world units; puffy: inflation (1 = round); turned: wall thickness */
  thickness: number;
  /** turned: hollow shell rather than solid */
  hollow?: boolean;
  /** turned + hollow: leave the top open */
  open?: boolean;
  /** 1 = solid, lower = see-through */
  opacity?: number;
  /** flat: how rounded the edges are, 0..1 */
  round: number;
  color: string;
  style: StyleId;
  /** layer offset along Z (in front of / behind other pieces) */
  z: number;
}

export interface Thing {
  id: string;
  name: string;
  pieces: Piece[];
  /** small preview image (data URL) for the collection */
  thumb?: string;
  /**
   * true = takes the material of whatever wears it (type and settings: the
   * body part it's attached to), instead of each piece's own
   */
  inherit?: boolean;
  /** true = uses its own material settings below instead of the creature's (when not inheriting) */
  ownMaterial?: boolean;
  /** false = felt fuzz grows and shrinks with the item's scale (default: it keeps its real length) */
  scaleMaterial?: boolean;
  materialSettings?: Partial<Record<StyleId, StyleSettings>>;
  /** curve the whole thing, -1..1 (0 = flat as drawn) */
  bend?: number;
  /** axis = curve away from the centre line (a shield's curve, wings); radial = a dome around the crosshair */
  bendMode?: BendMode;
}

export type BendMode = 'axis' | 'radial';

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function newThing(): Thing {
  return { id: uid(), name: 'New thing', pieces: [] };
}

export function newPiece(outline: Vec2[], like?: Piece): Piece {
  return {
    id: uid(),
    outline,
    holes: [],
    kind: like?.kind ?? 'flat',
    thickness: like?.thickness ?? 0.04,
    round: like?.round ?? 0.6,
    color: like?.color ?? '#c9ccd6',
    style: like?.style ?? 'plastic',
    z: like?.z ?? 0,
  };
}

// ---------------------------------------------------------------------------
// geometry

const geoCache = new Map<string, THREE.BufferGeometry>();

function tidy(loop: Vec2[]): Vec2[] {
  const b = bounds(loop);
  return cleanOutline(loop, Math.max(b.w, b.h, 0.01) / 90);
}

export function pieceGeometry(p: Piece): THREE.BufferGeometry {
  const key = JSON.stringify([p.outline, p.holes, p.kind, p.thickness, p.round, p.z, p.hollow, p.open, p.style === 'lowpoly', p.style === 'clay', p.kind === 'puffy' ? getMeshDetail() : 1]);
  const hit = geoCache.get(key);
  if (hit) return hit;
  if (geoCache.size > 120) geoCache.clear();

  let g: THREE.BufferGeometry;
  if (p.kind === 'puffy') {
    g = buildInflatedGeometry(p.outline, { thickness: p.thickness, lowPoly: p.style === 'lowpoly', lumps: p.style === 'clay' ? 1 : 0 });
  } else if (p.kind === 'turned') {
    g = turnedGeometry(p);
    if (p.style === 'lowpoly') {
      const n = g.getAttribute('position').count;
      g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    }
  } else {
    const shape = new THREE.Shape(tidy(p.outline).map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of p.holes) shape.holes.push(new THREE.Path(tidy(h).map(([x, y]) => new THREE.Vector2(x, y))));
    const depth = Math.max(0.003, p.thickness);
    const bevel = Math.min(depth * 0.45, 0.03) * p.round;
    const core = Math.max(0.001, depth - 2 * bevel);
    const ex = new THREE.ExtrudeGeometry(shape, {
      depth: core,
      bevelEnabled: bevel > 0.0005,
      bevelThickness: bevel,
      bevelSize: bevel * 0.85,
      bevelOffset: -bevel * 0.85, // keep the drawn silhouette size
      bevelSegments: 4,
      curveSegments: 1,
      steps: 1,
    });
    ex.translate(0, 0, -core / 2);
    // smooth shading across the bevel, crisp where the edges are sharp
    g = toCreasedNormals(ex, Math.PI / 3.2);
    ex.dispose();
    if (p.style === 'lowpoly') {
      const n = g.getAttribute('position').count;
      g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    }
  }
  g.translate(0, 0, p.z);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  geoCache.set(key, g);
  return g;
}

/** Who's wearing (or showing) a thing: their material, for items that inherit it. */
export interface Wearer {
  /** the material of the body part it's on */
  style: StyleId;
  settingsFor: (s: StyleId) => StyleSettings;
}

/** The material a piece is actually shown in, and with which settings. */
export function pieceLook(thing: Thing, p: Piece, wearer: Wearer): { style: StyleId; k: StyleSettings } {
  if (thing.inherit) return { style: wearer.style, k: wearer.settingsFor(wearer.style) };
  const k = thing.ownMaterial ? styleSettings(p.style, thing.materialSettings?.[p.style]) : wearer.settingsFor(p.style);
  return { style: p.style, k };
}

/**
 * Build the meshes for a thing. Pieces are tagged with userData.pieceId.
 * `unit` is how much the thing will be scaled up, so felt fuzz and toon ink
 * keep their real size.
 */
export function buildThing(thing: Thing, wearer: Wearer, unit = 1): THREE.Group {
  const group = new THREE.Group();
  const bend = thingBend(thing);
  for (const raw of thing.pieces) {
    const { style, k } = pieceLook(thing, raw, wearer);
    // low-poly and clay shape the mesh itself
    const p = style === raw.style ? raw : { ...raw, style };
    const geo = bend ? bentGeometry(pieceGeometry(p), bend) : pieceGeometry(p);
    const mesh = new THREE.Mesh(geo, makeMaterial(style, p.color, k));
    // soft (VSM) shadows draw receivers into the shadow map too: a glass jar
    // would block the light from whatever's inside it
    mesh.castShadow = mesh.receiveShadow = castsShadow(style);
    mesh.userData.pieceId = p.id;
    if (style === 'toon' && k.ink > 0) {
      // flat and turned pieces have hard edges: an outline along smoothed
      // normals stays in one piece. Ink width is in world units, like the body's.
      const ink = new THREE.Mesh(inkNormals(geo), makeOutlineMaterial(k.ink / unit, true));
      ink.raycast = () => {};
      mesh.add(ink);
    }
    if (style === 'felt') {

      for (const shell of makeFuzzShells(geo, p.color, k, 8, unit)) mesh.add(shell);
      if (k.hairs > 0) mesh.add(makeStrayHairs(geo, p.color, 7, k.hairs * 0.6, false, unit));
    }
    setOpacity(mesh, p.opacity ?? 1);
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------------------
// bending the whole thing: drawn flat, then wrapped onto a cylinder whose axis
// runs along the centre line (axis), or onto a sphere around the crosshair
// (radial). Positive bends curve the edges back (-Z), like a shield.

interface ThingBend {
  mode: BendMode;
  /** signed radius of the curve; its centre sits at z = -r */
  r: number;
}

function thingBend(thing: Thing): ThingBend | null {
  const amount = thing.bend ?? 0;
  if (Math.abs(amount) < 0.005 || !thing.pieces.length) return null;
  const mode = thing.bendMode ?? 'axis';
  // at full bend the farthest edge has turned a quarter circle
  let reach = 0;
  for (const p of thing.pieces) for (const [x, y] of p.outline) reach = Math.max(reach, mode === 'axis' ? Math.abs(x) : Math.hypot(x, y));
  if (reach < 1e-4) return null;
  return { mode, r: reach / (amount * (Math.PI / 2)) };
}

const bentCache = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();

function bentGeometry(src: THREE.BufferGeometry, bd: ThingBend): THREE.BufferGeometry {
  const key = `${bd.mode}:${bd.r.toFixed(5)}`;
  let per = bentCache.get(src);
  const hit = per?.get(key);
  if (hit) return hit;
  const g = src.clone();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const r0 = bd.r;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // unit direction away from the centre (line or point) in the drawing plane
    let ux = 1, uy = 0, d = x;
    if (bd.mode === 'radial') {
      d = Math.hypot(x, y);
      if (d > 1e-9) {
        ux = x / d;
        uy = y / d;
      }
    }
    const phi = d / r0;
    const c = Math.cos(phi), sn = Math.sin(phi);
    const rr = r0 + z;
    // along the curve: the drawing distance becomes arc length on a circle of radius r
    const along = rr * sn;
    if (bd.mode === 'axis') pos.setXYZ(i, along, y, rr * c - r0);
    else pos.setXYZ(i, ux * along, uy * along, rr * c - r0);
    if (nor) {
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      const nu = nx * ux + ny * uy;
      const nu2 = nu * c + nz * sn;
      nor.setXYZ(i, nx + (nu2 - nu) * ux, ny + (nu2 - nu) * uy, -nu * sn + nz * c);
    }
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  if (!per) bentCache.set(src, (per = new Map()));
  if (per.size > 8) per.clear();
  per.set(key, g);
  return g;
}

/**
 * Radius of the drawn silhouette at height y: the farthest crossing from the
 * centre line on either side, so a half-drawn or whole outline both work.
 */
function radiusAt(outline: Vec2[], y: number): number | null {
  let best: number | null = null;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i];
    const [xj, yj] = outline[j];
    if (yi > y === yj > y) continue;
    const x = xi + ((y - yi) / (yj - yi)) * (xj - xi);
    best = Math.max(best ?? 0, Math.abs(x));
  }
  return best;
}

/** Spin the silhouette's profile around the Y axis (the drawing's centre line). */
function turnedGeometry(p: Piece): THREE.BufferGeometry {
  const pts = turnedProfile(p);
  if (pts.length < 3) return new THREE.BufferGeometry();
  const g = new THREE.LatheGeometry(pts, 64);
  // smooth round shading but keep the rim and base edges crisp
  const out = toCreasedNormals(g, Math.PI / 4);
  g.dispose();
  return out;
}

/** The (radius, height) polyline that gets spun around the Y axis. */
export function turnedProfile(p: Piece): THREE.Vector2[] {
  const b = bounds(p.outline);
  const steps = 96;
  const y0 = b.minY, y1 = b.maxY;

  // The outer profile as a radius per height. Being single-valued in y, it
  // can't fold back on itself however wobbly the drawing is.
  const ys: number[] = [];
  const rs: number[] = [];
  for (let i = 0; i <= steps; i++) {
    // pull the sample heights slightly inside so the scanline always hits the outline
    const y = y0 + (y1 - y0) * (0.002 + (0.996 * i) / steps);
    const r = radiusAt(p.outline, y);
    if (r === null || r < 1e-4) continue;
    ys.push(y);
    rs.push(r);
  }
  if (rs.length < 3) return [];

  // Smooth away hand wobble: a small median first (kills spikes), then a few
  // gentle averaging passes. Ends are kept so the base and rim stay put.
  const med = rs.map((_, i) => {
    const w = rs.slice(Math.max(0, i - 2), i + 3).sort((a, c) => a - c);
    return w[w.length >> 1];
  });
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 1; i < med.length - 1; i++) med[i] = med[i] * 0.5 + (med[i - 1] + med[i + 1]) * 0.25;
  }
  const n = med.length;
  const bottom = ys[0], top = ys[n - 1];
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, bottom)];
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(med[i], ys[i]));

  const wall = Math.max(0.002, Math.min(p.thickness, (top - bottom) * 0.4));
  if (!p.hollow) {
    pts.push(new THREE.Vector2(0, top));
  } else {
    // Inner wall = the outer radius eroded by a disc of radius `wall`: an even
    // wall thickness that never self-intersects (unlike pushing points along
    // their normals, which folds wherever the drawing wobbles).
    const floorY = bottom + wall;
    const ceilY = p.open ? top : top - wall;
    const innerAt = (y: number) => {
      let r = Infinity;
      for (let j = 0; j < n; j++) {
        const dy = ys[j] - y;
        if (Math.abs(dy) >= wall) continue;
        r = Math.min(r, med[j] - Math.sqrt(wall * wall - dy * dy));
      }
      return Math.max(0.0005, Number.isFinite(r) ? r : 0.0005);
    };
    // inner profile from the ceiling (or rim) down to a flat floor
    const inner: THREE.Vector2[] = [new THREE.Vector2(innerAt(ceilY), ceilY)];
    for (let i = n - 1; i >= 0; i--) {
      if (ys[i] >= ceilY || ys[i] <= floorY) continue;
      inner.push(new THREE.Vector2(innerAt(ys[i]), ys[i]));
    }
    inner.push(new THREE.Vector2(innerAt(floorY), floorY));
    if (p.open) {
      // flat rim across the top of the wall, then down the inside
      pts.push(...inner);
    } else {
      // sealed: close the top, then a flat ceiling and down the cavity
      pts.push(new THREE.Vector2(0, top), new THREE.Vector2(0, ceilY), ...inner);
    }
    pts.push(new THREE.Vector2(0, floorY));
  }
  return pts;
}

export function disposeThing(group: THREE.Object3D) {
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m?.dispose();
    if (o instanceof THREE.LineSegments) o.geometry.dispose();
  });
}

// ---------------------------------------------------------------------------
// collection (browser storage)

const LIB_KEY = 'creature-creator/stuff';

export function collection(): Thing[] {
  try {
    return JSON.parse(localStorage.getItem(LIB_KEY) ?? '[]') as Thing[];
  } catch {
    return [];
  }
}

function writeCollection(list: Thing[]): boolean {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Empty My stuff. */
export function clearCollection() {
  writeCollection([]);
}

/** Add or replace (by id). Returns false if browser storage is full. */
export function putThing(thing: Thing): boolean {
  // replaced where it is, so the collection keeps its order
  const list = collection();
  const i = list.findIndex((t) => t.id === thing.id);
  if (i >= 0) list[i] = structuredClone(thing);
  else list.push(structuredClone(thing));
  return writeCollection(list);
}

export function removeThing(id: string) {
  writeCollection(collection().filter((t) => t.id !== id));
}

// ---------------------------------------------------------------------------
// files: JSON with a small header so the app can tell what it's opening

export const FILE_FORMAT = 'creature-creator';
/** 2: a .creature file holds a whole bundle (creatures, stuff, body plans, backdrop) */
export const FILE_VERSION = 2;

export type FileKind = 'creature' | 'scene' | 'stuff' | 'collection';

export interface FileEnvelope<T = unknown> {
  format: typeof FILE_FORMAT;
  kind: FileKind;
  version: number;
  savedAt: string;
  data: T;
}

export function envelope<T>(kind: FileKind, data: T): FileEnvelope<T> {
  return { format: FILE_FORMAT, kind, version: FILE_VERSION, savedAt: new Date().toISOString(), data };
}

export function parseEnvelope(text: string): FileEnvelope {
  const obj = JSON.parse(text) as Partial<FileEnvelope>;
  if (obj.format !== FILE_FORMAT || !obj.kind || obj.data === undefined) {
    throw new Error("This doesn't look like a Creature Creator file.");
  }
  if ((obj.version ?? 1) > FILE_VERSION) throw new Error('This file was made by a newer version of Creature Creator.');
  return obj as FileEnvelope;
}

export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function safeFileName(name: string, fallback: string): string {
  const s = name.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').slice(0, 60);
  return s || fallback;
}

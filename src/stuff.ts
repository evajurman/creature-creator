import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bounds, buildInflatedGeometry, cleanOutline, type Vec2 } from './inflate';
import { makeFuzzShells, makeMaterial, makeOutlineMaterial, makeStrayHairs, type StyleId, type StyleSettings } from './materials';

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
  /** flat = a cut-out with rounded edges; puffy = inflated like a body part */
  kind: 'flat' | 'puffy';
  /** flat: depth in world units; puffy: inflation (1 = round) */
  thickness: number;
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
}

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
  const key = JSON.stringify([p.outline, p.holes, p.kind, p.thickness, p.round, p.z, p.style === 'lowpoly', p.style === 'clay']);
  const hit = geoCache.get(key);
  if (hit) return hit;
  if (geoCache.size > 120) geoCache.clear();

  let g: THREE.BufferGeometry;
  if (p.kind === 'puffy') {
    g = buildInflatedGeometry(p.outline, { thickness: p.thickness, lowPoly: p.style === 'lowpoly', lumps: p.style === 'clay' ? 1 : 0 });
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

/** Build the meshes for a thing. Pieces are tagged with userData.pieceId. */
export function buildThing(thing: Thing, settingsFor: (s: StyleId) => StyleSettings): THREE.Group {
  const group = new THREE.Group();
  for (const p of thing.pieces) {
    const geo = pieceGeometry(p);
    const k = settingsFor(p.style);
    const mesh = new THREE.Mesh(geo, makeMaterial(p.style, p.color, k));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.pieceId = p.id;
    if (p.style === 'toon' && k.ink > 0) {
      const ink = new THREE.Mesh(geo, makeOutlineMaterial(k.ink));
      ink.raycast = () => {};
      mesh.add(ink);
    }
    if (p.style === 'felt') {
      for (const shell of makeFuzzShells(geo, p.color, k, 8)) mesh.add(shell);
      if (k.hairs > 0) mesh.add(makeStrayHairs(geo, p.color, 7, k.hairs * 0.6));
    }
    group.add(mesh);
  }
  return group;
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

/** Add or replace (by id). Returns false if browser storage is full. */
export function putThing(thing: Thing): boolean {
  const list = collection().filter((t) => t.id !== thing.id);
  list.push(structuredClone(thing));
  return writeCollection(list);
}

export function removeThing(id: string) {
  writeCollection(collection().filter((t) => t.id !== id));
}

// ---------------------------------------------------------------------------
// files: JSON with a small header so the app can tell what it's opening

export const FILE_FORMAT = 'creature-creator';
export const FILE_VERSION = 1;

export type FileKind = 'creature' | 'stuff' | 'collection';

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

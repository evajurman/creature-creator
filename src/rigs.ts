export type V3 = [number, number, number];

/**
 * A bone is also a body part: you draw its outline in the plane spanned by
 * `side` (horizontal on the drawing) and the bone direction (vertical).
 * Coordinates: Y up, creature faces +Z, creature's left is +X.
 */
export interface BoneDef {
  id: string;
  name: string;
  parent?: string;
  start: V3;
  end: V3;
  side: V3;
  /** default shape width at the base of the bone */
  width: number;
  /** default shape width at the tip (defaults to `width`) */
  widthEnd?: number;
  /** curve the bone into an arc in its drawing plane */
  bendy?: boolean;
  /** how far it curves, -1..1 (a full 1 is about a half-circle) */
  bend?: number;
  /**
   * which way it curves, radians around the bone: 0 = sideways in the drawing
   * plane, pi/2 = out of the drawing (for a body: forward), pi = the other side
   */
  bendDir?: number;
  /**
   * turn the bone about the line from its base to its tip, radians: the
   * drawing (and so a flat part like a wing) turns with it
   */
  roll?: number;
  thickness?: number;
  color?: string;
  /** Define once on the +X side; a mirrored twin is generated. */
  mirror?: boolean;
  /** IK chains stop before reaching this bone. */
  anchor?: boolean;
  /** Filled in by expansion: the part whose drawing this bone reuses. */
  mirrorOf?: string;
}

export interface RigDef {
  id: string;
  name: string;
  icon: string;
  headId: string;
  /** Direction the face looks, for placing eyes (default +Z). */
  eyeDir?: V3;
  bones: BoneDef[];
}

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];

const biped: RigDef = {
  id: 'biped',
  name: 'Biped',
  icon: '🧍',
  headId: 'head',
  // one bone per limb: short and stout (Split a bone in Rig mode for elbows and knees)
  bones: [
    { id: 'body', name: 'Body', start: [0, 0.44, 0], end: [0, 1.0, 0], side: X, width: 0.82, anchor: true },
    { id: 'head', name: 'Head', parent: 'body', start: [0, 1.01, 0], end: [0, 1.56, 0], side: X, width: 0.6 },
    { id: 'arm', name: 'Arm', parent: 'body', start: [0.34, 0.88, 0], end: [0.58, 0.58, 0], side: Y, width: 0.22, widthEnd: 0.2, mirror: true },
    { id: 'leg', name: 'Leg', parent: 'body', start: [0.2, 0.48, 0], end: [0.21, 0.12, 0], side: X, width: 0.29, widthEnd: 0.27, mirror: true },
  ],
};

const quadruped: RigDef = {
  id: 'quadruped',
  name: 'Quadruped',
  icon: '🐕',
  headId: 'head',
  bones: [
    { id: 'body', name: 'Body', start: [0, 0.64, -0.46], end: [0, 0.68, 0.46], side: Y, width: 0.66, anchor: true },
    { id: 'head', name: 'Head', parent: 'body', start: [0, 0.78, 0.42], end: [0, 1.12, 0.8], side: Y, width: 0.52 },
    { id: 'tail', name: 'Tail', parent: 'body', start: [0, 0.72, -0.52], end: [0, 0.98, -0.86], side: Y, width: 0.14 },
    { id: 'frontLeg', name: 'Front leg', parent: 'body', start: [0.21, 0.56, 0.32], end: [0.22, 0.12, 0.35], side: Z, width: 0.24, widthEnd: 0.22, mirror: true },
    { id: 'backLeg', name: 'Back leg', parent: 'body', start: [0.21, 0.56, -0.34], end: [0.22, 0.12, -0.36], side: Z, width: 0.26, widthEnd: 0.23, mirror: true },


  ],
};

const bird: RigDef = {
  id: 'bird',
  name: 'Bird',
  icon: '🐦',
  headId: 'head',
  bones: [
    { id: 'body', name: 'Body', start: [0, 0.47, -0.38], end: [0, 0.75, 0.28], side: Y, width: 0.58, anchor: true },
    { id: 'head', name: 'Head', parent: 'body', start: [0, 0.79, 0.24], end: [0, 1.21, 0.36], side: Z, width: 0.42 },
    { id: 'beak', name: 'Beak', parent: 'head', start: [0, 1.03, 0.46], end: [0, 0.99, 0.74], side: Y, width: 0.13, thickness: 0.7, color: '#f2a23a' },
    // one bendy bone per wing, swept gently back
    { id: 'wing', name: 'Wing', parent: 'body', start: [0.22, 0.71, 0.05], end: [1.12, 0.8, -0.14], side: Z, width: 0.42, widthEnd: 0.26, thickness: 0.25, mirror: true, bendy: true, bend: 0.3, bendDir: -1.9 },
    { id: 'tail', name: 'Tail', parent: 'body', start: [0, 0.49, -0.38], end: [0, 0.37, -0.86], side: X, width: 0.34, thickness: 0.28 },
    // short stub legs
    { id: 'leg', name: 'Leg', parent: 'body', start: [0.12, 0.42, 0.02], end: [0.13, 0.06, 0.05], side: Z, width: 0.1, widthEnd: 0.13, mirror: true, color: '#f2a23a' },
  ],
};

const serpent: RigDef = {
  id: 'serpent',
  eyeDir: [0, 1, 0.7],
  name: 'Serpent',
  icon: '🐍',
  headId: 'head',
  // three bendy segments curving opposite ways make the S
  bones: [
    { id: 'seg1', name: 'Neck', start: [0, 0.2, 0.55], end: [0, 0.2, -0.3], side: X, width: 0.34, anchor: true, bendy: true, bend: 0.16 },
    { id: 'head', name: 'Head', parent: 'seg1', start: [0, 0.24, 0.5], end: [0, 0.3, 1.02], side: X, width: 0.42 },
    { id: 'seg2', name: 'Body', parent: 'seg1', start: [0, 0.2, -0.3], end: [0, 0.19, -1.15], side: X, width: 0.32, widthEnd: 0.26, bendy: true, bend: -0.3 },
    { id: 'seg3', name: 'Tail', parent: 'seg2', start: [0, 0.19, -1.15], end: [0, 0.16, -1.85], side: X, width: 0.24, widthEnd: 0.08, bendy: true, bend: 0.26 },
  ],
};

const bug: RigDef = {
  id: 'bug',
  eyeDir: [0, 0.4, 1],
  name: 'Bug',
  icon: '🐞',
  headId: 'head',
  bones: [
    { id: 'body', name: 'Body', start: [0, 0.5, -0.55], end: [0, 0.56, 0.28], side: X, width: 0.6, anchor: true },
    { id: 'head', name: 'Head', parent: 'body', start: [0, 0.56, 0.26], end: [0, 0.62, 0.68], side: X, width: 0.42 },
    { id: 'antenna', name: 'Antenna', parent: 'head', start: [0.08, 0.72, 0.56], end: [0.24, 1.02, 0.86], side: Y, width: 0.05, mirror: true },
    { id: 'legA', name: 'Front leg', parent: 'body', start: [0.18, 0.52, 0.14], end: [0.55, 0.74, 0.32], side: Z, width: 0.09, mirror: true },
    { id: 'footA', name: 'Front foot', parent: 'legA', start: [0.55, 0.74, 0.32], end: [0.78, 0.03, 0.55], side: Z, width: 0.07, mirror: true },
    { id: 'legB', name: 'Middle leg', parent: 'body', start: [0.2, 0.52, -0.12], end: [0.6, 0.74, -0.12], side: Z, width: 0.09, mirror: true },
    { id: 'footB', name: 'Middle foot', parent: 'legB', start: [0.6, 0.74, -0.12], end: [0.88, 0.03, -0.14], side: Z, width: 0.07, mirror: true },
    { id: 'legC', name: 'Back leg', parent: 'body', start: [0.18, 0.52, -0.36], end: [0.55, 0.74, -0.55], side: Z, width: 0.09, mirror: true },
    { id: 'footC', name: 'Back foot', parent: 'legC', start: [0.55, 0.74, -0.55], end: [0.78, 0.03, -0.82], side: Z, width: 0.07, mirror: true },
  ],
};

function mirrorV(v: V3): V3 {
  return [-v[0], v[1], v[2]];
}

export const RIGS: RigDef[] = [biped, quadruped, bird, serpent, bug];

export function getRig(id: string): RigDef {
  return RIGS.find((r) => r.id === id) ?? RIGS[0];
}

// ---------------------------------------------------------------------------
// Editable rigs. A creature owns a copy of its skeleton (RigState) so it can be
// reshaped; `mirror: true` defs are expanded into L/R twins for the scene.

export interface RigState {
  /** template id, or `saved:<name>` */
  base: string;
  name: string;
  headId: string;
  eyeDir?: V3;
  bones: BoneDef[];
}

/** A bone as it exists in the scene, after mirroring. */
export interface ExpandedBone extends BoneDef {
  /** id of the definition this came from */
  baseId: string;
  /** +1 left twin, -1 right twin, 0 unmirrored */
  sideSign: 1 | -1 | 0;
}

export interface ExpandedRig {
  headId: string;
  eyeDir?: V3;
  bones: ExpandedBone[];
}

export function rigFromTemplate(t: RigDef): RigState {
  return { base: t.id, name: t.name, headId: t.headId, eyeDir: t.eyeDir, bones: structuredClone(t.bones) };
}

export function expandRig(rig: RigState): ExpandedRig {
  const mirrored = new Set(rig.bones.filter((b) => b.mirror).map((b) => b.id));
  const out: ExpandedBone[] = [];
  const mapParent = (p: string | undefined, suffix: 'L' | 'R') => (p && mirrored.has(p) ? p + suffix : p);
  for (const b of rig.bones) {
    if (!b.mirror) {
      // a single bone hanging off a mirrored pair attaches to one side (left by default)
      const parent = b.parent && mirrored.has(b.parent) ? b.parent + 'L' : b.parent;
      out.push({ ...b, parent, baseId: b.id, sideSign: 0 });
      continue;
    }
    out.push({ ...b, id: b.id + 'L', name: b.name + ' (L)', parent: mapParent(b.parent, 'L'), baseId: b.id, sideSign: 1 });
    out.push({
      ...b,
      id: b.id + 'R',
      name: b.name + ' (R)',
      parent: mapParent(b.parent, 'R'),
      start: mirrorV(b.start),
      end: mirrorV(b.end),
      side: mirrorV(b.side),
      mirrorOf: b.id + 'L',
      baseId: b.id,
      sideSign: -1,
    });
  }
  // parents before children, dropping anything whose parent no longer exists
  const ids = new Set(out.map((b) => b.id));
  const placed = new Set<string>();
  const sorted: ExpandedBone[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const b of out) {
      if (placed.has(b.id)) continue;
      if (!b.parent || placed.has(b.parent) || !ids.has(b.parent)) {
        sorted.push(b.parent && !ids.has(b.parent) ? { ...b, parent: undefined } : b);
        placed.add(b.id);
        progress = true;
      }
    }
  }
  return { headId: rig.headId, eyeDir: rig.eyeDir, bones: sorted };
}

// ---------------------------------------------------------------------------
// Editing operations. They mutate the RigState and report which parts
// (drawing/color slots, keyed by scene id) should be created or copied.

export interface PartCopy {
  from: string;
  to: string;
}

function findDef(rig: RigState, sceneId: string) {
  const ex = expandRig(rig).bones.find((b) => b.id === sceneId);
  if (!ex) return null;
  const def = rig.bones.find((b) => b.id === ex.baseId)!;
  return { ex, def };
}

function uniqueId(rig: RigState, base: string): string {
  const taken = new Set(rig.bones.flatMap((b) => [b.id, b.id + 'L', b.id + 'R']));
  const stem = base.replace(/\d+$/, '');
  for (let n = 2; ; n++) if (!taken.has(stem + n) && !taken.has(stem + n + 'L')) return stem + n;
}

/** Definition ids of a bone and everything hanging off it (both twins for pairs). */
export function subtreeDefs(rig: RigState, sceneId: string): Set<string> {
  const bones = expandRig(rig).bones;
  const start = bones.find((b) => b.id === sceneId);
  if (!start) return new Set();
  const roots = new Set([sceneId]);
  if (start.sideSign !== 0) roots.add(start.baseId + (start.sideSign === 1 ? 'R' : 'L'));
  const scene = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of bones) if (b.parent && scene.has(b.parent) && !scene.has(b.id)) (scene.add(b.id), (grew = true));
  }
  return new Set(bones.filter((b) => scene.has(b.id)).map((b) => b.baseId));
}

/** The scene ids that own drawings (parts) for a definition. */
export function partIds(def: BoneDef): string[] {
  return def.mirror ? [def.id + 'L', def.id + 'R'] : [def.id];
}
function partSrc(def: BoneDef): string {
  return def.mirror ? def.id + 'L' : def.id;
}

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const round3 = (a: V3): V3 => a.map((v) => Math.round(v * 1000) / 1000) as V3;

/**
 * Move a joint in the rest pose. `kind` 'end' moves the bone's tip; 'start'
 * moves the whole bone. Everything hanging below follows. `delta` is in world
 * space for the scene bone that was grabbed; mirrored twins follow.
 */
export function moveJoint(rig: RigState, sceneId: string, kind: 'start' | 'end', delta: V3, lockCenter = false) {
  const bones = expandRig(rig).bones;
  const grabbed = bones.find((b) => b.id === sceneId);
  if (!grabbed) return;
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const moved = new Set<string>();
  // with symmetry locked, bones sitting on the centre line stay on it
  const centred = new Map<string, [boolean, boolean]>();
  if (lockCenter) {
    for (const d of rig.bones) if (!d.mirror) centred.set(d.id, [Math.abs(d.start[0]) < 0.02, Math.abs(d.end[0]) < 0.02]);
  }
  const relock = () => {
    for (const [id, [s, e]] of centred) {
      const d = byId.get(id)!;
      if (s) d.start = [0, d.start[1], d.start[2]];
      if (e) d.end = [0, d.end[1], d.end[2]];
    }
  };

  // scene bones below the grabbed one on this side, and on the twin side
  const below = (rootId: string) => {
    const set = new Set([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const b of bones) if (b.parent && set.has(b.parent) && !set.has(b.id)) (set.add(b.id), (grew = true));
    }
    set.delete(rootId);
    return bones.filter((b) => set.has(b.id));
  };
  const shift = (b: ExpandedBone, d: V3, sign: number) => {
    const def = byId.get(b.baseId)!;
    if (moved.has(def.id)) return;
    moved.add(def.id);
    // defs live on the +X side; convert a right-twin delta back
    const dd: V3 = sign === -1 ? mirrorV(d) : d;
    def.start = round3(add3(def.start, dd));
    def.end = round3(add3(def.end, dd));
  };

  const def = byId.get(grabbed.baseId)!;
  const own: V3 = grabbed.sideSign === -1 ? mirrorV(delta) : delta;
  if (kind === 'start') def.start = round3(add3(def.start, own));
  def.end = round3(add3(def.end, own));
  moved.add(def.id);
  for (const b of below(grabbed.id)) shift(b, delta, b.sideSign);
  if (grabbed.sideSign !== 0) {
    const twin = grabbed.baseId + (grabbed.sideSign === 1 ? 'R' : 'L');
    for (const b of below(twin)) shift(b, mirrorV(delta), b.sideSign);
  }
  relock();
}

/**
 * Resize a bone in the rest pose: `kLen` stretches it along its length (from
 * its base), `kWidth` fattens its default shape. Limbs hanging off it keep
 * their place on it: one on the tip rides the tip, one halfway up stays halfway.
 */
export function scaleBone(rig: RigState, sceneId: string, kLen: number, kWidth: number) {
  const f = findDef(rig, sceneId);
  if (!f) return;
  const d = f.def;
  const axis = sub3(d.end, d.start);
  const len = len3(axis);
  if (len < 1e-6) return;
  const u = scale3(axis, 1 / len);
  d.end = round3(add3(d.start, scale3(axis, kLen)));
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  d.width = r3(Math.max(0.01, d.width * kWidth));
  if (d.widthEnd !== undefined) d.widthEnd = r3(Math.max(0.01, d.widthEnd * kWidth));
  const kids = (id: string) => rig.bones.filter((b) => b.parent === id);
  const shiftTree = (b: BoneDef, by: V3) => {
    b.start = round3(add3(b.start, by));
    b.end = round3(add3(b.end, by));
    for (const k of kids(b.id)) shiftTree(k, by);
  };
  for (const c of kids(d.id)) {
    const rel = sub3(c.start, d.start);
    const t = rel[0] * u[0] + rel[1] * u[1] + rel[2] * u[2];
    const lateral = sub3(rel, scale3(u, t));
    const next = add3(add3(d.start, scale3(u, t * kLen)), scale3(lateral, kWidth));
    shiftTree(c, sub3(next, c.start));
  }
}

/**
 * Sprout a new limb from the side of a bone: two segments, or a single bone
 * with `segments: 1`. With `symmetric`, it comes as a mirrored pair.
 */
export function addLimb(rig: RigState, sceneId: string, symmetric: boolean, segments: 1 | 2 = 2): PartCopy[] {
  const f = findDef(rig, sceneId);
  if (!f) return [];
  const { ex } = f;
  const mid = scale3(add3(ex.start, ex.end), 0.5);
  const outward = mid[0] >= 0 ? 1 : -1;
  const attach: V3 = [mid[0] + outward * ex.width * 0.42, mid[1], mid[2]];
  const w = Math.max(0.06, Math.min(0.2, ex.width * 0.35));
  const s1: V3 = attach;
  const e1: V3 = add3(s1, [outward * 0.3, -0.12, 0]);
  const e2: V3 = add3(e1, [outward * 0.26, -0.12, 0]);

  const pairParent = ex.sideSign !== 0;
  const mirror = pairParent || (symmetric && Math.abs(attach[0]) > 0.02);
  // pair defs live on +X; a single limb on a paired bone attaches to that exact side
  const toDef = (v: V3): V3 => (mirror && v[0] < 0 ? mirrorV(v) : v);
  const parent = pairParent && mirror ? ex.baseId : ex.id;
  const src = partSrc(f.def);
  if (segments === 1) {
    const id = uniqueId(rig, 'bone');
    const end = add3(s1, [outward * 0.4, -0.16, 0]);
    rig.bones.push({ id, name: 'Bone', parent, start: round3(toDef(s1)), end: round3(toDef(end)), side: [0, 1, 0], width: w, mirror });
    return [{ from: src, to: mirror ? id + 'L' : id }];
  }
  const id1 = uniqueId(rig, 'limb');
  rig.bones.push({ id: id1, name: 'Limb', parent, start: round3(toDef(s1)), end: round3(toDef(e1)), side: [0, 1, 0], width: w, mirror });
  const id2 = uniqueId(rig, 'limb');
  rig.bones.push({ id: id2, name: 'Limb tip', parent: id1, start: round3(toDef(e1)), end: round3(toDef(e2)), side: [0, 1, 0], width: w * 0.85, mirror });
  return [id1, id2].map((id) => ({ from: src, to: mirror ? id + 'L' : id }));
}

/** Result of splitting a bone: which drawings to cut, and where. */
export interface SplitResult {
  /** [lower part id, upper (new) part id] pairs, one per side */
  pairs: [string, string][];
  /** height (along the bone) of the cut, in the bone's drawing coordinates */
  at: number;
}

/**
 * Split a bone at its middle into two jointed halves. Anything that hung off
 * the far half moves to the new bone; a bendy bone shares its curve between them.
 */
export function splitBone(rig: RigState, sceneId: string): SplitResult | null {
  const f = findDef(rig, sceneId);
  if (!f) return null;
  const d = f.def;
  const dir = sub3(d.end, d.start);
  const len = len3(dir);
  if (len < 0.04) return null;
  const mid = round3(scale3(add3(d.start, d.end), 0.5));
  const w0 = d.width, w1 = d.widthEnd ?? d.width;
  const wMid = Math.round(((w0 + w1) / 2) * 1000) / 1000;
  const nid = uniqueId(rig, d.id.replace(/\d+$/, ''));
  const upper: BoneDef = {
    ...structuredClone(d),
    id: nid,
    name: d.name.replace(/ \d+$/, '') + ' 2',
    parent: d.id,
    start: mid,
    end: [...d.end],
    width: wMid,
    widthEnd: w1,
    anchor: false,
  };
  if (d.bendy && d.bend) {
    upper.bend = d.bend / 2;
    d.bend = d.bend / 2;
  }
  d.end = mid;
  d.widthEnd = wMid;

  // children attached past the middle now hang off the new bone
  // how far along the (original) bone a point sits: 0 = base, 1 = tip
  const along = (p: V3) => ((p[0] - d.start[0]) * dir[0] + (p[1] - d.start[1]) * dir[1] + (p[2] - d.start[2]) * dir[2]) / (len * len);
  for (const c of rig.bones) {
    if (c === upper) continue;
    if (c.parent === d.id) {
      if (along(c.start) > 0.5) c.parent = nid;
    } else if (!c.mirror && d.mirror && (c.parent === d.id + 'L' || c.parent === d.id + 'R')) {
      // a single bone hanging off one twin: measure it on the +X side where `d` lives
      const side = c.parent.slice(-1);
      if (along(side === 'R' ? mirrorV(c.start) : c.start) > 0.5) c.parent = nid + side;
    }
  }
  rig.bones.splice(rig.bones.indexOf(d) + 1, 0, upper);
  const lower = partIds(d), top = partIds(upper);
  return { pairs: lower.map((id, i) => [id, top[i]] as [string, string]), at: len / 2 };
}

/** Add one segment continuing on from the tip of a bone (a hand, a tail tip...). */
export function extendBone(rig: RigState, sceneId: string): PartCopy[] {
  const f = findDef(rig, sceneId);
  if (!f) return [];
  const { def } = f;
  const dir = sub3(def.end, def.start);
  const l = len3(dir) || 1;
  const segLen = Math.max(0.15, l * 0.6);
  const id = uniqueId(rig, def.id.replace(/[LR]$/, ''));
  const mirror = !!def.mirror;
  // pairs extend both twins; a single bone on a pair extends that side only
  rig.bones.push({
    id,
    name: def.name.replace(/ tip$/, '') + ' tip',
    parent: def.id,
    start: [...def.end],
    end: round3(add3(def.end, scale3(dir, segLen / l))),
    side: [...def.side],
    roll: def.roll,
    width: def.width * 0.8,
    mirror,
  });
  return [{ from: partSrc(def), to: mirror ? id + 'L' : id }];
}

/** Copy a bone and everything hanging off it, nudged down so it's visible. */
export function duplicateLimb(rig: RigState, sceneId: string): PartCopy[] {
  const f = findDef(rig, sceneId);
  if (!f || !f.def.parent) return [];
  const defs = subtreeDefs(rig, sceneId);
  const idMap = new Map<string, string>();
  const copies: BoneDef[] = [];
  const offset: V3 = [0, -0.18, 0];
  for (const d of rig.bones) {
    if (!defs.has(d.id)) continue;
    const nid = uniqueId({ ...rig, bones: [...rig.bones, ...copies] }, d.id);
    idMap.set(d.id, nid);
    copies.push({ ...structuredClone(d), id: nid, start: round3(add3(d.start, offset)), end: round3(add3(d.end, offset)) });
  }
  const remap = (p: string | undefined) => {
    if (!p) return p;
    if (idMap.has(p)) return idMap.get(p);
    const m = p.match(/^(.*)([LR])$/); // single bone attached to one twin of a copied pair
    if (m && idMap.has(m[1])) return idMap.get(m[1]) + m[2];
    return p;
  };
  for (const c of copies) c.parent = remap(c.parent);
  rig.bones.push(...copies);
  const parts: PartCopy[] = [];
  for (const d of rig.bones.filter((b) => defs.has(b.id))) {
    const nd = copies.find((c) => c.id === idMap.get(d.id))!;
    const from = partIds(d), to = partIds(nd);
    to.forEach((t, i) => parts.push({ from: from[i] ?? from[0], to: t }));
  }
  return parts;
}

/** Remove a bone and everything hanging off it. Returns removed definition ids. */
export function deleteLimb(rig: RigState, sceneId: string): BoneDef[] {
  const f = findDef(rig, sceneId);
  if (!f || !f.def.parent) return [];
  const defs = subtreeDefs(rig, sceneId);
  const removed = rig.bones.filter((b) => defs.has(b.id));
  rig.bones = rig.bones.filter((b) => !defs.has(b.id));
  return removed;
}

/** Split a mirrored pair (and everything below it) into independent left and right bones. */
export function unlinkPair(rig: RigState, sceneId: string): PartCopy[] {
  const f = findDef(rig, sceneId);
  if (!f || !f.def.mirror) return [];
  const defs = subtreeDefs(rig, sceneId);
  const mirroredIds = new Set(rig.bones.filter((b) => b.mirror).map((b) => b.id));
  const out: BoneDef[] = [];
  const parts: PartCopy[] = [];
  for (const d of rig.bones) {
    if (!defs.has(d.id) || !d.mirror) {
      out.push(d);
      continue;
    }
    // scene ids stay the same (armL / armR), so drawings and poses carry over
    const parentFor = (s: 'L' | 'R') => (d.parent && mirroredIds.has(d.parent) ? d.parent + s : d.parent);
    out.push({ ...d, id: d.id + 'L', name: d.name + ' (L)', mirror: false, parent: parentFor('L') });
    out.push({
      ...d,
      id: d.id + 'R',
      name: d.name + ' (R)',
      mirror: false,
      parent: parentFor('R'),
      start: mirrorV(d.start),
      end: mirrorV(d.end),
      side: mirrorV(d.side),
      roll: d.roll ? -d.roll : undefined,
    });
    parts.push({ from: d.id + 'L', to: d.id + 'R' });
  }
  rig.bones = out;
  return parts;
}

// ---------------------------------------------------------------------------
// saved rigs (skeleton only) in localStorage

const SAVED_KEY = 'creature-creator/rigs';

export function savedRigs(): RigState[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]') as RigState[];
  } catch {
    return [];
  }
}

export function saveRig(rig: RigState, name: string) {
  const list = savedRigs().filter((r) => r.name !== name);
  list.push({ ...structuredClone(rig), name, base: 'saved:' + name });
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked */
  }
}

export function deleteSavedRig(name: string) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(savedRigs().filter((r) => r.name !== name)));
  } catch {
    /* ignore */
  }
}

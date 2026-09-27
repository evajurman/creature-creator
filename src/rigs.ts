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
  width: number;
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
  bones: [
    { id: 'body', name: 'Body', start: [0, 0.92, 0], end: [0, 1.45, 0], side: X, width: 0.72, anchor: true },
    { id: 'head', name: 'Head', parent: 'body', start: [0, 1.46, 0], end: [0, 2.0, 0], side: X, width: 0.56 },
    { id: 'arm', name: 'Upper arm', parent: 'body', start: [0.3, 1.36, 0], end: [0.58, 1.08, 0], side: Y, width: 0.19, mirror: true },
    { id: 'forearm', name: 'Forearm', parent: 'arm', start: [0.58, 1.08, 0], end: [0.8, 0.8, 0], side: Y, width: 0.17, mirror: true },
    { id: 'thigh', name: 'Thigh', parent: 'body', start: [0.17, 0.95, 0], end: [0.19, 0.52, 0], side: X, width: 0.24, mirror: true },
    { id: 'shin', name: 'Shin', parent: 'thigh', start: [0.19, 0.52, 0], end: [0.2, 0.12, 0], side: X, width: 0.2, mirror: true },
    { id: 'foot', name: 'Foot', parent: 'shin', start: [0.2, 0.09, -0.05], end: [0.2, 0.09, 0.28], side: X, width: 0.2, thickness: 0.75, mirror: true },
  ],
};

const quadruped: RigDef = {
  id: 'quadruped',
  name: 'Quadruped',
  icon: '🐕',
  headId: 'head',
  bones: [
    { id: 'body', name: 'Body', start: [0, 0.9, -0.55], end: [0, 0.95, 0.55], side: Y, width: 0.6, anchor: true },
    { id: 'head', name: 'Head', parent: 'body', start: [0, 1.05, 0.5], end: [0, 1.4, 0.92], side: Y, width: 0.46 },
    { id: 'tail', name: 'Tail', parent: 'body', start: [0, 1.0, -0.6], end: [0, 1.3, -1.02], side: Y, width: 0.13 },
    { id: 'frontLeg', name: 'Front leg', parent: 'body', start: [0.2, 0.82, 0.38], end: [0.22, 0.44, 0.42], side: Z, width: 0.2, mirror: true },
    { id: 'frontPaw', name: 'Front paw', parent: 'frontLeg', start: [0.22, 0.44, 0.42], end: [0.22, 0.06, 0.46], side: Z, width: 0.17, mirror: true },
    { id: 'backLeg', name: 'Back leg', parent: 'body', start: [0.2, 0.82, -0.4], end: [0.22, 0.44, -0.46], side: Z, width: 0.24, mirror: true },
    { id: 'backPaw', name: 'Back paw', parent: 'backLeg', start: [0.22, 0.44, -0.46], end: [0.22, 0.06, -0.4], side: Z, width: 0.17, mirror: true },
  ],
};

const bird: RigDef = {
  id: 'bird',
  name: 'Bird',
  icon: '🐦',
  headId: 'head',
  bones: [
    { id: 'body', name: 'Body', start: [0, 0.72, -0.38], end: [0, 1.0, 0.28], side: Y, width: 0.58, anchor: true },
    { id: 'head', name: 'Head', parent: 'body', start: [0, 1.04, 0.24], end: [0, 1.46, 0.36], side: Z, width: 0.42 },
    { id: 'beak', name: 'Beak', parent: 'head', start: [0, 1.28, 0.46], end: [0, 1.24, 0.74], side: Y, width: 0.13, thickness: 0.7, color: '#f2a23a' },
    { id: 'wing', name: 'Wing', parent: 'body', start: [0.22, 0.96, 0.05], end: [0.78, 0.98, -0.1], side: Z, width: 0.42, thickness: 0.25, mirror: true },
    { id: 'wingtip', name: 'Wing tip', parent: 'wing', start: [0.78, 0.98, -0.1], end: [1.25, 1.0, -0.26], side: Z, width: 0.32, thickness: 0.22, mirror: true },
    { id: 'tail', name: 'Tail', parent: 'body', start: [0, 0.74, -0.38], end: [0, 0.62, -0.86], side: X, width: 0.34, thickness: 0.28 },
    { id: 'leg', name: 'Leg', parent: 'body', start: [0.12, 0.66, 0], end: [0.14, 0.34, 0.03], side: Z, width: 0.11, mirror: true, color: '#f2a23a' },
    { id: 'shin', name: 'Shin', parent: 'leg', start: [0.14, 0.34, 0.03], end: [0.14, 0.06, 0.05], side: Z, width: 0.07, mirror: true, color: '#f2a23a' },
    { id: 'foot', name: 'Foot', parent: 'shin', start: [0.14, 0.04, -0.04], end: [0.14, 0.04, 0.24], side: X, width: 0.2, thickness: 0.4, mirror: true, color: '#f2a23a' },
  ],
};

const serpent: RigDef = {
  id: 'serpent',
  eyeDir: [0, 1, 0.7],
  name: 'Serpent',
  icon: '🐍',
  headId: 'head',
  bones: [
    { id: 'seg1', name: 'Neck', start: [0, 0.2, 0.55], end: [0, 0.2, 0.08], side: X, width: 0.34, anchor: true },
    { id: 'head', name: 'Head', parent: 'seg1', start: [0, 0.24, 0.5], end: [0, 0.3, 1.02], side: X, width: 0.42 },
    { id: 'seg2', name: 'Body 1', parent: 'seg1', start: [0, 0.2, 0.08], end: [0, 0.2, -0.4], side: X, width: 0.34 },
    { id: 'seg3', name: 'Body 2', parent: 'seg2', start: [0, 0.2, -0.4], end: [0, 0.2, -0.88], side: X, width: 0.3 },
    { id: 'seg4', name: 'Body 3', parent: 'seg3', start: [0, 0.19, -0.88], end: [0, 0.18, -1.36], side: X, width: 0.24 },
    { id: 'seg5', name: 'Tail', parent: 'seg4', start: [0, 0.18, -1.36], end: [0, 0.16, -1.86], side: X, width: 0.14 },
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

/** Expand `mirror: true` bones into explicit left/right pairs. */
function expand(rig: RigDef): RigDef {
  const mirrored = new Set(rig.bones.filter((b) => b.mirror).map((b) => b.id));
  const bones: BoneDef[] = [];
  const mapParent = (p: string | undefined, suffix: string) => (p && mirrored.has(p) ? p + suffix : p);
  for (const b of rig.bones) {
    if (!b.mirror) {
      bones.push(b);
      continue;
    }
    bones.push({ ...b, id: b.id + 'L', name: b.name + ' (L)', parent: mapParent(b.parent, 'L') });
    bones.push({
      ...b,
      id: b.id + 'R',
      name: b.name + ' (R)',
      parent: mapParent(b.parent, 'R'),
      start: mirrorV(b.start),
      end: mirrorV(b.end),
      side: mirrorV(b.side),
      mirrorOf: b.id + 'L',
    });
  }
  return { ...rig, bones };
}

export const RIGS: RigDef[] = [biped, quadruped, bird, serpent, bug].map(expand);

export function getRig(id: string): RigDef {
  return RIGS.find((r) => r.id === id) ?? RIGS[0];
}

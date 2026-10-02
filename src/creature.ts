import * as THREE from 'three';
import { bvhFor, exactDistance, sharedNormals } from './distance';
import { buildSkin, paintSkin, type SkinPart } from './skin';
import { buildInflatedGeometry, defaultOutline, getMeshDetail, type Solid, type Vec2 } from './inflate';
import {
  castsShadow,
  isTextured,
  setFuzzMask,
  setOpacity,
  makeFuzzShells,
  makeMaterial,
  makeOutlineMaterial,
  makeStrayHairs,
  setTextureSpace,
  styleSettings,
  surfaceColor,
  type StyleId,
  type FuzzSpot,
  type StyleSettings,
} from './materials';
import { expandRig, type ExpandedBone, type ExpandedRig, type RigState, type V3 } from './rigs';
import { buildThing, disposeThing, type Thing } from './stuff';

export interface PartState {
  outline: Vec2[] | null;
  thickness: number;
  color: string;
  style?: StyleId;
  /** 1 = solid, lower = see-through */
  opacity?: number;
}

export type EyeStyle = 'googly' | 'flat' | 'bead' | 'dot' | 'button';

export const EYE_STYLES: { id: EyeStyle; name: string }[] = [
  { id: 'googly', name: 'Googly' },
  { id: 'flat', name: 'Sticker' },
  { id: 'bead', name: 'Bead' },
  { id: 'dot', name: 'Dot' },
  { id: 'button', name: 'Button' },
];

export interface EyePair {
  size: number;
  spacing: number;
  height: number;
  /** how far this pair stands off the face, 0..1 (falls back to the old shared `lift`) */
  lift?: number;
}

export type EyeFinish = 'body' | 'gloss' | 'matte' | 'glass';

export interface EyesState {
  enabled: boolean;
  /** one style for every pair */
  style: EyeStyle;
  pairs: EyePair[];
  /** bead / dot / button: what they're made of ('body' = the head's own material) */
  finish?: EyeFinish;
  /** bead / dot / button colour */
  color?: string;
  /** legacy: one stand-off for every pair (now per pair) */
  lift?: number;
}

/** A piece of stuff stuck onto a body part, positioned in that bone's frame. */
export interface Attachment {
  id: string;
  bone: string;
  /** embedded copy, so creature files are self-contained */
  thing: Thing;
  position: V3;
  quaternion: [number, number, number, number];
  scale: V3;
  /** also show a mirrored copy on the twin limb */
  mirror: boolean;
}

export interface CreatureState {
  name?: string;
  /** the creature's own (editable) skeleton */
  rig: RigState;
  style: StyleId;
  parts: Record<string, PartState>;
  /** per-bone rotation relative to the rest pose */
  pose: Record<string, [number, number, number, number]>;
  rootOffset: V3;
  eyes: EyesState;
  /** Smoothly fuse touching parts that share a colour and material. */
  merge?: boolean;
  /** Fillet size for merging, in world units. */
  mergeRadius?: number;
  /** merge parts of the same material even when their colours differ, blending the colours */
  mergeColors?: boolean;
  /** width of the colour fade at blended joins, in world units */
  colorBlend?: number;
  /** rebuild merged groups as one seamless skin when left idle (default on; see setSeamlessMode) */
  seamless?: boolean;
  /** per-material slider values (missing keys use the defaults) */
  materialSettings?: Partial<Record<StyleId, StyleSettings>>;
  attachments?: Attachment[];
  /** legacy: the workbench used to live on the creature; it now belongs to the world */
  workbench?: Thing;
  /** where the creature stands in a multi-creature scene: floor position and facing */
  placement?: Placement;
}

export interface Placement {
  x: number;
  z: number;
  /** rotation about the vertical axis, radians (kept alongside `quat` for older files) */
  yaw: number;
  /** height off the floor (default 0) */
  y?: number;
  /** full 3D turn as a quaternion; when missing, just `yaw` */
  quat?: [number, number, number, number];
  /** overall size (default 1) */
  scale?: number;
}

/** A settled seamless skin and what it was built from. */
interface SkinEntry {
  mesh: THREE.Mesh;
  members: BoneRT[];
  parts: SkinPart[];
  lowPoly: boolean;
  /** colours were baked into the geometry */
  painted: boolean;
  /** colours the paint was made with */
  colorKey: string;
  /** the look it was last dressed in (see dressSkin) */
  lookKey?: string;
}

export interface BoneRT {
  def: ExpandedBone;
  /** id of the part whose drawing/colour this bone uses */
  src: string;
  pivot: THREE.Object3D;
  parent: BoneRT | null;
  length: number;
  restQuat: THREE.Quaternion;
  restWorld: THREE.Matrix4;
  mesh: THREE.Mesh | null;
  meshKey: string;
  tip: THREE.Mesh;
  /** rig mode: handle at the bone's start, shown where a limb attaches */
  startHandle: THREE.Mesh;
  /** rig mode: drag to bend the bone (selected bone only) */
  bendHandle: THREE.Mesh;
  /** true when the bone starts somewhere other than its parent's tip */
  attach: boolean;
  line: THREE.Line;
  guide: THREE.Group;
  /** the bone's frame in the rest pose, relative to the creature: where its textures are laid out */
  restGroup: THREE.Matrix4;
}

const DEFAULT_COLORS = ['#7cc6a4', '#f6a5b5', '#8fb8ec', '#f7c873', '#b9a3e3'];

export function defaultState(rig: RigState, color?: string): CreatureState {
  const body = color ?? DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)];
  const parts: Record<string, PartState> = {};
  for (const b of expandRig(rig).bones) {
    if (b.mirrorOf) continue;
    parts[b.id] = { outline: null, thickness: b.thickness ?? 1, color: b.color ?? body };
  }
  return {
    rig: structuredClone(rig),
    style: 'clay',
    parts,
    pose: {},
    rootOffset: [0, 0, 0],
    merge: true,
    mergeRadius: 0.1,
    eyes: { enabled: true, style: 'bead', pairs: [{ size: 0.5, spacing: 0.5, height: 0.55 }] },
  };
}

/** App-wide seamless joins: always, never, or each creature's own choice. */
export type SeamlessMode = 'on' | 'off' | 'creature';
let seamlessMode: SeamlessMode = 'creature';
export function setSeamlessMode(m: SeamlessMode) {
  seamlessMode = m;
}
/** Seamless skins for low-poly too (off by default: re-faceting a skin changes the low-poly look) */
let seamlessLowPoly = false;
export function setSeamlessLowPoly(on: boolean) {
  seamlessLowPoly = on;
}
function seamlessOn(s: CreatureState): boolean {
  return seamlessMode === 'creature' ? (s.seamless ?? true) : seamlessMode === 'on';
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function cachedGeometry(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) {
    if (geoCache.size > 160) {
      // drop the oldest half; geometries still in use stay alive via their meshes
      const keys = [...geoCache.keys()].slice(0, 80);
      for (const k of keys) geoCache.delete(k);
    }
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

const tipMat = new THREE.MeshBasicMaterial({ color: 0xff6b4a, depthTest: false, transparent: true });
const tipHoverMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true });
const rootMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6, depthTest: false, transparent: true });
const lineMat = new THREE.LineBasicMaterial({ color: 0x3a3340, depthTest: false, transparent: true, opacity: 0.55 });
const outlineLineMat = new THREE.LineBasicMaterial({ color: 0xff6b4a, depthTest: false, transparent: true, opacity: 0.9 });
const planeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
const startMat = new THREE.MeshBasicMaterial({ color: 0x8b5cf6, depthTest: false, transparent: true });
// handle/guide materials are shared by every creature: never dispose them with one
const bendMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, depthTest: false, transparent: true });
for (const m of [tipMat, tipHoverMat, rootMat, lineMat, outlineLineMat, planeMat, startMat, bendMat]) m.userData.shared = true;
const tipGeo = new THREE.SphereGeometry(0.032, 16, 12);
const startGeo = new THREE.BoxGeometry(0.055, 0.055, 0.055);
const bendGeo = new THREE.OctahedronGeometry(0.042);

// ---------------------------------------------------------------------------
// bendy bones: the bone's local frame (X = side, Y = along the bone, Z = out
// of the drawing) is curved into a circular arc. The arc bends toward a
// direction around the bone: 0 = +X (sideways in the drawing plane), pi/2 = +Z.

export interface Bend {
  len: number;
  /** total turn, radians (0 = straight) */
  theta: number;
  /** direction around the bone, radians */
  dir: number;
}

/** A bone's bend. A right twin's frame is its left twin's mirrored through local Z, so its direction mirrors too. */
export function bendOf(def: ExpandedBone, len: number): Bend {
  const theta = def.bendy ? (def.bend ?? 0) * Math.PI : 0;
  const dir = (def.bendDir ?? 0) * (def.sideSign === -1 ? -1 : 1);
  return { len, theta, dir };
}

function bendKey(bd: Bend): string {
  return bd.theta ? `|bend:${bd.len.toFixed(4)}:${bd.theta.toFixed(4)}:${bd.dir.toFixed(4)}` : '';
}

/** The straight in-plane bend: (u, y) with u along the bend direction. */
function planarBend(len: number, theta: number, u: number, y: number): [number, number, number] {
  const s = Math.min(len, Math.max(0, y));
  const over = y - s; // past either end the bone carries on straight along its tangent
  const phi = (theta * s) / len;
  let cu = 0, cy = s;
  if (Math.abs(theta) > 1e-5) {
    const r = len / theta;
    cu = r * (1 - Math.cos(phi));
    cy = r * Math.sin(phi);
  }
  const c = Math.cos(phi), sn = Math.sin(phi);
  // the offset (u, over) turns with the curve: +u -> (cos, -sin), +Y -> (sin, cos)
  return [cu + c * u + sn * over, cy - sn * u + c * over, phi];
}

/** Where the straight-bone point (x, y, z) goes once bent, plus the turn angle there. */
function bendPoint(bd: Bend, x: number, y: number, z: number): [number, number, number, number] {
  if (!bd.theta) return [x, y, z, 0];
  const c = Math.cos(bd.dir), s = Math.sin(bd.dir);
  const u = c * x + s * z; // along the bend direction
  const w = -s * x + c * z; // across it (unchanged by the bend)
  const [u2, y2, phi] = planarBend(bd.len, bd.theta, u, y);
  return [c * u2 - s * w, y2, s * u2 + c * w, phi];
}

/** Turn a direction vector (x, y, z) by the bend's local turn angle `phi`. */
function bendVector(bd: Bend, phi: number, x: number, y: number, z: number): [number, number, number] {
  const c = Math.cos(bd.dir), s = Math.sin(bd.dir);
  const u = c * x + s * z;
  const w = -s * x + c * z;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const u2 = cp * u + sp * y;
  const y2 = -sp * u + cp * y;
  return [c * u2 - s * w, y2, s * u2 + c * w];
}

/** Curve a part's geometry (and its merge spheres) to follow its bent bone. */
function bendGeometry(src: THREE.BufferGeometry, bd: Bend): THREE.BufferGeometry {
  const g = src.clone();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z, phi] = bendPoint(bd, pos.getX(i), pos.getY(i), pos.getZ(i));
    pos.setXYZ(i, x, y, z);
    const [nx, ny, nz] = bendVector(bd, phi, nor.getX(i), nor.getY(i), nor.getZ(i));
    nor.setXYZ(i, nx, ny, nz);
  }
  const solid = src.userData.solid as Solid | undefined;
  if (solid) {
    const sp = Float32Array.from(solid.spheres);
    const zs = new Float32Array(sp.length / 3);
    for (let i = 0; i < sp.length; i += 3) {
      const [x, y, z] = bendPoint(bd, sp[i], sp[i + 1], solid.zs ? solid.zs[i / 3] : 0);
      sp[i] = x;
      sp[i + 1] = y;
      zs[i / 3] = z;
    }
    g.userData = { ...src.userData, solid: { ...solid, spheres: sp, zs }, sharedNormals: undefined };
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** A child's local transform after its parent bone is bent (it rides along the arc). */
function bendChild(bd: Bend, local: THREE.Matrix4): THREE.Matrix4 {
  if (!bd.theta) return local;
  const p = new THREE.Vector3().setFromMatrixPosition(local);
  const s = Math.min(bd.len, Math.max(0, p.y));
  const [u, y, phi] = planarBend(bd.len, bd.theta, 0, s);
  // bend in a frame where the bend direction is +X, then turn back
  const toDir = new THREE.Matrix4().makeRotationY(-bd.dir);
  const planar = new THREE.Matrix4().makeRotationZ(-phi).setPosition(u, y, 0);
  const arc = toDir.clone().multiply(planar).multiply(toDir.clone().invert());
  return arc.multiply(new THREE.Matrix4().makeTranslation(0, -s, 0)).multiply(local);
}

/** Points along a (possibly bent) bone, for the skeleton line. */
function bonePoints(bd: Bend): THREE.Vector3[] {
  const n = bd.theta ? 16 : 1;
  return Array.from({ length: n + 1 }, (_, i) => {
    const [x, y, z] = bendPoint(bd, 0, (bd.len * i) / n, 0);
    return new THREE.Vector3(x, y, z);
  });
}

/** Where a bone's middle sits (the bend handle). */
function bendMid(bd: Bend): THREE.Vector3 {
  const [x, y, z] = bendPoint(bd, 0, bd.len / 2, 0);
  return new THREE.Vector3(x, y, z);
}

/**
 * The bend that puts a bone's middle at local point `p`: direction from where
 * it sits around the bone, amount from how far it's pulled off the straight line.
 */
export function bendFromMid(len: number, p: THREE.Vector3): { bend: number; dir: number } {
  const off = Math.hypot(p.x, p.z);
  const dir = Math.atan2(p.z, p.x);
  // sideways offset of an arc's midpoint: len * (1 - cos(theta/2)) / theta, rising to theta ~= 2.33
  const sag = (theta: number) => (theta < 1e-4 ? (len * theta) / 8 : (len * (1 - Math.cos(theta / 2))) / theta);
  let lo = 0, hi = 2.33;
  if (off >= sag(hi)) return { bend: hi / Math.PI, dir };
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sag(mid) < off) lo = mid;
    else hi = mid;
  }
  return { bend: (lo + hi) / 2 / Math.PI, dir };
}

/** Rest-pose world frame of a bone: X = drawing side, Y = along the bone, origin at its start. */
function restFrame(def: ExpandedBone) {
  const start = new THREE.Vector3(...def.start);
  const dir = new THREE.Vector3(...def.end).sub(start);
  const length = Math.max(dir.length(), 1e-3);
  dir.normalize();
  const side = new THREE.Vector3(...def.side);
  side.addScaledVector(dir, -side.dot(dir));
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0).addScaledVector(dir, -dir.x);
  if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
  side.normalize();
  // roll: turn the drawing about the bone. A right twin is its left twin's
  // mirror image, so it turns the other way
  if (def.roll) side.applyAxisAngle(dir, def.roll * (def.sideSign === -1 ? -1 : 1));
  const normal = new THREE.Vector3().crossVectors(side, dir).normalize();
  return { length, world: new THREE.Matrix4().makeBasis(side, dir, normal).setPosition(start) };
}

/** Where a bone's (possibly curved) tip sits in the rest pose. */
export function bentTip(def: ExpandedBone): THREE.Vector3 {
  const { length, world } = restFrame(def);
  const [x, y, z] = bendPoint(bendOf(def, length), 0, length, 0);
  return new THREE.Vector3(x, y, z).applyMatrix4(world);
}

/**
 * The end point that puts a bendy bone's curved tip at `target`, keeping its
 * bend. The tip lies off the straight line from start to end, so moving the
 * end by the pointer's motion would send the tip somewhere else.
 */
export function endForTip(def: ExpandedBone, target: THREE.Vector3): THREE.Vector3 {
  const start = new THREE.Vector3(...def.start);
  const want = target.clone().sub(start);
  let end = new THREE.Vector3(...def.end);
  if (want.lengthSq() < 1e-8) return end;
  // the tip's chord scales with the bone and turns with it; the drawing side
  // re-squares against each new direction, so settle it in a few passes
  for (let i = 0; i < 8; i++) {
    const tip = bentTip({ ...def, end: end.toArray() as V3 }).sub(start);
    if (tip.lengthSq() < 1e-10) break;
    const q = new THREE.Quaternion().setFromUnitVectors(tip.clone().normalize(), want.clone().normalize());
    const len = end.distanceTo(start) * (want.length() / tip.length());
    end = end.sub(start).applyQuaternion(q).setLength(len).add(start);
  }
  return end;
}
const rootGeo = new THREE.BoxGeometry(0.07, 0.07, 0.07);

export class Creature {
  /** placement in the scene (floor position + facing); holds `group` */
  readonly root = new THREE.Group();
  /** the creature itself; its position is the pose's root offset */
  readonly group = new THREE.Group();
  rig: ExpandedRig;
  readonly bones = new Map<string, BoneRT>();
  readonly list: BoneRT[] = [];
  readonly rootHandle: THREE.Mesh;
  private eyes = new THREE.Group();
  private eyesKey = '';
  state: CreatureState;
  selected: string | null = null;
  private drawFocus: string | null = null;
  private mergeDirty = true;
  // seamless skins: built when idle, thrown away on any change
  private skins: SkinEntry[] = [];
  /** shape the current (or pending) skin was built for; see skinShapeKey */
  private skinKey = '';
  private skinVersion = 0;
  skinState: 'none' | 'building' | 'ready' = 'none';
  /** when the shape or pose last changed (performance.now) */
  lastChange = performance.now();
  /** eye spots in head-local space, for keeping felt fuzz off them */
  private eyeSpots: FuzzSpot[] = [];
  /** rig editing shows the rest pose and joint handles */
  private rigMode = false;
  private attached = new Map<string, { key: string; main: THREE.Group; twin: THREE.Group | null; bone: BoneRT; twinBone: BoneRT | null }>();

  constructor(state: CreatureState) {
    this.state = state;
    this.root.add(this.group);
    this.rig = expandRig(state.rig);
    this.ensureParts();
    this.buildSkeleton();
    this.rootHandle = new THREE.Mesh(rootGeo, rootMat);
    this.rootHandle.renderOrder = 1000;
    this.rootHandle.userData.handle = 'root';
    this.list[0].pivot.parent!.add(this.rootHandle);
    this.rootHandle.position.copy(this.list[0].pivot.position);
    this.sync();
  }

  // -------------------------------------------------------------------------
  // skeleton

  /** Every drawable bone needs a part slot (new limbs start from their parent's look). */
  private ensureParts() {
    const fallback = Object.values(this.state.parts)[0] ?? { outline: null, thickness: 1, color: DEFAULT_COLORS[0] };
    for (const b of this.rig.bones) {
      if (b.mirrorOf || this.state.parts[b.id]) continue;
      const parentPart = b.parent ? this.state.parts[this.rig.bones.find((o) => o.id === b.parent)?.mirrorOf ?? b.parent] : null;
      const like = parentPart ?? fallback;
      this.state.parts[b.id] = { outline: null, thickness: b.thickness ?? 1, color: b.color ?? like.color, style: like.style };
    }
  }

  private buildSkeleton() {
    for (const def of this.rig.bones) {
      const { length, world: restWorld } = restFrame(def);
      const parent = def.parent ? this.bones.get(def.parent)! : null;
      let local = parent ? parent.restWorld.clone().invert().multiply(restWorld) : restWorld.clone();
      // children of a bendy bone ride along its curve
      if (parent) local = bendChild(bendOf(parent.def, parent.length), local);
      const pivot = new THREE.Object3D();
      const scale = new THREE.Vector3();
      local.decompose(pivot.position, pivot.quaternion, scale);
      pivot.userData.boneId = def.id;
      (parent ? parent.pivot : this.group).add(pivot);

      const bd = bendOf(def, length);
      const tipAt = bendPoint(bd, 0, length, 0);
      const tip = new THREE.Mesh(tipGeo, tipMat);
      tip.position.set(tipAt[0], tipAt[1], tipAt[2]);
      tip.renderOrder = 1000;
      tip.userData.handle = def.id;
      tip.userData.kind = 'end';
      pivot.add(tip);

      const startHandle = new THREE.Mesh(startGeo, startMat);
      startHandle.renderOrder = 1000;
      startHandle.userData.handle = def.id;
      startHandle.userData.kind = 'start';
      startHandle.visible = false;
      pivot.add(startHandle);
      const attach = !parent || new THREE.Vector3(...def.start).distanceTo(new THREE.Vector3(...parent.def.end)) > 0.02;

      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(bonePoints(bd)), lineMat);

      // rig mode: drag this to bend the bone (shown on the selected bone)
      const bendHandle = new THREE.Mesh(bendGeo, bendMat);
      bendHandle.position.copy(bendMid(bd));
      bendHandle.renderOrder = 1000;
      bendHandle.userData.handle = def.id;
      bendHandle.userData.kind = 'bend';
      bendHandle.visible = false;
      pivot.add(bendHandle);
      line.renderOrder = 999;
      pivot.add(line);

      const guide = new THREE.Group();
      guide.visible = false;
      pivot.add(guide);

      const rt: BoneRT = {
        def,
        src: def.mirrorOf ?? def.id,
        pivot,
        parent,
        length,
        restQuat: pivot.quaternion.clone(),
        restWorld,
        mesh: null,
        meshKey: '',
        tip,
        startHandle,
        bendHandle,
        attach,
        line,
        guide,
        restGroup: new THREE.Matrix4(),
      };
      this.bones.set(def.id, rt);
      this.list.push(rt);
    }
    this.updateRestFrames();
  }

  /** Recompute every bone's rest-pose frame (in place: materials hold on to them). */
  private updateRestFrames() {
    const one = new THREE.Vector3(1, 1, 1);
    for (const b of this.list) {
      b.restGroup.compose(b.pivot.position, b.restQuat, one);
      if (b.parent) b.restGroup.premultiply(b.parent.restGroup);
    }
  }

  /**
   * Rig editing: re-seat every bone from an edited skeleton with the same
   * bones, without rebuilding meshes (they stretch to fit until the next full build).
   */
  relayout(rig: RigState) {
    const next = expandRig(rig);
    for (const def of next.bones) {
      const b = this.bones.get(def.id);
      if (!b) continue;
      const { length, world } = restFrame(def);
      let local = b.parent ? b.parent.restWorld.clone().invert().multiply(world) : world.clone();
      if (b.parent) local = bendChild(bendOf(b.parent.def, b.parent.length), local);
      local.decompose(b.pivot.position, b.restQuat, new THREE.Vector3());
      b.pivot.quaternion.copy(b.restQuat);
      b.restWorld = world;
      b.def = def;
      if (b.mesh) b.mesh.scale.y = length / b.length;
      const bd = bendOf(def, length);
      const tipAt = bendPoint(bd, 0, length, 0);
      b.tip.position.set(tipAt[0], tipAt[1], tipAt[2]);
      b.bendHandle.position.copy(bendMid(bd));
      b.line.geometry.dispose();
      b.line.geometry = new THREE.BufferGeometry().setFromPoints(bonePoints(bd));
    }
    this.rootHandle.position.copy(this.list[0].pivot.position);
    this.updateRestFrames();
    this.mergeDirty = true;
  }

  setRigMode(on: boolean) {
    this.rigMode = on;
    if (on) this.invalidateSkin();
    this.applyPose();
  }

  settingsFor(style: StyleId): StyleSettings {
    return styleSettings(style, this.state.materialSettings?.[style]);
  }

  part(id: string): PartState {
    const b = this.bones.get(id)!;
    return this.state.parts[b.src];
  }

  outlineFor(b: BoneRT): Vec2[] {
    return this.state.parts[b.src].outline ?? defaultOutline(b.length, b.def.width, b.def.widthEnd ?? b.def.width);
  }

  // -------------------------------------------------------------------------
  // sync state -> scene

  applyPlacement() {
    const p = this.state.placement ?? { x: 0, z: 0, yaw: 0 };
    this.root.position.set(p.x, p.y ?? 0, p.z);
    if (p.quat) this.root.quaternion.set(...p.quat);
    else this.root.rotation.set(0, p.yaw, 0);
    this.root.scale.setScalar(p.scale ?? 1);
  }

  /** Read the placement back from the root (after a gizmo drag). */
  capturePlacement() {
    const r = (v: number, k = 1000) => Math.round(v * k) / k;
    const q = this.root.quaternion;
    const upright = Math.abs(q.x) < 1e-5 && Math.abs(q.z) < 1e-5;
    const p: Placement = {
      x: r(this.root.position.x),
      z: r(this.root.position.z),
      yaw: r(new THREE.Euler().setFromQuaternion(q, 'YXZ').y, 10000),
    };
    if (Math.abs(this.root.position.y) > 1e-4) p.y = r(this.root.position.y);
    if (!upright) p.quat = q.toArray().map((v) => r(v, 1e5)) as [number, number, number, number];
    if (Math.abs(this.root.scale.x - 1) > 1e-4) p.scale = r(this.root.scale.x);
    this.state.placement = p;
  }

  /** Remove from the scene and free per-creature GPU resources. */
  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else if (m && !m.userData.shared) m.dispose();
    });
    for (const b of this.list) (b.mesh?.userData.mergeGeo as THREE.BufferGeometry | undefined)?.dispose();
  }

  sync() {
    const s = this.state;
    this.applyPlacement();
    for (const b of this.list) {
      const p = s.parts[b.src];
      const style = p.style ?? s.style;
      const outline = this.outlineFor(b);
      const k = this.settingsFor(style);
      const geoOpts = {
        thickness: p.thickness,
        lowPoly: style === 'lowpoly',
        facetScale: style === 'lowpoly' ? k.facets : undefined,
        colorJitter: style === 'lowpoly' ? k.variation : undefined,
        lumps: style === 'clay' ? k.lumps : 0,
      };
      const geoKey = JSON.stringify([outline, geoOpts, getMeshDetail()]);
      const key = geoKey + style + p.color + JSON.stringify(k) + (p.opacity ?? 1) + bendKey(bendOf(b.def, b.length));
      if (key === b.meshKey) continue;
      b.meshKey = key;
      this.mergeDirty = true;
      if (b.mesh) {
        b.pivot.remove(b.mesh);
        b.mesh.traverse((o) => {
          ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose();
          if (o instanceof THREE.LineSegments) o.geometry.dispose();
        });
        (b.mesh.userData.mergeGeo as THREE.BufferGeometry | undefined)?.dispose();
      }
      const straight = cachedGeometry(geoKey, () =>
        buildInflatedGeometry(outline, { ...geoOpts, seed: hashString(b.src) }),
      );
      const bd = bendOf(b.def, b.length);
      const geo = bd.theta
        ? cachedGeometry(geoKey + bendKey(bd), () => bendGeometry(straight, bd))
        : straight;
      const mesh = new THREE.Mesh(geo, makeMaterial(style, p.color, k));
      mesh.userData.baseGeo = geo;
      // the seamless skin is built from the smooth (un-lumped) shape: lumps can
      // fold thin parts over themselves, which confuses inside/outside
      if (geoOpts.lumps) {
        const smoothOpts = { ...geoOpts, lumps: 0 };
        const smoothKey = JSON.stringify([outline, smoothOpts, getMeshDetail()]);
        mesh.userData.skinGeo = () => {
          const st = cachedGeometry(smoothKey, () => buildInflatedGeometry(outline, { ...smoothOpts, seed: hashString(b.src) }));
          return bd.theta ? cachedGeometry(smoothKey + bendKey(bd), () => bendGeometry(st, bd)) : st;
        };
      }
      mesh.userData.opacity = p.opacity ?? 1;
      mesh.castShadow = castsShadow(style);
      // (soft shadows also draw receivers into the shadow map: glass mustn't block the light)
      mesh.receiveShadow = castsShadow(style);
      mesh.userData.boneId = b.def.id;
      if (style === 'toon' && k.ink > 0) {
        const ink = new THREE.Mesh(geo, makeOutlineMaterial(k.ink));
        ink.userData.boneId = b.def.id;
        ink.raycast = () => {};
        mesh.add(ink);
      }
      if (style === 'felt') {
        for (const shell of makeFuzzShells(geo, p.color, k)) mesh.add(shell);
        if (k.hairs > 0) mesh.add(makeStrayHairs(geo, p.color, hashString(b.def.id), k.hairs));
      }
      setOpacity(mesh, p.opacity ?? 1);
      // textures (and fuzz) are laid out in the rest pose and bend with the bones
      setTextureSpace(mesh, b.restGroup);
      b.pivot.add(mesh);
      b.mesh = mesh;
    }
    this.applyPose();
    this.syncEyes();
    this.syncAttachments();
    this.refreshHighlight();
  }

  // -------------------------------------------------------------------------
  // attached stuff

  twinOf(b: BoneRT): BoneRT | null {
    if (b.def.sideSign === 0) return null;
    return this.bones.get(b.def.baseId + (b.def.sideSign === 1 ? 'R' : 'L')) ?? null;
  }

  syncAttachments() {
    const list = this.state.attachments ?? [];
    const alive = new Set<string>();
    for (const a of list) {
      const bone = this.bones.get(a.bone);
      if (!bone) continue;
      alive.add(a.id);
      const twinBone = a.mirror ? this.twinOf(bone) : null;
      // an item that inherits its material takes the material of the part it's on
      const part = this.state.parts[bone.src];
      const wearer = { style: part?.style ?? this.state.style, settingsFor: (st: StyleId) => this.settingsFor(st) };
      const styles = a.thing.inherit ? [wearer.style] : a.thing.pieces.map((p) => p.style);
      // felt fuzz and toon ink are sized for the attachment's scale, so a big
      // rescale rebuilds them (unless the item opts out, and lets them scale along with it)
      const sized = a.thing.scaleMaterial !== false && styles.some((s) => s === 'felt' || s === 'toon');
      const unit = sized ? Math.round(Math.cbrt(Math.abs(a.scale[0] * a.scale[1] * a.scale[2])) * 20) / 20 || 1 : 1;
      const key = JSON.stringify([a.thing.pieces, a.thing.ownMaterial, a.thing.inherit, a.thing.materialSettings, a.thing.bend, a.thing.bendMode, a.bone, twinBone?.def.id, this.state.materialSettings, wearer.style, unit, getMeshDetail()]);
      let rec = this.attached.get(a.id);
      if (!rec || rec.key !== key) {
        const settings = wearer;
        if (rec && rec.bone === bone && rec.twinBone === twinBone) {
          // same place: swap the contents but keep the groups (the gizmo may hold one)
          for (const g of [rec.main, rec.twin]) {
            if (!g) continue;
            for (const c of [...g.children]) {
              c.removeFromParent();
              disposeThing(c);
            }
            g.add(buildThing(a.thing, settings, unit));
          }
          rec.key = key;
        } else {
          if (rec) this.dropAttachment(rec);
          const main = new THREE.Group();
          main.add(buildThing(a.thing, settings, unit));
          bone.pivot.add(main);
          let twin: THREE.Group | null = null;
          if (twinBone) {
            twin = new THREE.Group();
            twin.add(buildThing(a.thing, settings, unit));
            twin.matrixAutoUpdate = false;
            twinBone.pivot.add(twin);
          }
          rec = { key, main, twin, bone, twinBone };
          this.attached.set(a.id, rec);
        }
        for (const g of [rec.main, rec.twin]) g?.traverse((o) => (o.userData.attachmentId = a.id));
      }
      rec.main.position.set(...a.position);
      rec.main.quaternion.set(...a.quaternion);
      rec.main.scale.set(...a.scale);
      this.updateTwin(a.id);
    }
    for (const [id, rec] of this.attached) {
      if (alive.has(id)) continue;
      this.dropAttachment(rec);
      this.attached.delete(id);
    }
  }

  private dropAttachment(rec: { main: THREE.Group; twin: THREE.Group | null }) {
    for (const g of [rec.main, rec.twin]) {
      if (!g) continue;
      g.removeFromParent();
      disposeThing(g);
    }
  }

  /**
   * The twin limb's frame is this one mirrored across its local Z, so the
   * mirrored copy uses M * A with M = diag(1, 1, -1).
   */
  updateTwin(id: string) {
    const rec = this.attached.get(id);
    if (!rec?.twin) return;
    rec.main.updateMatrix();
    rec.twin.matrix.makeScale(1, 1, -1).multiply(rec.main.matrix);
    rec.twin.matrixWorldNeedsUpdate = true;
  }

  attachmentObject(id: string): THREE.Group | null {
    return this.attached.get(id)?.main ?? null;
  }

  attachmentMeshes(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const rec of this.attached.values()) {
      for (const g of [rec.main, rec.twin]) g?.traverse((o) => o instanceof THREE.Mesh && out.push(o));
    }
    return out;
  }

  /** A reasonable first placement: centred on the part, on its front surface. */
  attachPoint(boneId: string): V3 {
    const b = this.bones.get(boneId);
    const geo = b?.mesh?.userData.baseGeo as THREE.BufferGeometry | undefined;
    if (!b || !geo?.boundingBox) return [0, 0, 0];
    const bb = geo.boundingBox;
    return [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.max.z * 0.9];
  }

  applyPose() {
    // only a real change re-merges: sync() calls this on every look edit too
    const before = this.list.map((b) => b.pivot.quaternion.clone());
    const pos = this.group.position.clone();
    for (const b of this.list) {
      const q = this.rigMode ? null : this.state.pose[b.def.id];
      b.pivot.quaternion.copy(b.restQuat);
      if (q) b.pivot.quaternion.multiply(new THREE.Quaternion(...q));
    }
    if (this.rigMode) this.group.position.set(0, 0, 0);
    else this.group.position.set(...this.state.rootOffset);
    if (!this.group.position.equals(pos) || this.list.some((b, i) => !b.pivot.quaternion.equals(before[i]))) this.mergeDirty = true;
  }

  capturePose() {
    const pose: CreatureState['pose'] = {};
    for (const b of this.list) {
      if (b.pivot.quaternion.angleTo(b.restQuat) > 1e-4) {
        const q = b.restQuat.clone().invert().multiply(b.pivot.quaternion);
        pose[b.def.id] = [q.x, q.y, q.z, q.w];
      }
    }
    this.state.pose = pose;
    this.state.rootOffset = this.group.position.toArray() as V3;
  }

  resetPose() {
    this.state.pose = {};
    this.state.rootOffset = [0, 0, 0];
    this.applyPose();
  }

  // -------------------------------------------------------------------------
  // merging: parts with the same colour and material are fused with a smooth
  // union. Each vertex near a neighbouring part is moved onto the blended
  // surface (a fillet) and its normal is blended too, so the seam disappears.

  /** Recompute merged geometry if the pose or parts changed. Cheap when clean. Returns true if it did. */
  updateMerge(): boolean {
    if (!this.mergeDirty) return false;
    this.mergeDirty = false;
    // Only shape changes invalidate the settled skin; a look-only change
    // (material sliders, opacity, colours while blending, eyes...) just
    // re-dresses it.
    const key = this.skinShapeKey();
    if (key !== this.skinKey) {
      this.skinKey = key;
      this.invalidateSkin();
      this.mergeDirty = false; // merging right now anyway
    } else if (this.skinState === 'ready') {
      for (const sk of this.skins) this.dressSkin(sk);
    }
    const s = this.state;
    const on = s.merge ?? true;
    const k = s.mergeRadius ?? 0.1;
    // with colour blending, parts of one material merge whatever their colour
    const blend = on && !!s.mergeColors;
    const kc = blend ? (s.colorBlend ?? 0.12) : 0;
    this.root.updateMatrixWorld(true);
    this.rootInv.copy(this.root.matrixWorld).invert();

    const groups = new Map<string, BoneRT[]>();
    for (const b of this.list) {
      if (!b.mesh) continue;
      const p = s.parts[b.src];
      const key = (p.style ?? s.style) + (blend ? '' : p.color.toLowerCase());
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(b);
    }

    // parts under a finished skin are hidden: fused again once the skin goes
    const skinned = new Set(this.skinState === 'ready' ? this.skins.flatMap((sk) => sk.members) : []);
    for (const [, members] of groups) {
      for (const b of members) {
        if (skinned.has(b)) continue;
        const base = b.mesh!.userData.baseGeo as THREE.BufferGeometry;
        const nbrs = on && members.length > 1 ? members.filter((o) => o !== b && this.near(b, o, Math.max(k, kc))) : [];
        if (nbrs.length === 0) {
          this.setMeshGeometry(b, base, false);
          continue;
        }
        let g = b.mesh!.userData.mergeGeo as THREE.BufferGeometry | undefined;
        if (!g || g.userData.base !== base) {
          g?.dispose();
          g = base.clone();
          g.userData = { base };
          b.mesh!.userData.mergeGeo = g;
        }
        // only paint colours when a neighbour actually has a different colour
        const myColor = s.parts[b.src].color.toLowerCase();
        const paint = blend && nbrs.some((o) => s.parts[o.src].color.toLowerCase() !== myColor);
        this.fuse(b, base, g, nbrs, k, paint ? kc : 0);
        this.setMeshGeometry(b, g, paint);
      }
    }
    return true;
  }

  markMergeDirty() {
    this.mergeDirty = true;
  }

  /**
   * Swap in base or fused geometry. When `painted`, colour comes from the
   * per-vertex colours baked by fuse(), so materials switch to white * vertex colour.
   */
  private setMeshGeometry(b: BoneRT, g: THREE.BufferGeometry, painted: boolean) {
    const mesh = b.mesh!;
    mesh.geometry = g;
    // ink hulls and fuzz shells follow the fused surface
    for (const c of mesh.children) if (c instanceof THREE.Mesh) c.geometry = g;
    const part = this.state.parts[b.src];
    const lowPoly = (part.style ?? this.state.style) === 'lowpoly';
    // body + fuzz shells (stray-hair lines keep their own per-hair colours)
    const mats = [mesh.material, ...mesh.children.filter((c) => c instanceof THREE.Mesh).map((c) => (c as THREE.Mesh).material)];
    for (const m of mats as THREE.MeshStandardMaterial[]) {
      if (!m || !('color' in m) || m.userData?.ink) continue;
      const want = painted || lowPoly;
      if (m.vertexColors !== want) {
        m.vertexColors = want;
        m.needsUpdate = true;
      }
      // back to the colour the material was made with (not the plain part
      // colour: glass, say, is only tinted by it), or white under baked colours
      m.userData.baseColor ??= m.color.clone();
      if (painted) m.color.setRGB(1, 1, 1);
      else m.color.copy(m.userData.baseColor as THREE.Color);
    }
  }

  // -------------------------------------------------------------------------
  // seamless skin: when the creature is left alone, merged groups are rebuilt
  // as one continuous surface (see skin.ts); any change drops back to the fast
  // per-part merge above.

  /** Drop the settled skin and show the individual parts again. */
  invalidateSkin() {
    this.skinVersion++;
    this.lastChange = performance.now();
    this.skinState = 'none';
    if (!this.skins.length) return;
    // the parts come back into view: they may have skipped merging meanwhile
    this.mergeDirty = true;
    for (const { mesh, members } of this.skins) {
      mesh.removeFromParent();
      mesh.traverse((o) => {
        ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose();
        if (o instanceof THREE.LineSegments) o.geometry.dispose();
      });
      mesh.geometry.dispose();
      for (const b of members) if (b.mesh) b.mesh.visible = true;
    }
    this.skins = [];
  }

  /** Build seamless skins for every merged group. Resolves false if interrupted. */
  async settle(): Promise<boolean> {
    const s = this.state;
    if (this.skinState !== 'none' || !(s.merge ?? true) || !seamlessOn(s) || this.rigMode || this.drawFocus) return false;
    const version = this.skinVersion;
    this.skinState = 'building';
    this.root.updateMatrixWorld(true);
    this.rootInv.copy(this.root.matrixWorld).invert();
    const toGroup = this.group.matrixWorld.clone().invert();
    const kMax = s.mergeRadius ?? 0.1;
    const blend = !!s.mergeColors;
    const kc = blend ? (s.colorBlend ?? 0.12) : 0;

    // same groups as the fast merge: one material (and one colour unless blending)
    const groups = new Map<string, BoneRT[]>();
    for (const b of this.list) {
      if (!b.mesh) continue;
      const p = s.parts[b.src];
      const key = (p.style ?? s.style) + (blend ? '' : p.color.toLowerCase());
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(b);
    }
    const radius = (b: BoneRT) => {
      const sol = (b.mesh!.userData.baseGeo as THREE.BufferGeometry).userData.solid as Solid | undefined;
      let m = 0;
      if (sol) for (let i = 2; i < sol.spheres.length; i += 3) m = Math.max(m, sol.spheres[i]);
      return Math.max(0.01, m * Math.min(1, sol?.thickness ?? 1));
    };

    const built: SkinEntry[] = [];
    for (const [, members] of groups) {
      // only parts that actually touch another part in the group
      const joined = members.filter((b) => members.some((o) => o !== b && this.near(b, o, kMax)));
      if (joined.length < 2) continue;
      const part = s.parts[joined[0].src];
      const style = part.style ?? s.style;
      const k = this.settingsFor(style);
      const minR = Math.min(...joined.map(radius));
      const lowPoly = style === 'lowpoly';
      const textured = isTextured(style);
      // low-poly keeps its own parts (and fast joins) unless the setting says otherwise
      if (lowPoly && !seamlessLowPoly) continue;
      // low-poly is built smooth like the rest, then re-faceted to each part's own facet size
      // a coarser grid with less mesh detail (Settings > Performance)
      const h = Math.min(0.02, Math.max(0.006, minR / 2.5)) / Math.sqrt(getMeshDetail());

      const parts: SkinPart[] = joined.map((b) => {
        const geo = ((b.mesh!.userData.skinGeo as (() => THREE.BufferGeometry) | undefined)?.() ?? b.mesh!.userData.baseGeo) as THREE.BufferGeometry;
        return {
          geo,
          toSkin: toGroup.clone().multiply(b.mesh!.matrixWorld),
          // textured materials lay their textures out in the rest pose
          toRest: textured ? b.restGroup.clone().multiply(b.mesh!.matrix) : undefined,
          color: this.shownColor(b),
          k: Math.max(0.005, Math.min(kMax, 0.6 * radius(b))),
          facet: geo.userData.facet as number | undefined,
        };
      });
      // clay lumps go back on after the skin is built
      const lumps = style === 'clay' ? (k.lumps ?? 0) * Math.min(0.012, Math.max(0.004, minR * 0.08)) : 0;
      const geo = await buildSkin(parts, { h, colorBlend: kc, lowPoly, lumps, shouldStop: () => version !== this.skinVersion });
      if (version !== this.skinVersion) {
        // something changed meanwhile: it'll be retried once things settle again
        geo?.dispose();
        for (const bm of built) bm.mesh.geometry.dispose();
        return false;
      }
      // this group couldn't be skinned: its parts just stay fast-merged (never retry
      // in a loop; the skin is only attempted again after the next change)
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo);
      mesh.receiveShadow = true;
      mesh.raycast = () => {}; // picking still goes to the (hidden) parts
      mesh.userData.skin = true;
      built.push({
        mesh,
        members: joined,
        parts,
        lowPoly,
        painted: !!geo.userData.painted,
        colorKey: JSON.stringify([parts.map((p) => p.color.getHex()), kc]),
      });
    }
    if (version !== this.skinVersion) return false;

    // swap: skins in (dressed in the current look), their parts out
    for (const sk of built) {
      this.group.add(sk.mesh);
      this.dressSkin(sk);
    }
    this.skins = built;
    this.skinState = 'ready';
    return true;
  }

  /**
   * What a skin's shape depends on. Anything else (material sliders that
   * don't reshape, opacity, eyes, stuff, colours while blending) only needs
   * the existing skin re-dressed, not rebuilt.
   */
  private skinShapeKey(): string {
    const s = this.state;
    const blend = !!s.mergeColors;
    const r4 = (v: number) => Math.round(v * 1e4);
    return JSON.stringify([
      s.merge ?? true,
      seamlessOn(s),
      seamlessLowPoly,
      s.mergeRadius,
      blend,
      s.rig,
      this.group.position.toArray().map(r4),
      this.list.map((b) => b.pivot.quaternion.toArray().map(r4)),
      Object.entries(s.parts).map(([id, p]) => {
        const style = p.style ?? s.style;
        const k = this.settingsFor(style);
        // clay lumps and low-poly facet size change the shape; with blending off, colour changes the groups
        return [id, p.outline, p.thickness, style, style === 'clay' ? k.lumps : 0, style === 'lowpoly' ? k.facets : 0, blend ? '' : p.color.toLowerCase()];
      }),
    ]);
  }

  /** Give a skin the current look: colours, material, felt fuzz, toon ink, opacity. */
  private dressSkin(sk: SkinEntry) {
    const s = this.state;
    const part = s.parts[sk.members[0].src];
    const style = part.style ?? s.style;
    const k = this.settingsFor(style);
    const kc = s.mergeColors ? (s.colorBlend ?? 0.12) : 0;

    // repaint only if the colours (or the fade width) changed
    sk.parts.forEach((p, i) => p.color.copy(this.shownColor(sk.members[i])));
    const colorKey = JSON.stringify([sk.parts.map((p) => p.color.getHex()), kc]);
    if (colorKey !== sk.colorKey) {
      sk.painted = paintSkin(sk.mesh.geometry, sk.parts, kc, sk.lowPoly);
      sk.colorKey = colorKey;
    }

    // nothing about the look changed (e.g. another part was edited): keep the
    // current dressing; rebuilding felt fuzz and stray hairs is expensive
    const lookKey = JSON.stringify([style, part.color, k, part.opacity ?? 1, sk.painted, colorKey, this.eyeSpots]);
    if (lookKey === sk.lookKey) {
      for (const b of sk.members) if (b.mesh) b.mesh.visible = false;
      return;
    }
    sk.lookKey = lookKey;

    const mesh = sk.mesh;
    for (const c of [...mesh.children]) {
      mesh.remove(c);
      c.traverse((o) => {
        ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose();
        if (o instanceof THREE.LineSegments) o.geometry.dispose();
      });
    }
    (mesh.material as THREE.Material | undefined)?.dispose();
    const geo = mesh.geometry;
    const mat = makeMaterial(style, part.color, k) as THREE.MeshStandardMaterial;
    if (geo.getAttribute('color')) {
      mat.vertexColors = true;
      if (sk.painted) mat.color.setRGB(1, 1, 1);
    }
    mesh.material = mat;
    mesh.castShadow = mesh.receiveShadow = castsShadow(style);
    if (style === 'toon' && k.ink > 0) {
      const ink = new THREE.Mesh(geo, makeOutlineMaterial(k.ink));
      ink.raycast = () => {};
      mesh.add(ink);
    }
    if (style === 'felt') {
      for (const shell of makeFuzzShells(geo, part.color, k)) {
        if (sk.painted) {
          // fuzz takes the skin's blended colours, not the first part's
          const sm = shell.material as THREE.MeshStandardMaterial;
          sm.vertexColors = true;
          sm.color.setRGB(1, 1, 1);
        }
        mesh.add(shell);
      }
      if (k.hairs > 0) mesh.add(makeStrayHairs(geo, part.color, 11, k.hairs, sk.painted));
    }
    setOpacity(mesh, part.opacity ?? 1);
    // laid out from the rest positions the skin was built with
    if (geo.getAttribute('restPos')) setTextureSpace(mesh, 'attributes');

    // parts may have been rebuilt (new meshes) by the look change: keep them hidden
    for (const b of sk.members) if (b.mesh) b.mesh.visible = false;

    // keep felt fuzz off the eyes on the skin too
    const head = this.bones.get(this.rig.headId);
    if (head?.mesh && sk.members.includes(head) && this.eyeSpots.length) {
      this.group.updateMatrixWorld(true);
      const toSkin = this.group.matrixWorld.clone().invert().multiply(head.mesh.matrixWorld);
      const v = new THREE.Vector3();
      setFuzzMask(mesh, this.eyeSpots.map((sp) => (v.set(sp.x, sp.y, sp.z).applyMatrix4(toSkin), { x: v.x, y: v.y, z: v.z, r: sp.r })));
    }
  }

  /** A part's colour as its material shows it (see surfaceColor). */
  private shownColor(b: BoneRT): THREE.Color {
    const p = this.state.parts[b.src];
    const style = p.style ?? this.state.style;
    return surfaceColor(style, p.color, this.settingsFor(style));
  }

  /**
   * A part's mesh relative to the creature's placement (root), so merging
   * works the same however the creature is moved, turned or resized.
   */
  private rootInv = new THREE.Matrix4();
  private rel(o: THREE.Object3D): THREE.Matrix4 {
    return this.rootInv.clone().multiply(o.matrixWorld);
  }

  private near(a: BoneRT, b: BoneRT, k: number): boolean {
    const ga = a.mesh!.userData.baseGeo as THREE.BufferGeometry;
    const gb = b.mesh!.userData.baseGeo as THREE.BufferGeometry;
    const ca = ga.boundingSphere!.center.clone().applyMatrix4(this.rel(a.mesh!));
    const cb = gb.boundingSphere!.center.clone().applyMatrix4(this.rel(b.mesh!));
    return ca.distanceTo(cb) < ga.boundingSphere!.radius + gb.boundingSphere!.radius + k;
  }

  /**
   * Fuse this part's surface into its neighbours (smooth-min fillet) and,
   * when `kc` > 0, bake a colour gradient that meets 50/50 at the seam.
   */
  private fuse(b: BoneRT, base: THREE.BufferGeometry, out: THREE.BufferGeometry, nbrs: BoneRT[], kMax: number, kc: number) {
    const solidA = base.userData.solid as Solid;
    const maxR = (sol: Solid) => {
      let m = 0;
      for (let i = 2; i < sol.spheres.length; i += 3) m = Math.max(m, sol.spheres[i]);
      return m * Math.min(1, sol.thickness);
    };
    const rA = maxR(solidA);
    const own = this.shownColor(b);
    // Colour fades are measured a bit wider than asked (up to the slider's
    // top), so dragging the fade slider only redoes colours, not the shape.
    const reach = kc > 0 ? Math.max(kc, Math.min(0.4, 2 * kc)) : 0;

    // "world" here is the creature's own placement space (see rel)
    const toWorld = this.rel(b.mesh!);
    const toLocal = toWorld.clone().invert();
    const rotW = new THREE.Matrix3().setFromMatrix4(toWorld);
    const rotL = new THREE.Matrix3().setFromMatrix4(toLocal);
    const myKey = this.state.parts[b.src].color.toLowerCase();
    const others = nbrs.map((o) => {
      const g = o.mesh!.userData.baseGeo as THREE.BufferGeometry;
      const solid = g.userData.solid as Solid;
      // keep fillets in proportion: a thin antenna shouldn't get a huge blob
      const k = Math.max(0.005, Math.min(kMax, 0.6 * Math.min(rA, maxR(solid))));
      const oWorld = this.rel(o.mesh!);
      const inv = oWorld.clone().invert();
      const colorKey = this.state.parts[o.src].color.toLowerCase();
      return {
        solid,
        geo: g,
        bvh: bvhFor(g),
        normals: sharedNormals(g),
        k,
        inv,
        rot: new THREE.Matrix3().setFromMatrix4(oWorld),
        box: g.boundingBox!.clone().expandByScalar(Math.max(k, reach)),
        color: this.shownColor(o),
        // same-coloured neighbours don't tint
        tints: kc > 0 && colorKey !== myKey,
      };
    });

    const p0 = base.getAttribute('position') as THREE.BufferAttribute;
    // shared-corner normals so split (low-poly) vertices all move the same way
    const n0 = sharedNormals(base);
    const p1 = out.getAttribute('position') as THREE.BufferAttribute;
    const n1 = out.getAttribute('normal') as THREE.BufferAttribute;
    // low-poly keeps its per-facet shading variation underneath the tint
    const jitter = base.getAttribute('color') as THREE.BufferAttribute | undefined;
    let c1 = out.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (kc > 0 && !c1) {
      c1 = new THREE.BufferAttribute(new Float32Array(p0.count * 3), 3);
      out.setAttribute('color', c1);
    }
    const pw = new THREE.Vector3(), nw = new THREE.Vector3(), q = new THREE.Vector3();
    const grad = new THREE.Vector3(), gw = new THREE.Vector3(), gsum = new THREE.Vector3();
    const col = new THREE.Color();

    // What the fused shape depends on: if only the colour fade changed since
    // last time, just repaint from the remembered distances.
    const r6 = (v: number) => v.toFixed(6);
    const shapeKey = [
      base.uuid, kMax, ...toWorld.elements.map(r6),
      ...nbrs.flatMap((o) => [o.def.id, (o.mesh!.userData.baseGeo as THREE.BufferGeometry).uuid, ...this.rel(o.mesh!).elements.map(r6)]),

    ].join(',');
    const cache = out.userData.fade as { key: string; reach: number; f: Float32Array } | undefined;
    const n = others.length;
    const paint = (i: number, fAt: (j: number) => number) => {
      col.copy(own);
      for (let j = 0; j < n; j++) {
        const o = others[j];
        const f = fAt(j);
        if (o.tints && f < kc) {
          // 50/50 at the seam, fading to our own colour kc away from it
          const t = Math.min(1, Math.max(0, 1 - f / kc));
          col.lerp(o.color, 0.5 * t * t * (3 - 2 * t));
        }
      }
      const jv = jitter ? jitter.getX(i) : 1;
      c1!.setXYZ(i, col.r * jv, col.g * jv, col.b * jv);
    };
    if (kc > 0 && c1 && cache?.key === shapeKey && kc <= cache.reach) {
      for (let i = 0; i < p0.count; i++) paint(i, (j) => cache.f[i * n + j]);
      c1.needsUpdate = true;
      return;
    }
    const fs = kc > 0 ? new Float32Array(p0.count * n).fill(Infinity) : null;


    for (let i = 0; i < p0.count; i++) {
      pw.fromBufferAttribute(p0, i).applyMatrix4(toWorld);
      nw.fromBufferAttribute(n0, i).applyMatrix3(rotW).normalize();
      // running smooth-min of (this surface = 0, each neighbour's distance)
      let d = 0;
      gsum.copy(nw);
      let touched = false;
      for (let j = 0; j < n; j++) {
        const o = others[j];
        q.copy(pw).applyMatrix4(o.inv);
        if (!o.box.containsPoint(q)) continue;
        // exact signed distance to the neighbour's real surface, so both sides build the same fillet
        const f = exactDistance(o.geo, o.bvh, o.normals, q, Math.max(o.k, reach), grad);
        if (fs) fs[i * n + j] = f;
        if (f >= o.k) continue;
        gw.copy(grad).applyMatrix3(o.rot).normalize();
        const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (f - d)) / o.k));
        d = f * (1 - h) + d * h - o.k * h * (1 - h);
        gsum.multiplyScalar(h).addScaledVector(gw, 1 - h);
        touched = true;
      }
      if (c1) {
        if (fs) paint(i, (j) => fs[i * n + j]);
        else {
          const jv = jitter ? jitter.getX(i) : 1;
          c1.setXYZ(i, jv, jv, jv);
        }
      }
      if (!touched) {
        p1.setXYZ(i, p0.getX(i), p0.getY(i), p0.getZ(i));
        n1.setXYZ(i, n0.getX(i), n0.getY(i), n0.getZ(i));
        continue;
      }
      // Deep inside a neighbour: leave it hidden. In the blend band: one
      // Newton step onto the fused surface.
      const kk = others[0].k;
      const w = 1 - Math.min(1, Math.max(0, (-d - 0.3 * kk) / (0.5 * kk)));
      const g2 = Math.max(gsum.lengthSq(), 0.05);
      let step = (-d / g2) * w;
      step = Math.max(-kk, Math.min(kk * 1.5, step));
      pw.addScaledVector(gsum, step);
      nw.lerp(gsum.normalize(), w).normalize();
      pw.applyMatrix4(toLocal);
      nw.applyMatrix3(rotL).normalize();
      p1.setXYZ(i, pw.x, pw.y, pw.z);
      n1.setXYZ(i, nw.x, nw.y, nw.z);
    }
    p1.needsUpdate = true;
    n1.needsUpdate = true;
    if (c1) c1.needsUpdate = true;
    out.userData.fade = fs ? { key: shapeKey, reach, f: fs } : undefined;
    out.computeBoundingSphere();
  }

  // -------------------------------------------------------------------------
  // eyes

  private syncEyes() {
    const head = this.bones.get(this.rig.headId);
    const e = this.state.eyes;
    const key = JSON.stringify([e, head?.meshKey, this.state.style, head?.length, this.state.materialSettings]);
    if (key === this.eyesKey) return;
    this.eyesKey = key;
    this.mergeDirty = true;
    this.eyes.removeFromParent();
    this.eyes = new THREE.Group();
    // felt: clear fuzz from under the eyes (reset first; refilled below)
    for (const b of this.list) if (b.mesh) setFuzzMask(b.mesh, []);
    if (!head || !head.mesh || !e.enabled) return;
    head.pivot.add(this.eyes);
    const spots: FuzzSpot[] = [];

    // Work in the head's rest frame so eyes stick to the face whatever the pose.
    const toWorld = head.restWorld;
    const toLocal = toWorld.clone().invert();
    const geo = (head.mesh.userData.baseGeo as THREE.BufferGeometry) ?? head.mesh.geometry;
    const forward = new THREE.Vector3(...(this.rig.eyeDir ?? [0, 0, 1])).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(up.dot(forward)) > 0.9) up.set(0, 0, -1);
    up.addScaledVector(forward, -up.dot(forward)).normalize();
    const right = new THREE.Vector3().crossVectors(up, forward);
    const localForward = forward.clone().transformDirection(toLocal);

    // extents of the head as seen from the front
    const pos = geo.getAttribute('position');
    const v = new THREE.Vector3();
    let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity, maxF = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toWorld);
      const r = v.dot(right), u = v.dot(up), f = v.dot(forward);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      maxF = Math.max(maxF, f);
    }
    const sizeR = maxR - minR, sizeU = maxU - minU;

    const probe = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const ray = new THREE.Raycaster();

    const headPart = this.state.parts[head.src];
    const headStyle = headPart.style ?? this.state.style;
    const localUp = up.clone().transformDirection(toLocal);

    for (const pair of e.pairs) {
    const r = Math.max(0.02, Math.min(sizeR, sizeU) * 0.16 * (0.4 + pair.size * 1.2));
    for (const sgn of [1, -1]) {
      const originW = new THREE.Vector3()
        .addScaledVector(right, (minR + maxR) / 2 + sgn * (sizeR / 2) * pair.spacing * 0.8)
        .addScaledVector(up, minU + sizeU * pair.height)
        .addScaledVector(forward, maxF + 1);
      ray.set(originW.applyMatrix4(toLocal), localForward.clone().negate());
      const hit = ray.intersectObject(probe, false)[0];
      if (!hit || !hit.face) continue;

      // Flat eyes lie flush with the surface; round ones mostly look forward.
      const surfN = hit.face.normal.clone().normalize();
      const flat = e.style === 'flat' || e.style === 'button' || e.style === 'dot';
      const z = flat ? surfN : surfN.clone().multiplyScalar(0.5).add(localForward).normalize();
      const y = localUp.clone().addScaledVector(z, -localUp.dot(z)).normalize();
      const x = new THREE.Vector3().crossVectors(y, z);
      const eye = new THREE.Group();
      eye.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      // stand-off: lift the eye out along its facing direction
      eye.position.copy(hit.point).addScaledVector(z, (pair.lift ?? e.lift ?? 0) * r * 1.2);
      const style = EYE_STYLES.some((o) => o.id === e.style) ? e.style : 'googly';
      eye.add(buildEye(style, r, sgn, headStyle, this.settingsFor(headStyle), e));
      eye.traverse((m) => {
        m.raycast = () => {};
        m.castShadow = true;
      });
      this.eyes.add(eye);
      // bare patch just inside the eye's own rim, so it stays hidden behind it
      spots.push({ x: hit.point.x, y: hit.point.y, z: hit.point.z, r: r * (style === 'flat' ? 1.1 : style === 'button' ? 1.0 : 0.85) });
    }
    }
    setFuzzMask(head.mesh, spots);
    this.eyeSpots = spots;
  }

  // -------------------------------------------------------------------------
  // selection / drawing visuals

  select(id: string | null) {
    this.selected = id;
    this.refreshHighlight();
    this.setSkeletonVisible(this.skeletonShown); // move the bend handle to the new selection
  }

  /** Bones that share a drawing with `id` (itself plus its mirror twin). */
  linked(id: string): BoneRT[] {
    const src = this.bones.get(id)?.src;
    return this.list.filter((b) => b.src === src);
  }

  private refreshHighlight() {
    for (const b of this.list) this.updateGuide(b, this.drawFocus === b.def.id);
  }

  /** Glow the selected part (and its twin); k fades 1 -> 0. */
  flash(id: string | null, k: number) {
    const src = id ? this.bones.get(id)?.src : null;
    for (const b of this.list) {
      const m = b.mesh?.material as THREE.MeshStandardMaterial | undefined;
      if (m && 'emissive' in m) {
        if (b.src === src && k > 0) m.emissive.setRGB(1, 0.42, 0.29).multiplyScalar(0.45 * k);
        else m.emissive.setScalar(0);
      }
      // A part under a seamless skin is hidden, so its own glow can't be
      // seen: glow a copy of its surface, puffed out a touch, over the skin.
      let hl = this.highlights.get(b);
      const on = !!b.mesh && !b.mesh.visible && b.src === src && k > 0;
      if (!on) {
        if (hl) hl.visible = false;
        continue;
      }
      if (!hl) {
        hl = new THREE.Mesh(b.mesh!.geometry, this.highlightMat);
        hl.raycast = () => {};
        hl.renderOrder = 5;
        this.highlights.set(b, hl);
      }
      if (hl.parent !== b.pivot) b.pivot.add(hl);
      hl.geometry = b.mesh!.geometry;
      hl.position.copy(b.mesh!.position);
      hl.quaternion.copy(b.mesh!.quaternion);
      hl.scale.copy(b.mesh!.scale);
      hl.visible = true;
    }
    this.highlightMat.opacity = 0.8 * Math.max(0, k);
  }

  private highlights = new Map<BoneRT, THREE.Mesh>();
  private highlightMat = (() => {
    const m = new THREE.MeshBasicMaterial({ color: 0xff9a70, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = position + normal * 0.012;');
    };
    return m;
  })();


  private updateGuide(b: BoneRT, on: boolean) {
    b.guide.clear();
    b.guide.visible = on;
    if (!on) return;
    const pts = this.outlineFor(b).map(([x, y]) => new THREE.Vector3(x, y, 0));
    const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), outlineLineMat);
    loop.renderOrder = 998;
    b.guide.add(loop);
    if (this.drawFocus === b.def.id) {
      const r = Math.max(b.length, b.def.width) * 1.6 + 0.3;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 64), planeMat);
      disc.position.y = b.length / 2;
      disc.raycast = () => {};
      b.guide.add(disc);
    }
  }

  setDrawFocus(id: string | null) {
    this.drawFocus = id;
    if (id) this.invalidateSkin();
    for (const b of this.list) {
      const m = b.mesh?.material as THREE.Material | undefined;
      if (!m) continue;
      const dim = id !== null && b.def.id !== id;
      const self = id !== null && b.def.id === id;
      const own = (b.mesh!.userData.opacity as number) ?? 1;
      m.transparent = dim || self || own < 0.999;
      m.opacity = dim ? 0.18 : self ? 0.45 : own;
      m.depthWrite = !(dim || self);
      m.needsUpdate = true;
      const style = this.state.parts[b.src].style ?? this.state.style;
      b.mesh!.castShadow = !dim && castsShadow(style);
      for (const c of b.mesh!.children) c.visible = !id;
    }
    this.eyes.visible = !id;
    for (const rec of this.attached.values()) {
      rec.main.visible = !id;
      if (rec.twin) rec.twin.visible = !id;
    }
    this.refreshHighlight();
  }

  private skeletonShown = false;

  setSkeletonVisible(v: boolean) {
    this.skeletonShown = v;
    const sel = this.selected ? this.bones.get(this.selected) : null;
    for (const b of this.list) {
      b.tip.visible = v;
      b.line.visible = v;
      b.startHandle.visible = v && this.rigMode && b.attach;
      // the bend handle only on the selected bone (the twin follows by symmetry)
      b.bendHandle.visible = v && this.rigMode && b === sel;
    }
    this.rootHandle.visible = v && !this.rigMode;
  }

  setHandleHover(obj: THREE.Object3D | null) {
    for (const b of this.list) {
      b.tip.material = b.tip === obj ? tipHoverMat : tipMat;
      b.startHandle.material = b.startHandle === obj ? tipHoverMat : startMat;
      b.bendHandle.material = b.bendHandle === obj ? tipHoverMat : bendMat;
    }
  }

  handles(): THREE.Object3D[] {
    if (this.rigMode) return [...this.list.map((b) => b.bendHandle), ...this.list.map((b) => b.startHandle), ...this.list.map((b) => b.tip)];
    return [this.rootHandle, ...this.list.map((b) => b.tip)];
  }

  meshes(): THREE.Object3D[] {
    return this.list.flatMap((b) => (b.mesh ? [b.mesh] : []));
  }

  // -------------------------------------------------------------------------
  // posing

  /** Rotate a bone (in world space) so its tip points at `target`. */
  aimBone(b: BoneRT, effector: THREE.Vector3, target: THREE.Vector3) {
    const origin = b.pivot.getWorldPosition(new THREE.Vector3());
    const from = effector.clone().sub(origin);
    const to = target.clone().sub(origin);
    if (from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8) return;
    const q = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    const parentQ = b.pivot.parent!.getWorldQuaternion(new THREE.Quaternion());
    const worldQ = parentQ.clone().multiply(b.pivot.quaternion);
    worldQ.premultiply(q);
    b.pivot.quaternion.copy(parentQ.invert().multiply(worldQ));
    b.pivot.updateMatrixWorld(true);
  }

  /** Drag a bone tip toward `target`, optionally bending up to `chain` ancestors (CCD IK). */
  dragTip(id: string, target: THREE.Vector3, ik: boolean) {
    const b = this.bones.get(id)!;
    const chain: BoneRT[] = [b];
    if (ik) {
      let p = b.parent;
      while (p && chain.length < 3 && !p.def.anchor) {
        chain.push(p);
        p = p.parent;
      }
    }
    this.mergeDirty = true;
    const iterations = chain.length > 1 ? 12 : 1;
    const tipPos = new THREE.Vector3();
    for (let it = 0; it < iterations; it++) {
      for (const j of chain) {
        b.tip.getWorldPosition(tipPos);
        this.aimBone(j, tipPos, target);
      }
    }
  }
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Eye styles. Each eye is built in a frame where +Z points out of the face,
// +Y is "up" on the face, and the origin sits on the surface.

const sphereGeo = new THREE.SphereGeometry(1, 32, 20);
const glossyWhite = () => new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.15, clearcoat: 1 });
const glossyBlack = () => new THREE.MeshPhysicalMaterial({ color: 0x1b1720, roughness: 0.12, clearcoat: 1 });

/**
 * A sphere built at its real size (rather than a unit sphere scaled down), so
 * textured materials keep the same density and bump strength as the head.
 */
function realSphere(sx: number, sy: number, sz: number): THREE.BufferGeometry {
  const g = sphereGeo.clone().scale(sx, sy, sz);
  // low-poly materials read per-vertex colour
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 3).fill(1), 3));
  return g;
}

/** Material for bead / dot / button eyes. */
function eyeMaterial(finish: EyeFinish, color: string, headStyle: StyleId, headSettings: StyleSettings): THREE.Material {
  switch (finish) {
    case 'gloss':
      return new THREE.MeshPhysicalMaterial({ color, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 });
    case 'matte':
      return new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    case 'glass':
      // a coloured glass marble: strong tint so the colour reads
      return makeMaterial('glass', color, { ...styleSettings('glass'), ...(headStyle === 'glass' ? headSettings : {}), tint: 0.85 });
    default:
      // glass: tinted strongly, or a dark eye colour barely shows through clear glass
      return makeMaterial(headStyle, color, headStyle === 'glass' ? { ...headSettings, tint: Math.max(headSettings.tint, 0.85) } : headSettings);
  }
}

function buildEye(style: EyeStyle, r: number, sgn: number, headStyle: StyleId, headSettings: StyleSettings, e: EyesState): THREE.Object3D {
  const g = new THREE.Group();
  const finish = e.finish ?? 'body';
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, pos: V3, scale: V3) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    m.scale.set(...scale);
    g.add(m);
    return m;
  };

  switch (style) {
    case 'googly': {
      add(sphereGeo, glossyWhite(), [0, 0, -r * 0.35], [r, r, r]);
      add(sphereGeo, glossyBlack(), [0, 0, r * 0.47], [r * 0.55, r * 0.6, r * 0.3]);
      add(sphereGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), [r * 0.2, r * 0.25, r * 0.67], [r * 0.14, r * 0.14, r * 0.14]);
      break;
    }
    case 'flat': {
      // craft-store sticker eye: white disc, a loose pupil that has fallen to the bottom, clear dome
      const R = r * 1.15;
      const disc = new THREE.CylinderGeometry(1, 1, 1, 40);
      disc.rotateX(Math.PI / 2);
      add(disc, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 }), [0, 0, R * 0.06], [R, R, R * 0.12]);
      const jiggle = (sgn * 0.13 + 0.05) * R;
      add(disc, new THREE.MeshStandardMaterial({ color: 0x151216, roughness: 0.4 }), [jiggle, -R * 0.36, R * 0.14], [R * 0.58, R * 0.58, R * 0.04]);
      const dome = new THREE.SphereGeometry(1, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.rotateX(Math.PI / 2);
      add(
        dome,
        new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.02, transparent: true, opacity: 0.1, clearcoat: 1, depthWrite: false }),
        [0, 0, R * 0.1],
        [R * 1.02, R * 1.02, R * 0.38],
      );
      break;
    }
    case 'bead': {
      // a bead, by default in the creature's own material
      add(realSphere(r * 0.8, r * 0.8, r * 0.8), eyeMaterial(finish, e.color ?? '#1d1a22', headStyle, headSettings), [0, 0, -r * 0.3], [1, 1, 1]);
      break;
    }
    case 'dot': {
      // a flat disc of dark wool/clay pressed onto the face
      add(realSphere(r * 0.95, r * 0.95, r * 0.28), eyeMaterial(finish, e.color ?? '#2a2730', headStyle, headSettings), [0, 0, 0], [1, 1, 1]);
      break;
    }
    case 'button': {
      const R = r * 1.05;
      // buttons are glossy plastic unless a finish is chosen
      const mat =
        finish === 'body'
          ? new THREE.MeshPhysicalMaterial({ color: e.color ?? 0x2a2230, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.2 })
          : eyeMaterial(finish, e.color ?? '#2a2230', headStyle, headSettings);
      const body = new THREE.CylinderGeometry(1, 0.94, 1, 40);
      body.rotateX(Math.PI / 2);
      add(body, mat, [0, 0, R * 0.1], [R, R, R * 0.2]);
      add(new THREE.TorusGeometry(1, 0.12, 12, 40), mat, [0, 0, R * 0.2], [R * 0.86, R * 0.86, R * 0.8]);
      const hole = new THREE.CylinderGeometry(1, 1, 1, 12);
      hole.rotateX(Math.PI / 2);
      const holeMat = new THREE.MeshBasicMaterial({ color: 0x0b090d });
      const thread = new THREE.MeshStandardMaterial({ color: 0xf1e7d6, roughness: 0.9 });
      const o = R * 0.26;
      for (const [hx, hy] of [[-o, o], [o, o], [-o, -o], [o, -o]]) add(hole, holeMat, [hx, hy, R * 0.2], [R * 0.1, R * 0.1, R * 0.02]);
      const box = new THREE.BoxGeometry(1, 1, 1);
      for (const a of [Math.PI / 4, -Math.PI / 4]) {
        const t = add(box, thread, [0, 0, R * 0.23], [o * 2 * Math.SQRT2 + R * 0.12, R * 0.06, R * 0.04]);
        t.rotation.z = a;
      }
      break;
    }
  }
  return g;
}

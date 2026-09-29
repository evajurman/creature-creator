import * as THREE from 'three';
import { buildInflatedGeometry, defaultOutline, solidDistance, type Solid, type Vec2 } from './inflate';
import {
  castsShadow,
  setOpacity,
  makeFuzzShells,
  makeMaterial,
  makeOutlineMaterial,
  makeStrayHairs,
  styleSettings,
  type StyleId,
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
}

export interface EyesState {
  enabled: boolean;
  /** one style for every pair */
  style: EyeStyle;
  pairs: EyePair[];
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
  /** rotation about the vertical axis, radians */
  yaw: number;
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
  /** true when the bone starts somewhere other than its parent's tip */
  attach: boolean;
  line: THREE.Line;
  guide: THREE.Group;
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
    eyes: { enabled: true, style: 'googly', pairs: [{ size: 0.5, spacing: 0.5, height: 0.55 }] },
  };
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
for (const m of [tipMat, tipHoverMat, rootMat, lineMat, outlineLineMat, planeMat, startMat]) m.userData.shared = true;
const tipGeo = new THREE.SphereGeometry(0.032, 16, 12);
const startGeo = new THREE.BoxGeometry(0.055, 0.055, 0.055);

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
  const normal = new THREE.Vector3().crossVectors(side, dir).normalize();
  return { length, world: new THREE.Matrix4().makeBasis(side, dir, normal).setPosition(start) };
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
  /** rig editing shows the rest pose and joint handles */
  private rigMode = false;
  private attached = new Map<string, { key: string; main: THREE.Group; twin: THREE.Group | null; twinBone: BoneRT | null }>();

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
      const local = parent ? parent.restWorld.clone().invert().multiply(restWorld) : restWorld.clone();
      const pivot = new THREE.Object3D();
      const scale = new THREE.Vector3();
      local.decompose(pivot.position, pivot.quaternion, scale);
      pivot.userData.boneId = def.id;
      (parent ? parent.pivot : this.group).add(pivot);

      const tip = new THREE.Mesh(tipGeo, tipMat);
      tip.position.set(0, length, 0);
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

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, length, 0)]),
        lineMat,
      );
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
        attach,
        line,
        guide,
      };
      this.bones.set(def.id, rt);
      this.list.push(rt);
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
      const local = b.parent ? b.parent.restWorld.clone().invert().multiply(world) : world.clone();
      local.decompose(b.pivot.position, b.restQuat, new THREE.Vector3());
      b.pivot.quaternion.copy(b.restQuat);
      b.restWorld = world;
      b.def = def;
      if (b.mesh) b.mesh.scale.y = length / b.length;
      b.tip.position.set(0, length, 0);
      b.line.geometry.setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, length, 0)]);
    }
    this.rootHandle.position.copy(this.list[0].pivot.position);
    this.mergeDirty = true;
  }

  setRigMode(on: boolean) {
    this.rigMode = on;
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
    return this.state.parts[b.src].outline ?? defaultOutline(b.length, b.def.width);
  }

  // -------------------------------------------------------------------------
  // sync state -> scene

  applyPlacement() {
    const p = this.state.placement ?? { x: 0, z: 0, yaw: 0 };
    this.root.position.set(p.x, 0, p.z);
    this.root.rotation.set(0, p.yaw, 0);
  }

  /** Read the placement back from the root (after a gizmo drag). */
  capturePlacement() {
    this.state.placement = {
      x: Math.round(this.root.position.x * 1000) / 1000,
      z: Math.round(this.root.position.z * 1000) / 1000,
      yaw: Math.round(this.root.rotation.y * 10000) / 10000,
    };
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
      const geoKey = JSON.stringify([outline, geoOpts]);
      const key = geoKey + style + p.color + JSON.stringify(k) + (p.opacity ?? 1);
      if (key === b.meshKey) continue;
      b.meshKey = key;
      if (b.mesh) {
        b.pivot.remove(b.mesh);
        b.mesh.traverse((o) => {
          ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose();
          if (o instanceof THREE.LineSegments) o.geometry.dispose();
        });
        (b.mesh.userData.mergeGeo as THREE.BufferGeometry | undefined)?.dispose();
      }
      const geo = cachedGeometry(geoKey, () =>
        buildInflatedGeometry(outline, { ...geoOpts, seed: hashString(b.src) }),
      );
      const mesh = new THREE.Mesh(geo, makeMaterial(style, p.color, k));
      mesh.userData.baseGeo = geo;
      mesh.userData.opacity = p.opacity ?? 1;
      mesh.castShadow = castsShadow(style);
      mesh.receiveShadow = true;
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
      const key = JSON.stringify([a.thing.pieces, a.bone, twinBone?.def.id, this.state.materialSettings]);
      let rec = this.attached.get(a.id);
      if (!rec || rec.key !== key) {
        if (rec) this.dropAttachment(rec);
        const settings = (st: StyleId) => this.settingsFor(st);
        const main = new THREE.Group();
        main.add(buildThing(a.thing, settings));
        bone.pivot.add(main);
        let twin: THREE.Group | null = null;
        if (twinBone) {
          twin = new THREE.Group();
          twin.add(buildThing(a.thing, settings));
          twin.matrixAutoUpdate = false;
          twinBone.pivot.add(twin);
        }
        for (const g of [main, twin]) g?.traverse((o) => (o.userData.attachmentId = a.id));
        rec = { key, main, twin, twinBone };
        this.attached.set(a.id, rec);
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
    this.mergeDirty = true;
    for (const b of this.list) {
      const q = this.rigMode ? null : this.state.pose[b.def.id];
      b.pivot.quaternion.copy(b.restQuat);
      if (q) b.pivot.quaternion.multiply(new THREE.Quaternion(...q));
    }
    if (this.rigMode) this.group.position.set(0, 0, 0);
    else this.group.position.set(...this.state.rootOffset);
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

  /** Recompute merged geometry if the pose or parts changed. Cheap when clean. */
  updateMerge() {
    if (!this.mergeDirty) return;
    this.mergeDirty = false;
    const s = this.state;
    const on = s.merge ?? true;
    const k = s.mergeRadius ?? 0.1;
    // with colour blending, parts of one material merge whatever their colour
    const blend = on && !!s.mergeColors;
    const kc = blend ? (s.colorBlend ?? 0.12) : 0;
    this.group.updateMatrixWorld(true);

    const groups = new Map<string, BoneRT[]>();
    for (const b of this.list) {
      if (!b.mesh) continue;
      const p = s.parts[b.src];
      const key = (p.style ?? s.style) + (blend ? '' : p.color.toLowerCase());
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(b);
    }

    for (const [, members] of groups) {
      for (const b of members) {
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
    const tint = painted ? new THREE.Color(1, 1, 1) : new THREE.Color(part.color);
    // body + fuzz shells (stray-hair lines keep their own per-hair colours)
    const mats = [mesh.material, ...mesh.children.filter((c) => c instanceof THREE.Mesh).map((c) => (c as THREE.Mesh).material)];
    for (const m of mats as THREE.MeshStandardMaterial[]) {
      if (!m || !('color' in m) || m.userData?.ink) continue;
      const want = painted || lowPoly;
      if (m.vertexColors !== want) {
        m.vertexColors = want;
        m.needsUpdate = true;
      }
      m.color.copy(tint);
    }
  }

  private near(a: BoneRT, b: BoneRT, k: number): boolean {
    const ga = a.mesh!.userData.baseGeo as THREE.BufferGeometry;
    const gb = b.mesh!.userData.baseGeo as THREE.BufferGeometry;
    const ca = ga.boundingSphere!.center.clone().applyMatrix4(a.mesh!.matrixWorld);
    const cb = gb.boundingSphere!.center.clone().applyMatrix4(b.mesh!.matrixWorld);
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
    const own = new THREE.Color(this.state.parts[b.src].color);

    const toWorld = b.mesh!.matrixWorld;
    const toLocal = toWorld.clone().invert();
    const rotW = new THREE.Matrix3().setFromMatrix4(toWorld);
    const rotL = new THREE.Matrix3().setFromMatrix4(toLocal);
    const myKey = this.state.parts[b.src].color.toLowerCase();
    const others = nbrs.map((o) => {
      const g = o.mesh!.userData.baseGeo as THREE.BufferGeometry;
      const solid = g.userData.solid as Solid;
      // keep fillets in proportion: a thin antenna shouldn't get a huge blob
      const k = Math.max(0.005, Math.min(kMax, 0.6 * Math.min(rA, maxR(solid))));
      const inv = o.mesh!.matrixWorld.clone().invert();
      const colorKey = this.state.parts[o.src].color.toLowerCase();
      return {
        solid,
        k,
        inv,
        rot: new THREE.Matrix3().setFromMatrix4(o.mesh!.matrixWorld),
        box: g.boundingBox!.clone().expandByScalar(Math.max(k, kc)),
        color: new THREE.Color(this.state.parts[o.src].color),
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

    for (let i = 0; i < p0.count; i++) {
      pw.fromBufferAttribute(p0, i).applyMatrix4(toWorld);
      nw.fromBufferAttribute(n0, i).applyMatrix3(rotW).normalize();
      // running smooth-min of (this surface = 0, each neighbour's distance)
      let d = 0;
      gsum.copy(nw);
      let touched = false;
      col.copy(own);
      for (const o of others) {
        q.copy(pw).applyMatrix4(o.inv);
        if (!o.box.containsPoint(q)) continue;
        const f = solidDistance(o.solid, q.x, q.y, q.z, grad);
        if (o.tints && f < kc) {
          // 50/50 at the seam, fading to our own colour kc away from it
          const t = Math.min(1, Math.max(0, 1 - f / kc));
          col.lerp(o.color, 0.5 * t * t * (3 - 2 * t));
        }
        if (f >= o.k) continue;
        gw.copy(grad).applyMatrix3(o.rot).normalize();
        const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (f - d)) / o.k));
        d = f * (1 - h) + d * h - o.k * h * (1 - h);
        gsum.multiplyScalar(h).addScaledVector(gw, 1 - h);
        touched = true;
      }
      if (c1) {
        const j = jitter ? jitter.getX(i) : 1;
        if (kc > 0) c1.setXYZ(i, col.r * j, col.g * j, col.b * j);
        else c1.setXYZ(i, j, j, j);
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
    this.eyes.removeFromParent();
    this.eyes = new THREE.Group();
    if (!head || !head.mesh || !e.enabled) return;
    head.pivot.add(this.eyes);

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
      eye.position.copy(hit.point);
      const style = EYE_STYLES.some((o) => o.id === e.style) ? e.style : 'googly';
      eye.add(buildEye(style, r, sgn, headStyle, this.settingsFor(headStyle)));
      eye.traverse((m) => {
        m.raycast = () => {};
        m.castShadow = true;
      });
      this.eyes.add(eye);
    }
    }
  }

  // -------------------------------------------------------------------------
  // selection / drawing visuals

  select(id: string | null) {
    this.selected = id;
    this.refreshHighlight();
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
      if (!m || !('emissive' in m)) continue;
      if (b.src === src && k > 0) m.emissive.setRGB(1, 0.42, 0.29).multiplyScalar(0.45 * k);
      else m.emissive.setScalar(0);
    }
  }

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

  setSkeletonVisible(v: boolean) {
    for (const b of this.list) {
      b.tip.visible = v;
      b.line.visible = v;
      b.startHandle.visible = v && this.rigMode && b.attach;
    }
    this.rootHandle.visible = v && !this.rigMode;
  }

  setHandleHover(obj: THREE.Object3D | null) {
    for (const b of this.list) {
      b.tip.material = b.tip === obj ? tipHoverMat : tipMat;
      b.startHandle.material = b.startHandle === obj ? tipHoverMat : startMat;
    }
  }

  handles(): THREE.Object3D[] {
    if (this.rigMode) return [...this.list.map((b) => b.startHandle), ...this.list.map((b) => b.tip)];
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

/**
 * Low-poly meshes are non-indexed: each triangle has its own copy of a corner
 * with its own flat normal. Anything that moves vertices along their normal
 * would push those copies apart and tear the seams, so average the normals of
 * every copy sitting at the same position. Indexed meshes already share them.
 */
function sharedNormals(geo: THREE.BufferGeometry): THREE.BufferAttribute {
  const own = geo.getAttribute('normal') as THREE.BufferAttribute;
  if (geo.index) return own;
  const cached = geo.userData.sharedNormals as THREE.BufferAttribute | undefined;
  if (cached) return cached;
  const pos = geo.getAttribute('position');
  const keyOf = (i: number) => `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
  const sums = new Map<string, [number, number, number]>();
  const keys: string[] = [];
  for (let i = 0; i < pos.count; i++) {
    const key = keyOf(i);
    keys.push(key);
    const acc = sums.get(key) ?? [0, 0, 0];
    acc[0] += own.getX(i);
    acc[1] += own.getY(i);
    acc[2] += own.getZ(i);
    sums.set(key, acc);
  }
  const out = new Float32Array(pos.count * 3);
  keys.forEach((key, i) => {
    const [x, y, z] = sums.get(key)!;
    const l = Math.hypot(x, y, z) || 1;
    out.set([x / l, y / l, z / l], i * 3);
  });
  const attr = new THREE.BufferAttribute(out, 3);
  geo.userData.sharedNormals = attr;
  return attr;
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

function buildEye(style: EyeStyle, r: number, sgn: number, headStyle: StyleId, headSettings: StyleSettings): THREE.Object3D {
  const g = new THREE.Group();
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
      // a black bead rendered with the creature's own material
      add(sphereGeo, makeMaterial(headStyle, '#1d1a22', headSettings), [0, 0, -r * 0.3], [r * 0.8, r * 0.8, r * 0.8]);
      break;
    }
    case 'dot': {
      // a flat disc of dark wool/clay pressed onto the face, in the creature's material
      add(sphereGeo, makeMaterial(headStyle, '#2a2730', headSettings), [0, 0, 0], [r * 0.95, r * 0.95, r * 0.28]);
      break;
    }
    case 'button': {
      const R = r * 1.05;
      const mat = new THREE.MeshPhysicalMaterial({ color: 0x2a2230, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.2 });
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

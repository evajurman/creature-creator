import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import {
  bendFromMid,
  bentTip,
  Creature,
  defaultState,
  endForTip,
  EYE_STYLES,
  setSeamlessLowPoly,
  setSeamlessMode,
  type Attachment,
  type BoneRT,
  type CreatureState,
  type EyeFinish,
  type EyeStyle,
  type PartState,
  type Placement,
  type SeamlessMode,
} from './creature';
import { bounds, clipLoop, combineLoops, pointInPolygon, signedArea, smoothLoop, symmetrize, type Vec2 } from './inflate';
import {
  buildThing,
  collection,
  disposeThing,
  downloadText,
  envelope,
  newPiece,
  newThing,
  parseEnvelope,
  putThing,
  removeThing,
  safeFileName,
  uid,
  type BendMode,
  type Piece,
  type Thing,
} from './stuff';
import { STYLE_PARAMS, STYLES, makeMaterial, setGlassEnvironment, styleSettings, type StyleId } from './materials';
import {
  RIGS,
  addLimb,
  deleteLimb,
  deleteSavedRig,
  duplicateLimb,
  expandRig,
  extendBone,
  getRig,
  moveJoint,
  partIds,
  rigFromTemplate,
  saveRig,
  savedRigs,
  splitBone,
  unlinkPair,
  type BoneDef,
  type PartCopy,
  type RigState,
  type V3,
} from './rigs';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------------------------------------------------------------------------
// renderer / scene

const viewport = $('#viewport');
const canvas = $<HTMLCanvasElement>('#gl');
const overlay = $<HTMLCanvasElement>('#overlay');
const octx = overlay.getContext('2d')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
// Shadows don't depend on the camera: the loop redraws the map only when a
// shadow caster or the key light actually changed (see shadowsChanged).
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();

// Render on demand: the loop only draws when something asked for it (any
// input, a commit, camera motion, a merge or skin update...). A couple of
// extra frames cover work that lands in a later rAF callback.
let renderFrames = 3;
function invalidate(frames = 3) {
  renderFrames = Math.max(renderFrames, frames);
}

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
setGlassEnvironment(scene.environment);
scene.environmentIntensity = 0.3;

// Studio lighting: a warm key casting soft shadows, a cool fill, and a rim to
// separate the silhouette from the backdrop. Ambient is kept low so form reads.
const hemi = new THREE.HemisphereLight(0xffffff, 0xbfae98, 0.45);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xfff0dc, 3.2);
key.position.set(2.2, 4.6, 3.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = key.shadow.camera.bottom = -3;
key.shadow.camera.right = key.shadow.camera.top = 3;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 14;
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.015;
key.shadow.radius = 9;
key.shadow.blurSamples = 16;
scene.add(key);
const fill = new THREE.DirectionalLight(0xdce6ff, 0.55);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xfff4f8, 1.4);
scene.add(rim);

// The whole rig of lights can be turned around the scene (Backdrop > Lighting).
// Where each light sits at a turn of 0; the key's is relative to the creatures.
const KEY_AT = new THREE.Vector3(2.2, 0, 3.0);
const FILL_AT = new THREE.Vector3(-4, 1.8, 2.5);
const RIM_AT = new THREE.Vector3(-1.5, 3, -4.5);
const LIGHT_KEY = 'creature-creator/light';
let lightTurn = (() => {
  try {
    return Number(JSON.parse(localStorage.getItem(LIGHT_KEY) ?? '{}').turn) || 0;
  } catch {
    return 0;
  }
})();
function lightSpin(): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(lightTurn));
}
function applyLighting() {
  const q = lightSpin();
  fill.position.copy(FILL_AT).applyQuaternion(q);
  rim.position.copy(RIM_AT).applyQuaternion(q);
  fitShadows();
}

// Invisible floor that only shows shadows and contact occlusion, so the
// backdrop colour is seamless in every direction.
const shadowMat = new THREE.ShadowMaterial({ opacity: 0.55 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), shadowMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
ground.renderOrder = 2; // shadows draw over the mirror veil
scene.add(ground);

// ---------------------------------------------------------------------------
// floor options: none / backdrop (shadow catcher) / mirror / material

type FloorMode = 'none' | 'shadow' | 'mirror' | 'material';
const FLOOR_KEY = 'creature-creator/floor';
const floorPrefs: { mode: FloorMode; style: StyleId; color: string; reflect: number } = (() => {
  const defaults = { mode: 'shadow' as FloorMode, style: 'clay' as StyleId, color: '#d6c7b3', reflect: 0.55 };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(FLOOR_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
})();
let mirror: Reflector | null = null;
// A backdrop-coloured veil over the mirror: reflection strength fades the
// reflection toward the backdrop, so the floor stays seamless at the horizon.
const veil = new THREE.Mesh(
  new THREE.CircleGeometry(40, 96),
  new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
);
veil.rotation.x = -Math.PI / 2;
veil.position.y = -0.0005;
veil.renderOrder = 1;
veil.visible = false;
scene.add(veil);
let floorMesh: THREE.Mesh | null = null;
let floorKey = '';

function saveFloor() {
  try {
    localStorage.setItem(FLOOR_KEY, JSON.stringify(floorPrefs));
  } catch {
    /* ignore */
  }
}

/** Veil and fog both match the (tone-compensated) backdrop exactly. */
function refreshFloorColors() {
  const bg = scene.background as THREE.Color | null;
  if (!bg) return;
  (veil.material as THREE.MeshBasicMaterial).color.copy(bg);
  if (scene.fog) (scene.fog as THREE.Fog).color.copy(bg);
}

function sizeMirror() {
  if (!mirror) return;
  const dpr = Math.min(devicePixelRatio, 2);
  mirror.getRenderTarget().setSize(Math.round(viewport.clientWidth * dpr), Math.round(viewport.clientHeight * dpr));
}

/** A real floor surface in one of the creature materials. */
function buildFloorMesh() {
  const settings = styleSettings(floorPrefs.style, state.materialSettings?.[floorPrefs.style]);
  const key = JSON.stringify([floorPrefs.style, floorPrefs.color, settings]);
  if (floorMesh && key === floorKey) return;
  floorKey = key;
  if (floorMesh) {
    scene.remove(floorMesh);
    (floorMesh.material as THREE.Material).dispose();
    floorMesh.geometry.dispose();
  }
  let geo: THREE.BufferGeometry = new THREE.PlaneGeometry(50, 50, 100, 100);
  geo.rotateX(-Math.PI / 2);
  if (floorPrefs.style === 'lowpoly') {
    // a gently faceted ground with per-facet shade variation
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) pos.setY(i, (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.02);
    geo = geo.toNonIndexed();
    geo.computeVertexNormals();
    const n = geo.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    for (let f = 0; f < n; f += 3) {
      const k = 0.9 + ((Math.sin(f * 78.233) * 43758.5453) % 1 + 1) % 1 * 0.12;
      for (let j = 0; j < 3; j++) colors.set([k, k, k], (f + j) * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  floorMesh = new THREE.Mesh(geo, makeMaterial(floorPrefs.style, floorPrefs.color, settings));
  floorMesh.position.y = -0.002;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);
}

function applyFloor() {
  const m = floorPrefs.mode;
  ground.visible = m === 'shadow' || m === 'mirror';
  if (m === 'mirror' && !mirror) {
    mirror = new Reflector(new THREE.CircleGeometry(40, 96), { clipBias: 0.003, color: 0xffffff, textureWidth: 1024, textureHeight: 1024 });
    mirror.rotation.x = -Math.PI / 2;
    mirror.position.y = -0.001;
    scene.add(mirror);
    sizeMirror();
  }
  if (mirror) mirror.visible = m === 'mirror';
  veil.visible = m === 'mirror';
  (veil.material as THREE.MeshBasicMaterial).opacity = 1 - floorPrefs.reflect;
  if (m === 'material') buildFloorMesh();
  if (floorMesh) floorMesh.visible = m === 'material';
  // a real floor fades into the backdrop instead of ending at a hard edge
  scene.fog = m === 'material' ? new THREE.Fog(0xffffff, 5, 20) : null;
  refreshFloorColors();
}

const BG_KEY = 'creature-creator/bg';
const BACKDROPS = ['#f5efe4', '#fbe3e1', '#e3efe0', '#dfe9f5', '#ebe3f5', '#fff4c7', '#3a3340', '#1d2433'];
let backdrop = localStorage.getItem(BG_KEY) ?? BACKDROPS[0];

/** three's Neutral tone mapping (exposure 1), mirrored in JS. */
function neutralTone([r, g, b]: number[]): number[] {
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  let c = [r - offset, g - offset, b - offset];
  const peak = Math.max(...c);
  const start = 0.76;
  if (peak < start) return c;
  const d = 1 - start;
  const newPeak = 1 - (d * d) / (peak + d - start);
  c = c.map((v) => (v * newPeak) / peak);
  const k = 1 - 1 / (0.15 * (peak - newPeak) + 1);
  return c.map((v) => v + (newPeak - v) * k);
}

/** Pre-compensate a colour so it comes out of tone mapping unchanged. */
function untoned(target: THREE.Color): THREE.Color {
  const want = [target.r, target.g, target.b];
  let c = want.slice();
  for (let i = 0; i < 40; i++) {
    const got = neutralTone(c);
    c = c.map((v, j) => Math.min(8, Math.max(0, v + (want[j] - got[j]))));
  }
  return new THREE.Color(c[0], c[1], c[2]);
}

function setBackdrop(hex: string) {
  backdrop = hex;
  const c = new THREE.Color(hex);
  scene.background = untoned(c);
  // tint the shadow toward a deeper, slightly cooler version of the backdrop
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  shadowMat.color.setHSL((hsl.h + 0.02) % 1, Math.min(1, hsl.s * 0.8 + 0.1), hsl.l * 0.25);
  hemi.groundColor.copy(c).multiplyScalar(0.8);
  refreshFloorColors();
  try {
    localStorage.setItem(BG_KEY, hex);
  } catch {
    /* ignore */
  }
}
setBackdrop(backdrop);

const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
camera.position.set(2.8, 2.0, 4.4);

// Post-processing: MSAA scene render, ground-truth ambient occlusion for the
// creases where parts meet and contact shadows on the floor, then tone mapping.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, 1, 1);
gtao.updateGtaoMaterial({ radius: 0.28, distanceExponent: 1.6, thickness: 1.2, scale: 1.3, samples: 16 });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
gtao.blendIntensity = 1.0;
// GTAO's normal/depth pass draws every mesh with one override material, so felt
// fuzz shells lose their offset and land exactly on the surface they cover:
// twelve redundant copies. Hide them for that pass (the result is identical).
const gtaoRender = gtao.render.bind(gtao);
gtao.render = (...args: Parameters<GTAOPass['render']>) => {
  const shells: THREE.Object3D[] = [];
  scene.traverseVisible((o) => {
    if (o.userData.fx && o instanceof THREE.Mesh) shells.push(o);
  });
  shells.forEach((o) => (o.visible = false));
  try {
    gtaoRender(...args);
  } finally {
    shells.forEach((o) => (o.visible = true));
  }
};
composer.addPass(gtao);
// optional macro-photo depth of field, focused on whatever the camera orbits
const bokeh = new BokehPass(scene, camera, { focus: 5, aperture: 0.004, maxblur: 0.012 });
bokeh.enabled = false;
composer.addPass(bokeh);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// state + history

/**
 * The whole scene: several creatures, one of which is active. `state` and
 * `creature` always point at the active one, so every panel and tool works on
 * whichever creature is selected.
 */
interface World {
  creatures: CreatureState[];
  active: number;
  /** the thing on the Stuff workbench (shared by the whole scene) */
  workbench?: Thing;
  /** scene name, used for .scene files */
  name?: string;
}

const WORLD_KEY = 'creature-creator/world';
const OLD_KEY = 'creature-creator/v1';
let world: World = loadWorld() ?? { creatures: [defaultState(rigFromTemplate(RIGS[0]))], active: 0 };
let state: CreatureState = world.creatures[world.active];
const creatures: Creature[] = [];
let creature: Creature;
let selected = '';
type Mode = 'build' | 'rig' | 'pose' | 'stuff';
let mode: Mode = 'build';
let eyePair = 0;

function loadWorld(): World | null {
  try {
    const raw = localStorage.getItem(WORLD_KEY);
    if (raw) {
      const w = JSON.parse(raw) as World;
      const list = (w.creatures ?? []).map(migrate).filter((s): s is CreatureState => !!s);
      if (list.length) return { creatures: list, active: Math.min(Math.max(0, w.active ?? 0), list.length - 1), workbench: w.workbench };
    }
    // the single-creature autosave from before scenes existed
    const old = localStorage.getItem(OLD_KEY);
    const s = old ? migrate(JSON.parse(old)) : null;
    if (s) {
      const workbench = s.workbench;
      delete s.workbench;
      return { creatures: [s], active: 0, workbench };
    }
  } catch {
    /* fall through to a fresh scene */
  }
  return null;
}

/** Bring a saved creature (autosave or file) up to the current format. */
function migrate(data: unknown): CreatureState | null {
  try {
    const s = data as CreatureState & { rigId?: string };
    if (!s || typeof s !== 'object' || !s.parts) return null;
    // saves from before rigs were editable: adopt the template, drop the old-format pose
    if (!s.rig) {
      const t = RIGS.find((r) => r.id === s.rigId);
      if (!t) return null;
      s.rig = rigFromTemplate(t);
      s.pose = {};
      delete s.rigId;
    }
    const e = s.eyes as Partial<CreatureState['eyes']> & { size?: number; spacing?: number; height?: number };
    if (!e.pairs) {
      s.eyes = {
        enabled: e.enabled ?? true,
        style: e.style ?? 'googly',
        pairs: [{ size: e.size ?? 0.5, spacing: e.spacing ?? 0.5, height: e.height ?? 0.55 }],
      };
    }
    return s;
  } catch {
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(WORLD_KEY, JSON.stringify(world));
  } catch {
    /* storage full or blocked; nothing to do */
  }
}

const history: string[] = [];
let hIndex = -1;

function commit() {
  invalidate();
  world.creatures[world.active] = state;
  const snap = JSON.stringify(world);
  if (snap === history[hIndex]) return;
  history.splice(hIndex + 1);
  history.push(snap);
  if (history.length > 120) history.shift();
  hIndex = history.length - 1;
  save();
  updateUndo();
  fitShadows();
}

function restore(snap: string) {
  invalidate();
  const next = JSON.parse(snap) as World;
  // Rebuild only creatures whose skeleton changed (or that are new); the rest
  // just take their restored state.
  for (let i = 0; i < next.creatures.length; i++) {
    const s = next.creatures[i];
    const c = creatures[i];
    if (c && JSON.stringify(c.state.rig) === JSON.stringify(s.rig)) {
      c.state = s;
      c.sync();
      // merge settings may differ without any part or pose changing
      c.markMergeDirty();
    } else {
      c?.dispose();
      creatures[i] = makeCreature(s);
    }
  }
  while (creatures.length > next.creatures.length) creatures.pop()!.dispose();
  world = next;
  activate(world.active);
  syncWorkbench();
  if (selectedAttachment) selectAttachment(selectedAttachment);
  save();
  fitShadows();
  renderUI();
}

function undo() {
  if (hIndex <= 0) return;
  if (drawState) exitDraw(); // a shape waiting for Done isn't in the history yet
  restore(history[--hIndex]);
  updateUndo();
}

function redo() {
  if (hIndex >= history.length - 1) return;
  if (drawState) exitDraw();
  restore(history[++hIndex]);
  updateUndo();
}

function updateUndo() {
  $<HTMLButtonElement>('#undo').disabled = hIndex <= 0;
  $<HTMLButtonElement>('#redo').disabled = hIndex >= history.length - 1;
}

function makeCreature(s: CreatureState): Creature {
  const c = new Creature(s);
  scene.add(c.root);
  c.root.visible = mode !== 'stuff';
  c.setSkeletonVisible(false);
  return c;
}

/** Make creature `i` the one every panel and tool works on. */
function activate(i: number) {
  const next = creatures[i];
  const switching = creature !== next;
  if (creature && switching) {
    creature.setRigMode(false);
    creature.setSkeletonVisible(false);
    creature.flash(null, 0);
  }
  // gizmos belong to the previous creature
  if (switching) stopPlacing();
  world.active = i;
  state = world.creatures[i];
  creature = next;
  if (switching) deselectAttachment();
  creature.setRigMode(mode === 'rig');
  if (!creature.bones.has(selected)) selected = creature.list[0].def.id;
  creature.select(selected);
  updateSkeletonVisibility();
}

/** Rebuild the active creature from `state` (after skeleton changes, new files...). */
function buildCreature() {
  const i = world.active;
  const wasPlacing = placing;
  creatures[i]?.dispose();
  world.creatures[i] = state;
  creatures[i] = makeCreature(state);
  creature = creatures[i];
  creature.setRigMode(mode === 'rig');
  if (!creature.bones.has(selected)) selected = creature.list[0].def.id;
  creature.select(selected);
  updateSkeletonVisibility();
  // gizmos pointed at the old creature's objects
  if (selectedAttachment) selectAttachment(selectedAttachment);
  if (wasPlacing) startPlacing();
}

/** Keep the key light's shadow area covering every creature. */
function fitShadows() {
  const box = new THREE.Box3();
  for (const c of creatures) {
    c.root.updateMatrixWorld(true);
    for (const m of c.meshes()) box.expandByObject(m);
  }
  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const half = box.isEmpty() ? 3 : Math.max(3, box.getSize(new THREE.Vector3()).length() / 2 + 1);
  const cam = key.shadow.camera;
  cam.left = cam.bottom = -half;
  cam.right = cam.top = half;
  cam.far = 14 + half;
  cam.updateProjectionMatrix();
  key.target.position.set(center.x, 0, center.z);
  const off = KEY_AT.clone().applyQuaternion(lightSpin());
  key.position.set(center.x + off.x, 4.6 + half * 0.3, center.z + off.z);
  key.target.updateMatrixWorld();
}

// ---------------------------------------------------------------------------
// controls (our pointer handlers are registered first so they can veto orbiting)

const raycaster = new THREE.Raycaster();
const pointer = { downX: 0, downY: 0, moved: false };
let drag: {
  id: string;
  kind: 'root' | 'start' | 'end' | 'bend';
  plane: THREE.Plane;
  offset: THREE.Vector3;
  startHit: THREE.Vector3;
  /** rig mode: skeleton at the start of the drag, so each move re-applies from scratch */
  rigBase?: string;
  /**
   * rig mode: turns a world-space move into the bone's own skeleton space. A
   * bone hanging off a bendy one is shown turned along the curve, so the
   * pointer's motion has to be turned back before it's applied.
   */
  toDef?: THREE.Quaternion;
  moved: boolean;
} | null = null;

canvas.addEventListener('pointerdown', (e) => {
  pointer.downX = e.clientX;
  pointer.downY = e.clientY;
  pointer.moved = false;
  if (e.button !== 0 || pickingFocus || !handlesVisible()) return;
  const h = pickHandle(e.clientX, e.clientY);
  if (!h) return;
  controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
  const pos = h.getWorldPosition(new THREE.Vector3());
  const id = h.userData.handle as string;
  const normal =
    id === 'root' ? new THREE.Vector3(0, 1, 0) : camera.getWorldDirection(new THREE.Vector3()).negate();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pos);
  // the root offset lives inside the creature's placement, so work in its local space
  const offset = id === 'root' ? creature.group.position.clone().sub(creature.root.worldToLocal(pos.clone())) : new THREE.Vector3();
  const kind = id === 'root' ? 'root' : (h.userData.kind as 'start' | 'end' | 'bend');
  let toDef: THREE.Quaternion | undefined;
  const b = creature.bones.get(id);
  if (mode === 'rig' && b) {
    b.pivot.updateMatrixWorld(true);
    toDef = new THREE.Quaternion().setFromRotationMatrix(b.restWorld.clone().multiply(b.pivot.matrixWorld.clone().invert()));
  }
  drag = { id, kind, plane, offset, startHit: pos, moved: false, rigBase: mode === 'rig' ? JSON.stringify(state.rig) : undefined, toDef };
  $('#viewport').style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (e) => {
  if (Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) > 5) pointer.moved = true;
  if (drag) {
    setRay(e.clientX, e.clientY);
    const hit = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (!hit) return;
    drag.moved = drag.moved || pointer.moved;
    if (drag.rigBase && drag.kind === 'bend') {
      // the green diamond: put the bone's middle where the pointer is
      if (!drag.moved) return;
      const b = creature.bones.get(drag.id);
      const def = b && state.rig.bones.find((x) => x.id === b.def.baseId);
      if (!b || !def) return;
      const { bend, dir } = bendFromMid(b.length, b.pivot.worldToLocal(hit.clone()));
      def.bendy = bend > 0.01;
      def.bend = Math.round(bend * 1000) / 1000;
      // defs describe the left twin; a right twin's direction is mirrored
      def.bendDir = Math.round((b.def.sideSign === -1 ? -dir : dir) * 1000) / 1000;
      creature.relayout(state.rig);
      creature.sync();
    } else if (drag.rigBase && drag.kind !== 'root' && drag.kind !== 'bend') {
      if (!drag.moved) return;
      // the move in skeleton coordinates (the creature may be turned, the bone may ride a curve)
      const d = hit.clone().sub(drag.startHit).applyQuaternion(drag.toDef ?? creature.root.quaternion.clone().invert());
      state.rig = JSON.parse(drag.rigBase) as RigState;
      const ex = drag.kind === 'end' ? expandRig(state.rig).bones.find((x) => x.id === drag!.id) : undefined;
      if (ex?.bendy && ex.bend) {
        // a bendy bone's tip sits off its straight line: move the end so the tip follows the pointer
        d.copy(endForTip(ex, bentTip(ex).add(d))).sub(new THREE.Vector3(...ex.end));
      }
      moveJoint(state.rig, drag.id, drag.kind, d.toArray() as V3, rigLocked());
      creature.relayout(state.rig);
    } else if (drag.id === 'root') {
      creature.group.position.copy(creature.root.worldToLocal(hit).add(drag.offset));
      creature.group.position.y = Math.max(creature.group.position.y, -1);
    } else {
      creature.dragTip(drag.id, hit, $<HTMLInputElement>('#ik').checked);
    }
    return;
  }
  if (handlesVisible() && e.buttons === 0) {
    const h = pickHandle(e.clientX, e.clientY);
    creature.setHandleHover(h);
    $('#viewport').style.cursor = h ? 'grab' : '';
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (drag) {
    const d = drag;
    drag = null;
    controls.enabled = true;
    $('#viewport').style.cursor = '';
    if (d.rigBase) {
      if (d.moved) {
        // rebuild meshes at their new lengths and re-seat the pose
        if (!state.rig.base.startsWith('custom')) state.rig.base = 'custom';
        buildCreature();
        commit();
      }
      selectPart(d.id);
      return;
    }
    creature.capturePose();
    commit();
    return;
  }
  if (pointer.moved || e.button !== 0 || gizmo.dragging) return;
  if (pickingFocus) {
    focusAt(e.clientX, e.clientY);
    return;
  }
  if (mode === 'stuff') {
    const id = pickPiece(e.clientX, e.clientY);
    if (id) {
      selectedPiece = id;
      flashPart();
      renderStuffPanel();
    }
    return;
  }
  // clicking a different creature makes it the one being edited
  const other = pickOtherCreature(e.clientX, e.clientY);
  if (other) {
    activate(other.index);
    if (other.boneId && creature.bones.has(other.boneId)) selected = other.boneId;
    creature.select(selected);
    flashPart();
    save();
    renderUI();
    hint(`Now editing ${creatureLabel(other.index)}`, 1600);
    return;
  }
  if (mode === 'build') {
    const att = pickAttachment(e.clientX, e.clientY);
    if (att) {
      const a = state.attachments?.find((x) => x.id === att);
      if (a && creature.bones.has(a.bone)) selectPart(a.bone);
      selectAttachment(att);
      return;
    }
  }
  const id = pickPart(e.clientX, e.clientY);
  if (id) {
    deselectAttachment();
    selectPart(id);
  }
});

canvas.addEventListener('dblclick', (e) => {
  if (mode === 'stuff') return;
  const other = pickOtherCreature(e.clientX, e.clientY);
  if (other) activate(other.index);
  const id = pickPart(e.clientX, e.clientY);
  if (!id) return;
  selectPart(id);
  if (mode !== 'build') setMode('build');
  enterDraw();
});

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.target.set(0, 0.9, 0);
controls.minDistance = 0.6;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI * 0.53;
controls.autoRotateSpeed = 2.5;
controls.update();

function setRay(clientX: number, clientY: number) {
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1),
    camera,
  );
}

/** If the pointer is over a creature other than the active one, which one (and which part). */
function pickOtherCreature(x: number, y: number): { index: number; boneId?: string } | null {
  if (creatures.length < 2) return null;
  setRay(x, y);
  const targets = creatures.flatMap((c) => [...c.meshes(), ...c.attachmentMeshes()]);
  const hit = raycaster.intersectObjects(targets, false)[0];
  if (!hit) return null;
  let o: THREE.Object3D | null = hit.object;
  while (o && !creatures.some((c) => c.root === o)) o = o.parent;
  const index = creatures.findIndex((c) => c.root === o);
  if (index < 0 || index === world.active) return null;
  return { index, boneId: hit.object.userData.boneId as string | undefined };
}

function creatureLabel(i: number): string {
  return world.creatures[i]?.name?.trim() || `Creature ${i + 1}`;
}

function pickPart(x: number, y: number): string | null {
  setRay(x, y);
  const hit = raycaster.intersectObjects(creature.meshes(), false)[0];
  return hit ? (hit.object.userData.boneId as string) : null;
}

/** Handles are tiny, so pick the nearest one in screen space. */
function pickHandle(x: number, y: number): THREE.Object3D | null {
  const r = canvas.getBoundingClientRect();
  let best: THREE.Object3D | null = null;
  let bestD = 16;
  const v = new THREE.Vector3();
  for (const h of creature.handles()) {
    if (!h.visible) continue;
    h.getWorldPosition(v).project(camera);
    if (v.z > 1) continue;
    const sx = r.left + ((v.x + 1) / 2) * r.width;
    const sy = r.top + ((1 - v.y) / 2) * r.height;
    const d = Math.hypot(sx - x, sy - y);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

function handlesVisible() {
  return !drawState && mode !== 'stuff' && (mode !== 'build' || $<HTMLInputElement>('#skeleton-build').checked);
}

function updateSkeletonVisibility() {
  creature.setSkeletonVisible(handlesVisible());
}

// ---------------------------------------------------------------------------
// camera tweening

let tween: { p0: THREE.Vector3; p1: THREE.Vector3; t0v: THREE.Vector3; t1v: THREE.Vector3; start: number; dur: number } | null = null;

function flyTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 650) {
  tween = { p0: camera.position.clone(), p1: pos, t0v: controls.target.clone(), t1v: target, start: performance.now(), dur };
}

/** Tight bounds of the posed creature: body parts plus any stuff it's wearing. */
function creatureBox(precise = false): THREE.Box3 {
  creature.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  // parts count even while hidden: a settled seamless skin hides the parts it
  // replaced, which used to leave an empty box (and camera views did nothing)
  for (const m of creature.meshes()) box.expandByObject(m, precise);
  for (const m of creature.attachmentMeshes()) if (m.visible) box.expandByObject(m, precise);
  return box;
}

const THREE_QUARTER = new THREE.Vector3(0.62, 0.32, 0.72).normalize();

/** Frame every creature in the scene, keeping the current viewing angle. */
function frameAll() {
  const box = new THREE.Box3();
  for (const c of creatures) {
    c.root.updateMatrixWorld(true);
    for (const m of c.meshes()) box.expandByObject(m);
  }
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const dir = camera.position.clone().sub(controls.target).normalize();
  const dist = (radius * 0.95) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  flyTo(center.clone().addScaledVector(dir, Math.max(dist, 2)), center);
}

/** Fly to frame the creature, keeping the current angle unless a view direction is given. */
function frameCreature(view: boolean | THREE.Vector3 = false) {
  const box = creatureBox();
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const dir =
    view instanceof THREE.Vector3
      ? view.clone().normalize()
      : view
        ? THREE_QUARTER.clone()
        : camera.position.clone().sub(controls.target).normalize();
  const dist = (radius * 0.95) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  flyTo(center.clone().addScaledVector(dir, Math.max(dist, 2)), center);
}

// The creature faces +Z; "left"/"right" are as seen by someone facing it.
// Top is nudged off the pole so the orbit camera keeps a sensible "up".
const VIEWS: Record<string, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0, 1),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, 1, 0.002),
  quarter: THREE_QUARTER,
};

function viewFrom(name: string) {
  if (name === 'all') {
    if (mode === 'stuff') focusOnBoard();
    else frameAll();
    return;
  }
  const dir = VIEWS[name];
  if (!dir) return;
  controls.autoRotate = false;
  $('#spin').classList.remove('on');
  if (mode === 'stuff') {
    const c = board.getWorldPosition(new THREE.Vector3());
    let r = 0.7;
    if (bench) {
      const box = new THREE.Box3().setFromObject(bench);
      if (!box.isEmpty()) {
        box.getCenter(c);
        r = Math.max(0.5, box.getSize(new THREE.Vector3()).length() * 0.7);
      }
    }
    const dist = Math.max(1.4, r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    flyTo(c.clone().addScaledVector(dir.clone().normalize(), dist), c);
    return;
  }
  frameCreature(dir);
}

/** Pose mode: lower (or raise) the whole creature so its lowest point rests on the floor. */
function dropToFloor() {
  const box = creatureBox(true);
  if (box.isEmpty()) return;
  if (Math.abs(box.min.y) < 1e-4) {
    hint('Already on the floor', 1500);
    return;
  }
  creature.group.position.y -= box.min.y;
  creature.capturePose();
  commit();
  hint('Dropped to the floor', 1500);
}

function focusOnBone(b: BoneRT) {
  b.pivot.updateMatrixWorld(true);
  const bb = bounds(creature.outlineFor(b));
  const center = b.pivot.localToWorld(new THREE.Vector3((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, 0));
  const r = Math.max(bb.w, bb.h, b.length) / 2;
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(b.pivot.matrixWorld);
  const toCam = camera.position.clone().sub(controls.target).normalize();
  if (normal.dot(toCam) < 0) normal.negate();
  if (Math.abs(normal.y) > 0.97) normal.add(new THREE.Vector3(0, 0, 0.1)).normalize(); // dodge orbit pole
  const dist = (r * 2.2 + 0.3) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  flyTo(center.clone().addScaledVector(normal, dist), center);
}

// ---------------------------------------------------------------------------
// drawing

/** What a stroke is for: a body part's outline, or a piece (or hole) on the stuff workbench. */
type DrawTarget = { kind: 'bone'; boneId: string } | { kind: 'piece'; hole: boolean };
/** What dragging on the drawing does once there's a shape: add to it, cut from it, or move, resize or turn it. */
type DrawTool = 'draw' | 'erase' | 'move' | 'scale' | 'rotate';
type ShapeKind = 'square' | 'triangle' | 'circle';

interface DrawState {
  target: DrawTarget;
  /** object whose local XY plane is drawn on */
  frame: THREE.Object3D;
  label: string;
  /** symmetry axis (x = 0) drawn between these local points */
  axis: [Vec2, Vec2];
  /** stroke in screen space, after the stabiliser */
  pts: Vec2[];
  /** the same stroke in the drawing plane, for the mirror preview */
  local: Vec2[];
  /** stabiliser position */
  pen: Vec2 | null;
  active: boolean;
  /**
   * The finished shape, waiting for Done: one loop, or a mirrored pair of
   * pieces. In the drawing plane.
   */
  pending: Vec2[][] | null;
  /** cut-outs in the pending shape (from erasing inside it), in the same space */
  holes: Vec2[][];
  tool: DrawTool;
  /** Move / Scale / Rotate: the shape and pointer as the drag began, in the drawing plane */
  grab: { start: Vec2; outers: Vec2[][]; holes: Vec2[][]; centre: Vec2 } | null;
  /** a basic shape waiting to be placed: click to put it down, drag to size it */
  stamp: ShapeKind | null;
  /** the stamp being dragged out: centre and size in the drawing plane, and where the press was on screen */
  stampDrag: { centre: Vec2; r: number; x: number; y: number } | null;
  /** a bone's outline from before drawing: the shape previews live on the part, and this goes back on cancel */
  original?: Vec2[] | null;
}
let drawState: DrawState | null = null;

const DRAW_PREFS_KEY = 'creature-creator/draw';
const drawPrefs: { symmetry: boolean; smoothing: number } = (() => {
  try {
    return { symmetry: true, smoothing: 0.5, ...JSON.parse(localStorage.getItem(DRAW_PREFS_KEY) ?? '{}') };
  } catch {
    return { symmetry: true, smoothing: 0.5 };
  }
})();
function saveDrawPrefs() {
  try {
    localStorage.setItem(DRAW_PREFS_KEY, JSON.stringify(drawPrefs));
  } catch {
    /* ignore */
  }
}

function drawHint() {
  if (!drawState) return;
  const { label, target } = drawState;
  if (drawState.stamp) {
    const what = drawState.tool === 'erase' && drawState.pending ? 'cut out' : 'put down';
    hint(`Click to ${what} a ${drawState.stamp}, or drag to size it`, 0);
    return;
  }
  if (drawState.pending) {
    const msg = {
      draw: 'Draw more to add to the shape. Press Done (Enter) to keep it',
      erase: 'Draw over the parts to cut away. Press Done (Enter) to keep it',
      move: 'Drag the shape to move it. Press Done (Enter) to keep it',
      scale: 'Drag away from the middle to make it bigger (Shift keeps its proportions)',
      rotate: 'Drag around the middle to turn the shape',
    }[drawState.tool];
    hint(msg, 0);
    return;
  }
  if (target.kind === 'piece') {
    const what = target.hole ? 'a hole inside the selected piece' : 'a piece';
    hint(drawPrefs.symmetry ? `Draw ${what}: across the dashed line = one symmetric shape, to one side = a mirrored pair` : `Draw ${what} as one closed loop`, 0);
    return;
  }
  hint(drawPrefs.symmetry ? `Draw one half of the ${label}; it mirrors across the dashed line` : `Draw the ${label} as one closed loop`, 0);
}

function enterDraw(target: DrawTarget = { kind: 'bone', boneId: selected }) {
  if (drawState) exitDraw();
  controls.autoRotate = false;
  $('#spin').classList.remove('on');
  deselectAttachment();
  if (target.kind === 'bone') {
    const b = creature.bones.get(target.boneId);
    if (!b) return;
    const reach = Math.max(b.length, b.def.width) * 2.5 + 0.5;
    drawState = {
      target,
      frame: b.pivot,
      label: partLabel(b.src).toLowerCase(),
      axis: [[0, b.length / 2 - reach], [0, b.length / 2 + reach]],
      pts: [],
      local: [],
      pen: null,
      active: false,
      pending: null,
      holes: [],
      tool: 'draw',
      grab: null,
      stamp: null,
      stampDrag: null,
      original: state.parts[b.src].outline,
    };
    creature.setDrawFocus(target.boneId);
    // other creatures step aside while you draw on this one
    for (const c of creatures) if (c !== creature) c.root.visible = false;
    focusOnBone(b);
  } else {
    drawState = { target, frame: board, label: 'piece', axis: [[0, -1.3], [0, 1.3]], pts: [], local: [], pen: null, active: false, pending: null, holes: [], tool: 'draw', grab: null, stamp: null, stampDrag: null };
    // pieces are drawn flat: show the thing unbent meanwhile
    syncWorkbench();
    focusOnBoard();
  }
  overlay.classList.add('active');
  $('#draw-bar').hidden = false;
  syncDrawBar();
  updateSkeletonVisibility();
  drawHint();
}

/** Leave drawing. Unless the shape is being kept (Done), a bone's previewed outline goes back. */
function exitDraw(keep = false) {
  const ds = drawState;
  drawState = null;
  overlay.classList.remove('active');
  $('#draw-bar').hidden = true;
  if (ds?.target.kind === 'bone' && ds.pending && !keep) {
    const b = creature.bones.get(ds.target.boneId);
    if (b) state.parts[b.src].outline = ds.original ?? null;
    creature.sync();
  }
  creature.setDrawFocus(null);
  if (ds?.target.kind === 'piece') syncWorkbench();
  for (const c of creatures) c.root.visible = mode !== 'stuff';
  updateSkeletonVisibility();
  octx.clearRect(0, 0, overlay.width, overlay.height);
  hint('');
}

function syncDrawBar() {
  $<HTMLInputElement>('#sym').checked = drawPrefs.symmetry;
  $<HTMLInputElement>('#smooth').value = String(drawPrefs.smoothing);
  $('#sym-label').classList.toggle('on', drawPrefs.symmetry);
  const has = !!drawState?.pending;
  $<HTMLButtonElement>('#done-draw').disabled = !has;
  $<HTMLButtonElement>('#reset-draw').disabled = !has;
  const tool = drawState?.tool ?? 'draw';
  document.querySelectorAll<HTMLButtonElement>('#draw-tools [data-tool]').forEach((b) => {
    b.classList.toggle('on', b.dataset.tool === tool);
    // everything but drawing needs something to work on
    b.disabled = b.dataset.tool !== 'draw' && !has;
  });
  document.querySelectorAll<HTMLButtonElement>('#draw-bar [data-shape]').forEach((b) => b.classList.toggle('on', b.dataset.shape === drawState?.stamp));
  const stamping = !!drawState?.stamp;
  overlay.classList.toggle('erasing', tool === 'erase' && !stamping);
  overlay.classList.toggle('moving', !stamping && (tool === 'move' || tool === 'scale' || tool === 'rotate'));
}

function toggleSymmetry() {
  drawPrefs.symmetry = !drawPrefs.symmetry;
  saveDrawPrefs();
  syncDrawBar();
  drawHint();
  renderOverlay();
}

function partPlane(frame: THREE.Object3D): THREE.Plane {
  frame.updateMatrixWorld(true);
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(frame.matrixWorld);
  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, frame.getWorldPosition(new THREE.Vector3()));
}

function screenToLocal(frame: THREE.Object3D, plane: THREE.Plane, x: number, y: number): Vec2 | null {
  setRay(x, y);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  const l = frame.worldToLocal(hit);
  return [Math.round(l.x * 1e4) / 1e4, Math.round(l.y * 1e4) / 1e4];
}

/** Drawing-plane point -> overlay pixel coordinates. */
function localToOverlay(frame: THREE.Object3D, [x, y]: Vec2): Vec2 {
  const v = frame.localToWorld(new THREE.Vector3(x, y, 0)).project(camera);
  return [((v.x + 1) / 2) * overlay.clientWidth, ((1 - v.y) / 2) * overlay.clientHeight];
}

function strokeToLocal(frame: THREE.Object3D, pts: Vec2[]): Vec2[] {
  const plane = partPlane(frame);
  const out: Vec2[] = [];
  for (const [x, y] of pts) {
    const p = screenToLocal(frame, plane, x, y);
    if (!p) continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.003) out.push(p);
  }
  return out;
}

function tooSmall(loop: Vec2[], minArea: number, minSize: number) {
  const bb = loop.length ? bounds(loop) : null;
  return !bb || loop.length < 6 || Math.abs(signedArea(loop)) < minArea || Math.max(bb.w, bb.h) < minSize;
}

/** A body part stroke: mirrored across the centre line (if on), then smoothed. */
function boneLoops(raw: Vec2[]): Vec2[][] {
  let local = raw;
  if (local.length >= 6) {
    if (drawPrefs.symmetry) local = symmetrize(local);
    local = smoothLoop(local, drawPrefs.smoothing);
  }
  return [local];
}

/** A workbench stroke: across the centre line = one symmetric piece, off to one side = a mirrored pair. */
function pieceLoops(raw: Vec2[]): Vec2[][] {
  let loops: Vec2[][] = [raw];
  if (raw.length >= 6 && drawPrefs.symmetry) {
    const crosses = raw.some((p) => p[0] > 0.01) && raw.some((p) => p[0] < -0.01);
    // a half-outline that starts and ends on the axis also means "one symmetric shape"
    const tol = Math.max(0.03, bounds(raw).w * 0.15);
    const half = Math.abs(raw[0][0]) < tol && Math.abs(raw[raw.length - 1][0]) < tol;
    loops = crosses || half ? [symmetrize(raw)] : [raw, raw.map(([x, y]) => [-x, y] as Vec2).reverse()];
  }
  return loops.map((l) => (l.length >= 6 ? smoothLoop(l, drawPrefs.smoothing) : l));
}

function finishStroke() {
  if (!drawState) return;
  const ds = drawState;
  const raw = strokeToLocal(ds.frame, ds.pts);
  ds.pts = [];
  ds.local = [];
  ds.active = false;
  if (ds.pending) {
    combineStroke(ds, raw);
    return;
  }
  const isPiece = ds.target.kind === 'piece';
  const loops = isPiece ? pieceLoops(raw) : boneLoops(raw);
  if (loops.some((l) => (isPiece ? tooSmall(l, 0.0002, 0.02) : tooSmall(l, 0.0015, 0.05)))) {
    renderOverlay();
    hint('Too small or too thin: try a bigger loop', 1800, true);
    return;
  }
  // wait for Done: a new stroke replaces this one
  setPending(loops);
}

/** Half the size of a basic shape put down with a click (no drag): fits the part, or a handy size on the workbench. */
function stampSize(ds: DrawState): number {
  if (ds.target.kind !== 'bone') return 0.25;
  const b = creature.bones.get(ds.target.boneId)!;
  return Math.max(b.length * 0.9, b.def.width, 0.12) / 2;
}

/** A basic shape centred on (cx, cy), r = half its size. Dense, so its corners stay crisp. */
function shapeLoop(kind: ShapeKind, cx: number, cy: number, r: number): Vec2[] {
  const size = r * 2;
  if (kind === 'circle') {
    return Array.from({ length: 96 }, (_, i) => {
      const a = (i / 96) * Math.PI * 2 - Math.PI / 2;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Vec2;
    });
  }
  const h = kind === 'triangle' ? (size * Math.sqrt(3)) / 2 : size;
  const corners: Vec2[] =
    kind === 'triangle'
      ? [[cx - r, cy - h / 2], [cx + r, cy - h / 2], [cx, cy + h / 2]]
      : [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];
  // counter-clockwise, 24 points per side
  const out: Vec2[] = [];
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % corners.length];
    for (let k = 0; k < 24; k++) out.push([a[0] + ((b[0] - a[0]) * k) / 24, a[1] + ((b[1] - a[1]) * k) / 24]);
  });
  return out;
}

/**
 * The stamp as it would land: with symmetry on it's mirrored across the centre
 * line (one placed right by the line snaps onto it instead).
 */
function stampLoops(ds: DrawState): Vec2[][] {
  const sd = ds.stampDrag;
  if (!ds.stamp || !sd) return [];
  let [cx, cy] = sd.centre;
  // right by the centre line: one symmetric shape on it, not a pair
  if (drawPrefs.symmetry && Math.abs(cx) < sd.r * 0.3) cx = 0;
  const loop = shapeLoop(ds.stamp, cx, cy, sd.r);
  return drawPrefs.symmetry && cx !== 0 ? [loop, mirrorLoop(loop)] : [loop];
}

function placeStamp(ds: DrawState) {
  const loops = stampLoops(ds);
  const cut = ds.tool === 'erase' && !!ds.pending;
  ds.stamp = null;
  ds.stampDrag = null;
  applyLoops(ds, loops, cut);
  syncDrawBar();
  drawHint();
  renderOverlay();
}

function setPending(loops: Vec2[][] | null) {
  if (!drawState) return;
  drawState.pending = loops;
  drawState.holes = [];
  drawState.tool = 'draw';
  previewPending();
  drawHint();
}

/**
 * A stroke once there's a shape: add it on (Draw) or cut it away (Erase).
 * With symmetry on, the stroke is mirrored across the centre line too.
 */
function combineStroke(ds: DrawState, raw: Vec2[]) {
  const loop = raw.length >= 6 ? smoothLoop(raw, drawPrefs.smoothing) : raw;
  if (tooSmall(loop, 0.0001, 0.01)) {
    renderOverlay();
    return;
  }
  applyLoops(ds, drawPrefs.symmetry ? [loop, mirrorLoop(loop)] : [loop], ds.tool === 'erase');
}

const mirrorLoop = (l: Vec2[]) => l.map(([x, y]) => [-x, y] as Vec2).reverse();

/** Add loops to the shape (or cut them out of it); the first ones simply become the shape. */
function applyLoops(ds: DrawState, loops: Vec2[][], cut: boolean) {
  if (!ds.pending) {
    if (cut) return;
    // overlapping mirror images merge into one
    const first = loops.length > 1 ? unite(ds, [], [], loops, false).outers : loops;
    setPending(ds.target.kind === 'bone' ? first.slice(0, 1) : first);
    return;
  }
  const res = unite(ds, ds.pending, ds.holes, loops, cut);
  if (!res.outers.length) {
    setPending(null);
    hint('Erased it all: draw a new shape', 2000);
    return;
  }
  let outers = res.outers;
  let holes = res.holes;
  if (ds.target.kind === 'bone' || ds.target.hole) {
    // a body part (or a hole) is one solid loop: keep the biggest piece
    if (outers.length > 1 || holes.length) hint(ds.target.kind === 'bone' ? 'A body part is one solid shape: kept the biggest piece' : 'Kept the biggest piece of the hole', 2200);
    outers = outers.slice(0, 1);
    holes = [];
  }
  ds.pending = outers;
  ds.holes = holes;
  previewPending();
  drawHint();
}

/**
 * combineLoops, but a body part has to stay one piece: with symmetry on, a
 * shape (and its mirror image) that doesn't reach the rest is stretched
 * sideways to the centre line, the way a half-drawing becomes a whole part.
 */
function unite(ds: DrawState, outers: Vec2[][], holes: Vec2[][], loops: Vec2[][], cut: boolean) {
  const res = combineLoops(outers, holes, loops, cut);
  if (ds.target.kind !== 'bone' || cut || !drawPrefs.symmetry || res.outers.length < 2) return res;
  const widened = loops.map(toAxis);
  const joined = combineLoops(outers, holes, widened, false);
  if (joined.outers.length < 2) return joined;
  // still apart (above or below the rest): necks along the centre line join
  // each piece to the next, middle to middle, so they can't poke out past either end
  const mids = joined.outers.map((l) => bounds(l)).sort((a, b) => a.minY + a.maxY - (b.minY + b.maxY));
  const w = 0.3 * Math.min(...mids.map((b) => b.w));
  const necks = mids.slice(1).map((b, i): Vec2[] => {
    const y0 = (mids[i].minY + mids[i].maxY) / 2, y1 = (b.minY + b.maxY) / 2;
    return [[-w / 2, y0], [w / 2, y0], [w / 2, y1], [-w / 2, y1]];
  });
  return combineLoops(outers, holes, [...widened, ...necks], false);
}

/** A loop widened, row by row, all the way to the centre line (x = 0) on its own side. */
function toAxis(loop: Vec2[]): Vec2[] {
  const bb = bounds(loop);
  const side = bb.minX + bb.maxX >= 0 ? 1 : -1;
  const out: Vec2[] = [];
  const n = 64;
  for (let i = 0; i <= n; i++) {
    const y = bb.minY + (bb.maxY - bb.minY) * (0.001 + (0.998 * i) / n);
    let far = 0;
    for (let a = 0, b = loop.length - 1; a < loop.length; b = a++) {
      const [xa, ya] = loop[a], [xb, yb] = loop[b];
      if (ya > y !== yb > y) far = Math.max(far, side * (xa + ((y - ya) / (yb - ya)) * (xb - xa)));
    }
    out.push([side * far, y]);
  }
  // back down the centre line to close it
  out.push([0, bb.maxY], [0, bb.minY]);
  return out;
}

/**
 * After moving, scaling or turning: pieces pushed into each other (a mirrored
 * pair slid across the centre line, say) fuse into one instead of overlapping.
 */
function mergeOverlaps(ds: DrawState) {
  const loops = ds.pending;
  if (!loops || loops.length < 2) return;
  const bbs = loops.map(bounds);
  const near = bbs.some((a, i) => bbs.some((b, j) => j > i && a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY));
  if (!near) return;
  const res = combineLoops(loops, ds.holes, [], false);
  // boxes can overlap without the shapes touching: then leave them be
  if (res.outers.length >= loops.length) return;
  ds.pending = res.outers;
  ds.holes = ds.target.kind === 'piece' && !ds.target.hole ? res.holes : [];
  previewPending();
}

function pendingShape(ds: DrawState): { outers: Vec2[][]; holes: Vec2[][] } {
  return { outers: ds.pending ?? [], holes: ds.holes };
}
function pendingLoops(ds: DrawState): Vec2[][] {
  return pendingShape(ds).outers;
}

/** The pending shape as workbench pieces: each outer loop with the holes that fall inside it. */
function pendingPieces(ds: DrawState): { outline: Vec2[]; holes: Vec2[][] }[] {
  const { outers, holes } = pendingShape(ds);
  return outers.map((outline) => ({ outline, holes: holesInside({ outline } as Piece, holes) }));
}

/**
 * Move / Scale / Rotate: reshape the shape from how it was when the drag began.
 * With symmetry on, the two sides stay mirror images: loops either side of
 * the centre line move (and turn) in opposite ways, a loop across it only moves
 * up and down, and scaling is about the centre line.
 */
function transformShape(ds: DrawState, p: Vec2, keepProportions: boolean) {
  const g = ds.grab;
  if (!g) return;
  const [cx, cy] = g.centre;
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  // which side of the centre line a loop is on: 1, -1, or 0 if it's across it
  const side = (l: Vec2[]) => {
    if (!drawPrefs.symmetry) return 1;
    const bb = bounds(l);
    return bb.minX < -1e-3 && bb.maxX > 1e-3 ? 0 : (bb.minX + bb.maxX) / 2 >= 0 ? 1 : -1;
  };
  const grabSide = drawPrefs.symmetry && g.start[0] < 0 ? -1 : 1;
  let fn: (l: Vec2[]) => Vec2[];
  if (ds.tool === 'move') {
    const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
    fn = (l) => {
      const sd = side(l);
      const mx = drawPrefs.symmetry ? dx * sd * grabSide : dx;
      return l.map(([x, y]) => [r4(x + mx), r4(y + dy)] as Vec2);
    };
  } else if (ds.tool === 'scale') {
    // the grabbed point follows the pointer; near the middle on one axis, that axis stays put
    const ax = g.start[0] - cx, ay = g.start[1] - cy;
    const bx = p[0] - cx, by = p[1] - cy;
    const bb = bounds(g.outers.flat());
    const ratio = (a: number, b: number, span: number) => (Math.abs(a) > span * 0.12 ? Math.max(0.05, Math.abs(b) / Math.abs(a)) : 1);
    let sx = ratio(ax, bx, bb.w), sy = ratio(ay, by, bb.h);
    if (keepProportions) sx = sy = Math.max(0.05, Math.hypot(bx, by) / Math.max(1e-6, Math.hypot(ax, ay)));
    fn = (l) => l.map(([x, y]) => [r4(cx + (x - cx) * sx), r4(cy + (y - cy) * sy)] as Vec2);
  } else {
    const a = Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(g.start[1] - cy, g.start[0] - cx);
    fn = (l) => {
      const sd = side(l);
      // a pair turns each loop about its own middle, in mirror image
      let ox = cx, oy = cy, ang = a;
      if (drawPrefs.symmetry && sd !== 0) {
        const bb = bounds(l);
        ox = (bb.minX + bb.maxX) / 2;
        oy = (bb.minY + bb.maxY) / 2;
        ang = a * sd * grabSide;
      }
      const c = Math.cos(ang), s = Math.sin(ang);
      return l.map(([x, y]) => [r4(ox + (x - ox) * c - (y - oy) * s), r4(oy + (x - ox) * s + (y - oy) * c)] as Vec2);
    };
  }
  ds.pending = g.outers.map(fn);
  ds.holes = g.holes.map(fn);
}

/** Show the pending shape: inflated live on the part being drawn, or on the workbench. */
function previewPending() {
  const ds = drawState;
  if (!ds) return;
  if (ds.target.kind === 'bone') {
    const b = creature.bones.get(ds.target.boneId);
    if (b) {
      state.parts[b.src].outline = ds.pending ? pendingLoops(ds)[0] : (ds.original ?? null);
      creature.sync();
      // the rebuilt part keeps the see-through drawing look
      creature.setDrawFocus(ds.target.boneId);
    }
  } else {
    syncWorkbench();
  }
  syncDrawBar();
  renderOverlay();
}

let previewQueued = false;
function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    previewPending();
  });
}

/** Done: keep the pending shape. */
function finishDraw() {
  const ds = drawState;
  if (!ds?.pending) return;
  const loops = pendingLoops(ds);
  if (ds.target.kind === 'piece') {
    addPieces(ds.target.hole ? loops : pendingPieces(ds), ds.target.hole);
    return;
  }
  const b = creature.bones.get(ds.target.boneId)!;
  state.parts[b.src].outline = loops[0];
  exitDraw(true);
  creature.sync();
  commit();
  renderParts();
  flashPart();
  hint('Inflated! Drag to look around, or pick another part', 2200);
}

function addStrokePoint(p: Vec2) {
  if (!drawState) return;
  drawState.pts.push(p);
  const l = screenToLocal(drawState.frame, partPlane(drawState.frame), p[0], p[1]);
  if (l) drawState.local.push(l);
}

overlay.addEventListener('pointerdown', (e) => {
  if (!drawState || e.button !== 0) return;
  overlay.setPointerCapture(e.pointerId);
  const at = screenToLocal(drawState.frame, partPlane(drawState.frame), e.clientX, e.clientY);
  if (drawState.stamp) {
    if (at) drawState.stampDrag = { centre: at, r: stampSize(drawState), x: e.clientX, y: e.clientY };
    renderOverlay();
    return;
  }
  if ((drawState.tool === 'move' || drawState.tool === 'scale' || drawState.tool === 'rotate') && drawState.pending) {
    if (!at) return;
    const bb = bounds(drawState.pending.flat());
    // with symmetry on, everything stays centred on the centre line
    const centre: Vec2 = [drawPrefs.symmetry ? 0 : (bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
    drawState.grab = { start: at, outers: drawState.pending, holes: drawState.holes, centre };
    hint('');
    return;
  }
  drawState.active = true;
  drawState.pts = [];
  drawState.local = [];
  drawState.pen = [e.clientX, e.clientY];
  addStrokePoint([e.clientX, e.clientY]);
  hint('');
});
overlay.addEventListener('pointermove', (e) => {
  const sd = drawState?.stampDrag;
  if (sd) {
    // dragging out from where it was pressed sizes it; a click keeps the handy size
    const p = screenToLocal(drawState!.frame, partPlane(drawState!.frame), e.clientX, e.clientY);
    if (p && Math.hypot(e.clientX - sd.x, e.clientY - sd.y) > 6) sd.r = Math.max(0.01, Math.hypot(p[0] - sd.centre[0], p[1] - sd.centre[1]));
    renderOverlay();
    return;
  }
  if (drawState?.grab) {
    const p = screenToLocal(drawState.frame, partPlane(drawState.frame), e.clientX, e.clientY);
    if (!p) return;
    transformShape(drawState, p, e.shiftKey);
    schedulePreview();
    return;
  }
  if (!drawState?.active || !drawState.pen) return;
  // Stabiliser: the pen trails the pointer, ironing out touchpad wobble.
  const follow = 1 - 0.88 * drawPrefs.smoothing;
  const pen = drawState.pen;
  const events = e.getCoalescedEvents?.() ?? [e];
  for (const ev of events.length ? events : [e]) {
    pen[0] += (ev.clientX - pen[0]) * follow;
    pen[1] += (ev.clientY - pen[1]) * follow;
    const last = drawState.pts[drawState.pts.length - 1];
    if (Math.hypot(pen[0] - last[0], pen[1] - last[1]) >= 2) addStrokePoint([pen[0], pen[1]]);
  }
  renderOverlay();
});
overlay.addEventListener('pointerup', () => {
  if (drawState?.stampDrag) {
    placeStamp(drawState);
  } else if (drawState?.grab) {
    drawState.grab = null;
    mergeOverlaps(drawState);
    drawHint();
  } else if (drawState?.active) finishStroke();
});
overlay.addEventListener('wheel', (e) => {
  canvas.dispatchEvent(new WheelEvent('wheel', e));
  e.preventDefault();
}, { passive: false });

function renderOverlay() {
  const dpr = overlay.width / overlay.clientWidth || 1;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
  if (!drawState) return;
  const frame = drawState.frame;
  octx.lineJoin = octx.lineCap = 'round';

  if (drawPrefs.symmetry) {
    const a = localToOverlay(frame, drawState.axis[0]);
    const z = localToOverlay(frame, drawState.axis[1]);
    octx.setLineDash([10, 8]);
    octx.strokeStyle = 'rgba(59,130,246,.75)';
    octx.lineWidth = 2;
    octx.beginPath();
    octx.moveTo(a[0], a[1]);
    octx.lineTo(z[0], z[1]);
    octx.stroke();
    octx.setLineDash([]);
  }

  // the shape waiting for Done (faded while a replacement is being drawn)
  if (drawState.pending) {
    octx.globalAlpha = drawState.active ? 0.35 : 1;
    octx.fillStyle = 'rgba(255,107,74,.12)';
    octx.strokeStyle = '#ff6b4a';
    octx.lineWidth = 3;
    const { outers, holes } = pendingShape(drawState);
    octx.beginPath();
    for (const loop of [...outers, ...holes]) {
      loop.forEach((p, i) => {
        const [sx, sy] = localToOverlay(frame, p);
        if (i) octx.lineTo(sx, sy);
        else octx.moveTo(sx, sy);
      });
      octx.closePath();
    }
    octx.fill('evenodd');
    octx.stroke();
    octx.globalAlpha = 1;
  }

  // a basic shape being dragged out
  if (drawState.stampDrag) {
    const cutting = drawState.tool === 'erase' && !!drawState.pending;
    octx.fillStyle = cutting ? 'rgba(58,51,64,.12)' : 'rgba(255,107,74,.12)';
    octx.strokeStyle = cutting ? '#3a3340' : '#ff6b4a';
    octx.lineWidth = 3;
    if (cutting) octx.setLineDash([8, 6]);
    for (const loop of stampLoops(drawState)) {
      octx.beginPath();
      loop.forEach((q, i) => {
        const [sx, sy] = localToOverlay(frame, q);
        if (i) octx.lineTo(sx, sy);
        else octx.moveTo(sx, sy);
      });
      octx.closePath();
      octx.fill();
      octx.stroke();
    }
    octx.setLineDash([]);
  }

  if (drawState.pts.length < 2) return;
  const r = overlay.getBoundingClientRect();
  const pts = drawState.pts.map(([x, y]) => [x - r.left, y - r.top]);
  // erasing draws in ink, dashed, so it reads as cutting away
  const erasing = drawState.tool === 'erase' && !!drawState.pending;
  const ink = erasing ? '#3a3340' : '#ff6b4a';
  const inkSoft = erasing ? 'rgba(58,51,64,' : 'rgba(255,107,74,';

  if (drawPrefs.symmetry && drawState.local.length > 1) {
    // live preview of the mirrored half
    octx.strokeStyle = inkSoft + '.45)';
    octx.lineWidth = 3;
    octx.beginPath();
    drawState.local.forEach(([x, y], i) => {
      const [sx, sy] = localToOverlay(frame, [-x, y]);
      if (i) octx.lineTo(sx, sy);
      else octx.moveTo(sx, sy);
    });
    octx.stroke();
  } else {
    // closing segment preview
    octx.setLineDash([6, 8]);
    octx.strokeStyle = inkSoft + '.6)';
    octx.lineWidth = 2;
    octx.beginPath();
    octx.moveTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    octx.lineTo(pts[0][0], pts[0][1]);
    octx.stroke();
    octx.setLineDash([]);
  }
  octx.fillStyle = drawPrefs.symmetry ? 'transparent' : inkSoft + '.12)';
  octx.strokeStyle = ink;
  octx.lineWidth = 4;
  if (erasing) octx.setLineDash([8, 6]);
  octx.beginPath();
  pts.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
  if (!drawPrefs.symmetry) octx.fill();
  octx.stroke();
  octx.setLineDash([]);
}

$<HTMLInputElement>('#sym').onchange = () => toggleSymmetry();
$<HTMLInputElement>('#smooth').oninput = (e) => {
  drawPrefs.smoothing = parseFloat((e.target as HTMLInputElement).value);
  saveDrawPrefs();
};
document.querySelectorAll<HTMLButtonElement>('#draw-bar [data-shape]').forEach((b) => {
  b.onclick = () => {
    if (!drawState) return;
    // arm the shape (again to put it away); it's placed by clicking in the drawing
    const kind = b.dataset.shape as ShapeKind;
    drawState.stamp = drawState.stamp === kind ? null : kind;
    // shapes add (or cut, while erasing)
    if (drawState.tool !== 'erase') drawState.tool = 'draw';
    syncDrawBar();
    drawHint();
  };
});
$('#reset-draw').onclick = () => setPending(null);
function setDrawTool(tool: DrawTool) {
  if (!drawState || (tool !== 'draw' && !drawState.pending)) return;
  // tapping the active tool again goes back to drawing
  drawState.tool = drawState.tool === tool ? 'draw' : tool;
  // moving, scaling or turning puts any armed shape away
  if (drawState.tool !== 'draw' && drawState.tool !== 'erase') drawState.stamp = null;
  syncDrawBar();
  drawHint();
}
document.querySelectorAll<HTMLButtonElement>('#draw-tools [data-tool]').forEach((b) => {
  b.onclick = () => setDrawTool(b.dataset.tool as DrawTool);
});
$('#done-draw').onclick = () => finishDraw();

// ---------------------------------------------------------------------------
// stuff workbench

// The board sits at chest height; its XY plane is the drawing plane and its
// origin (the crosshair) is where the thing will attach to a body part.
const board = new THREE.Group();
board.position.set(0, 1, 0);
board.visible = false;
scene.add(board);
const boardGrid = new THREE.Group();
{
  // opaque lines (pre-faded colours) so glass pieces show the grid through them;
  // glass only refracts opaque things
  const grid = new THREE.GridHelper(2.4, 24, 0xc4bcc0, 0xe3dacd);
  grid.rotation.x = Math.PI / 2;
  boardGrid.add(grid);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.035, 0.05, 32),
    new THREE.MeshBasicMaterial({ color: 0x3b82f6, depthTest: false, transparent: true }),
  );
  ring.renderOrder = 999;
  boardGrid.add(ring);
  const cross = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.09, 0, 0), new THREE.Vector3(0.09, 0, 0),
      new THREE.Vector3(0, -0.09, 0), new THREE.Vector3(0, 0.09, 0),
    ]),
    new THREE.LineBasicMaterial({ color: 0x3b82f6, depthTest: false, transparent: true }),
  );
  cross.renderOrder = 999;
  boardGrid.add(cross);
  board.add(boardGrid);
}
let bench: THREE.Group | null = null;
let benchKey = '';
let selectedPiece = '';

function workbench(): Thing {
  world.workbench ??= newThing();
  return world.workbench;
}

function piece(): Piece | undefined {
  return workbench().pieces.find((p) => p.id === selectedPiece);
}

/** Holes from `loops` that actually sit inside piece `p`. */
function holesInside(p: Piece, loops: Vec2[][]): Vec2[][] {
  return loops.filter((l) => {
    const [cx, cy] = l.reduce((a, q) => [a[0] + q[0] / l.length, a[1] + q[1] / l.length], [0, 0]);
    return pointInPolygon(cx, cy, p.outline);
  });
}

/**
 * The workbench as shown: while drawing on it, flat (strokes are drawn flat)
 * and with any shape that's waiting for Done.
 */
function benchThing(): Thing {
  const wb = workbench();
  const ds = drawState;
  if (!ds || ds.target.kind !== 'piece') return wb;
  const shown: Thing = { ...wb, bend: 0 };
  if (!ds.pending) return shown;
  const target = piece();
  if (!ds.target.hole) {
    shown.pieces = [...wb.pieces, ...pendingPieces(ds).map((pp, i) => ({ ...newPiece(pp.outline, target), holes: pp.holes, id: `preview${i}` }))];
  } else if (target?.kind === 'flat') {
    const loops = pendingLoops(ds);
    shown.pieces = wb.pieces.map((p) => (p === target ? { ...p, holes: [...p.holes, ...holesInside(p, loops)] } : p));
  }
  return shown;
}

function syncWorkbench() {
  const thing = benchThing();
  const key = JSON.stringify([thing.pieces, thing.ownMaterial, thing.materialSettings, thing.bend, thing.bendMode, state.materialSettings]);
  if (key === benchKey) return;
  benchKey = key;
  if (bench) {
    board.remove(bench);
    disposeThing(bench);
  }
  bench = buildThing(thing, (s) => creature.settingsFor(s));
  board.add(bench);
}

function focusOnBoard() {
  const c = board.getWorldPosition(new THREE.Vector3());
  let r = 0.7;
  if (bench) {
    const box = new THREE.Box3().setFromObject(bench);
    if (!box.isEmpty()) r = Math.max(0.5, box.getSize(new THREE.Vector3()).length() * 0.7);
  }
  const dist = r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  flyTo(c.clone().add(new THREE.Vector3(0, 0, Math.max(1.4, dist))), c);
}

/** Done on the workbench: add the drawn pieces (with any holes erased in them), or cut the holes into the selected piece. */
function addPieces(shapes: Vec2[][] | { outline: Vec2[]; holes: Vec2[][] }[], hole: boolean) {
  const wb = workbench();
  if (hole) {
    const target = piece();
    if (!target || target.kind !== 'flat') {
      exitDraw();
      hint('Holes can only be cut in a flat piece', 2200, true);
      return;
    }
    const cut = holesInside(target, shapes as Vec2[][]);
    if (!cut.length) {
      // stay in drawing so it can be redrawn in the right place
      hint('Draw the hole inside the selected piece', 2200, true);
      return;
    }
    target.holes.push(...cut);
  } else {
    const made = (shapes as { outline: Vec2[]; holes: Vec2[][] }[]).map((sh) => ({ ...newPiece(sh.outline, piece()), holes: sh.holes }));
    wb.pieces.push(...made);
    selectedPiece = made[0].id;
  }
  exitDraw(true);
  syncWorkbench();
  commit();
  renderStuffPanel();
  flashPart();
}

function pickPiece(x: number, y: number): string | null {
  if (!bench) return null;
  setRay(x, y);
  const hit = raycaster.intersectObjects(bench.children, false)[0];
  return hit ? (hit.object.userData.pieceId as string) : null;
}

/** Glow the selected piece (k fades 1 -> 0). */
function flashPiece(k: number) {
  bench?.children.forEach((m) => {
    const mat = (m as THREE.Mesh).material as THREE.MeshStandardMaterial;
    if (!mat || !('emissive' in mat)) return;
    if (m.userData.pieceId === selectedPiece && k > 0) mat.emissive.setRGB(1, 0.42, 0.29).multiplyScalar(0.45 * k);
    else mat.emissive.setScalar(0);
  });
}

/** Render just the thing, framed, into a small square image for the collection. */
function captureThumb(): string {
  if (!bench) return '';
  const box = new THREE.Box3().setFromObject(bench);
  if (box.isEmpty()) return '';
  const savedPos = camera.position.clone();
  const savedTarget = controls.target.clone();
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() / 2;
  camera.position.copy(c).add(new THREE.Vector3(r * 0.35, r * 0.25, r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1));
  camera.lookAt(c);
  boardGrid.visible = false;
  const url = withCleanScene(() => {
    composer.render();
    const size = 160;
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const s = Math.min(canvas.width, canvas.height);
    out.getContext('2d')!.drawImage(canvas, (canvas.width - s) / 2, (canvas.height - s) / 2, s, s, 0, 0, size, size);
    return out.toDataURL('image/jpeg', 0.82);
  });
  boardGrid.visible = true;
  camera.position.copy(savedPos);
  controls.target.copy(savedTarget);
  camera.lookAt(savedTarget);
  return url;
}

function stripThumb(t: Thing): Thing {
  const { thumb: _thumb, ...rest } = structuredClone(t);
  return rest;
}

function renderStuffPanel() {
  const wb = workbench();
  const nameInput = $<HTMLInputElement>('#thing-name');
  if (document.activeElement !== nameInput) nameInput.value = wb.name;
  if (!wb.pieces.some((p) => p.id === selectedPiece)) selectedPiece = wb.pieces[wb.pieces.length - 1]?.id ?? '';

  const list = $('#pieces');
  list.innerHTML = '';
  wb.pieces.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.innerHTML = `<i style="background:${p.color}"></i>`;
    btn.append(`${p.kind === 'flat' ? '▭' : '⬭'} Piece ${i + 1}${p.holes.length ? ` (${p.holes.length} hole${p.holes.length > 1 ? 's' : ''})` : ''}`);
    btn.classList.toggle('active', p.id === selectedPiece);
    btn.onclick = () => {
      selectedPiece = p.id;
      flashPart();
      renderStuffPanel();
    };
    list.append(btn);
  });
  if (!wb.pieces.length) list.innerHTML = '<p class="muted small">No pieces yet: draw one to start.</p>';
  $('#thing-bend-card').hidden = !wb.pieces.length;
  document.querySelectorAll<HTMLButtonElement>('#thing-bend-mode button').forEach((b) => b.classList.toggle('active', b.dataset.bend === (wb.bendMode ?? 'axis')));
  $<HTMLInputElement>('#thing-bend').value = String(wb.bend ?? 0);

  const p = piece();
  $('#piece-card').hidden = !p;
  if (p) {
    document.querySelectorAll<HTMLButtonElement>('#piece-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === p.kind));
    const th = $<HTMLInputElement>('#piece-thickness');
    if (p.kind === 'flat') Object.assign(th, { min: '0.005', max: '0.3', step: '0.001' });
    else if (p.kind === 'turned') Object.assign(th, { min: '0.003', max: '0.12', step: '0.001' });
    else Object.assign(th, { min: '0.1', max: '3', step: '0.01' });
    th.value = String(p.thickness);
    $('#piece-thickness-label').textContent = p.kind === 'turned' ? 'Wall' : 'Thickness';
    $('#piece-turned-row').hidden = p.kind !== 'turned';
    $<HTMLInputElement>('#piece-hollow').checked = !!p.hollow;
    $<HTMLInputElement>('#piece-open').checked = !!p.open;
    $<HTMLInputElement>('#piece-open').disabled = !p.hollow;
    $<HTMLInputElement>('#piece-opacity').value = String(p.opacity ?? 1);
    $('#piece-round-row').hidden = p.kind !== 'flat';
    $<HTMLInputElement>('#piece-round').value = String(p.round);
    $<HTMLInputElement>('#piece-z').value = String(p.z);
    $<HTMLButtonElement>('#piece-hole').disabled = p.kind !== 'flat';
    $<HTMLButtonElement>('#piece-clear-holes').hidden = !p.holes.length;
    const sw = $('#piece-swatches');
    sw.innerHTML = '';
    for (const c of SWATCHES) {
      const b = document.createElement('button');
      b.style.background = c;
      b.title = c;
      b.classList.toggle('active', c.toLowerCase() === p.color.toLowerCase());
      b.onclick = () => updatePiece((q) => (q.color = c));
      sw.append(b);
    }
    $<HTMLInputElement>('#piece-color').value = p.color;
    const st = $('#piece-styles');
    st.innerHTML = '';
    for (const s of STYLES) {
      const b = document.createElement('button');
      b.innerHTML = `<span class="ball ${s.id}"></span>`;
      b.append(s.name);
      b.classList.toggle('active', s.id === p.style);
      b.onclick = () => updatePiece((q) => (q.style = s.id));
      st.append(b);
    }
    renderThingMaterial(wb, [p.style], $('#piece-style-params'));
  }
  renderCollection();
}

function updatePiece(fn: (p: Piece) => void, doCommit = true) {
  const p = piece();
  if (!p) return;
  fn(p);
  syncWorkbench();
  if (doCommit) {
    commit();
    renderStuffPanel();
  }
}

function renderCollection() {
  for (const [sel, forAttach] of [['#thing-list', false], ['#attach-options', true]] as const) {
    const el = $(sel);
    el.innerHTML = '';
    const things = collection();
    if (!things.length) {
      el.innerHTML = forAttach
        ? '<p class="muted small">Your collection is empty. Make something in the 🗡 Stuff tab first.</p>'
        : '<p class="muted small">Nothing saved yet.</p>';
      continue;
    }
    for (const t of things) {
      const card = document.createElement('div');
      card.className = 'thing-card';
      const img = document.createElement(t.thumb ? 'img' : 'div');
      img.className = 'thumb';
      if (t.thumb) (img as HTMLImageElement).src = t.thumb;
      const name = document.createElement('span');
      name.className = 'thing-name';
      name.textContent = t.name;
      card.append(img, name);
      if (forAttach) {
        card.classList.add('pick');
        card.onclick = () => attachThing(t);
      } else {
        const actions = document.createElement('div');
        actions.className = 'thing-actions';
        const mk = (label: string, title: string, fn: () => void) => {
          const b = document.createElement('button');
          b.className = 'ghost';
          b.textContent = label;
          b.title = title;
          b.onclick = fn;
          actions.append(b);
        };
        mk('Edit', 'Open on the workbench', () => {
          world.workbench = structuredClone(t);
          selectedPiece = '';
          syncWorkbench();
          commit();
          renderStuffPanel();
          focusOnBoard();
        });
        mk('⬇', 'Download as a .stuff file', () =>
          downloadText(`${safeFileName(t.name, 'thing')}.stuff`, JSON.stringify(envelope('stuff', t))),
        );
        mk('✕', 'Remove from collection', () => {
          if (!confirm(`Remove "${t.name}" from your collection? (Creatures already wearing it keep their copy.)`)) return;
          removeThing(t.id);
          renderCollection();
        });
        card.append(actions);
      }
      el.append(card);
    }
  }
}

$('#piece-draw').onclick = () => enterDraw({ kind: 'piece', hole: false });
$('#piece-hole').onclick = () => enterDraw({ kind: 'piece', hole: true });
$('#piece-clear-holes').onclick = () => updatePiece((p) => (p.holes = []));
$('#piece-del').onclick = () => {
  const wb = workbench();
  wb.pieces = wb.pieces.filter((p) => p.id !== selectedPiece);
  selectedPiece = '';
  syncWorkbench();
  commit();
  renderStuffPanel();
};
document.querySelectorAll<HTMLButtonElement>('#piece-kind button').forEach((b) => {
  b.onclick = () =>
    updatePiece((p) => {
      const kind = b.dataset.kind as Piece['kind'];
      if (kind === p.kind) return;
      p.kind = kind;
      p.thickness = kind === 'flat' ? 0.04 : kind === 'turned' ? 0.012 : 0.6;
      if (kind === 'turned' && p.hollow === undefined) {
        p.hollow = true;
        p.open = true;
      }
    });
});
$<HTMLInputElement>('#piece-hollow').onchange = (e) => updatePiece((p) => (p.hollow = (e.target as HTMLInputElement).checked));
$<HTMLInputElement>('#piece-open').onchange = (e) => updatePiece((p) => (p.open = (e.target as HTMLInputElement).checked));
for (const [id, key] of [['#piece-thickness', 'thickness'], ['#piece-round', 'round'], ['#piece-z', 'z'], ['#piece-opacity', 'opacity']] as const) {
  const input = $<HTMLInputElement>(id);
  input.oninput = () => updatePiece((p) => (p[key] = parseFloat(input.value)), false);
  input.onchange = () => commit();
}
$<HTMLInputElement>('#piece-color').oninput = (e) => updatePiece((p) => (p.color = (e.target as HTMLInputElement).value), false);
$<HTMLInputElement>('#piece-color').onchange = () => {
  commit();
  renderStuffPanel();
};
$<HTMLInputElement>('#thing-name').oninput = (e) => {
  workbench().name = (e.target as HTMLInputElement).value;
};
$<HTMLInputElement>('#thing-name').onchange = () => commit();
$<HTMLInputElement>('#thing-bend').oninput = (e) => {
  workbench().bend = parseFloat((e.target as HTMLInputElement).value);
  syncWorkbench();
};
$<HTMLInputElement>('#thing-bend').onchange = () => commit();
document.querySelectorAll<HTMLButtonElement>('#thing-bend-mode button').forEach((b) => {
  b.onclick = () => {
    const wb = workbench();
    wb.bendMode = b.dataset.bend as BendMode;
    // picking a way to bend with nothing bent yet starts with a visible curve
    if (!wb.bend) wb.bend = 0.4;
    syncWorkbench();
    commit();
    renderStuffPanel();
  };
});
$('#thing-new').onclick = () => {
  world.workbench = newThing();
  selectedPiece = '';
  syncWorkbench();
  commit();
  renderStuffPanel();
};
$('#thing-save').onclick = () => {
  const wb = workbench();
  if (!wb.pieces.length) {
    hint('Draw at least one piece first', 2000, true);
    return;
  }
  wb.name = wb.name.trim() || 'Thing';
  wb.thumb = captureThumb();
  if (!putThing(wb)) {
    hint('Browser storage is full: export your collection to a file and remove some things', 3500, true);
    return;
  }
  // creatures already wearing this thing pick up the new version
  for (const a of state.attachments ?? []) if (a.thing.id === wb.id) a.thing = stripThumb(wb);
  creature.sync();
  commit();
  renderStuffPanel();
  hint(`Saved "${wb.name}" to your collection`, 2000);
};

// ---------------------------------------------------------------------------
// attaching stuff to body parts

const gizmo = new TransformControls(camera, canvas);
gizmo.setSpace('local');
gizmo.setSize(0.8);
scene.add(gizmo.getHelper());
gizmo.addEventListener('dragging-changed', (e) => {
  controls.enabled = !(e as unknown as { value: boolean }).value;
});
gizmo.addEventListener('objectChange', () => {
  if (placing) {
    // keep creatures standing on the floor, turning only about the vertical
    creature.root.position.y = 0;
    creature.root.rotation.set(0, creature.root.rotation.y, 0);
    creature.capturePlacement();
    fitShadows();
    return;
  }
  const a = currentAttachment();
  const obj = gizmo.object;
  if (!a || !obj) return;
  a.position = obj.position.toArray() as V3;
  a.quaternion = obj.quaternion.toArray() as [number, number, number, number];
  a.scale = obj.scale.toArray() as V3;
  creature.updateTwin(a.id);
});
gizmo.addEventListener('mouseUp', () => {
  // a rescaled felt attachment regrows its fuzz at the new size
  if (selectedAttachment) creature.syncAttachments();
  commit();
});

let selectedAttachment = '';

function currentAttachment(): Attachment | undefined {
  return state.attachments?.find((a) => a.id === selectedAttachment);
}

function selectAttachment(id: string) {
  const obj = creature.attachmentObject(id);
  if (!obj) return deselectAttachment();
  stopPlacing();
  selectedAttachment = id;
  gizmo.attach(obj);
  $('#attach-bar').hidden = false;
  syncAttachBar();
  renderAttachList();
}

function deselectAttachment() {
  selectedAttachment = '';
  if (!placing) gizmo.detach();
  $('#attach-bar').hidden = true;
  $('#attach-mat-pop').hidden = true;
  renderAttachList();
}

// ---------------------------------------------------------------------------
// placing creatures: the same gizmo, limited to sliding on the floor and turning

let placing = false;

function setPlaceMode(m: 'translate' | 'rotate') {
  gizmo.setMode(m);
  gizmo.setSpace('world');
  gizmo.showX = gizmo.showZ = m === 'translate';
  gizmo.showY = m === 'rotate';
  document.querySelectorAll<HTMLButtonElement>('#place-bar [data-place]').forEach((b) => b.classList.toggle('on', b.dataset.place === m));
}

function startPlacing() {
  if (mode === 'stuff') return;
  if (selectedAttachment) deselectAttachment();
  placing = true;
  gizmo.attach(creature.root);
  setPlaceMode('translate');
  $('#place-bar').hidden = false;
  $('#place-name').textContent = creatureLabel(world.active);
  $('#cr-place').classList.add('on');
}

function stopPlacing() {
  if (!placing) return;
  placing = false;
  gizmo.detach();
  gizmo.showX = gizmo.showY = gizmo.showZ = true;
  gizmo.setSpace('local');
  $('#place-bar').hidden = true;
  $('#cr-place').classList.remove('on');
}

document.querySelectorAll<HTMLButtonElement>('#place-bar [data-place]').forEach((b) => {
  b.onclick = () => setPlaceMode(b.dataset.place as 'translate' | 'rotate');
});
$('#place-done').onclick = () => {
  stopPlacing();
  commit(); // records the move if anything changed (no-op otherwise)
};

// ---------------------------------------------------------------------------
// the creature switcher

function renderCreatureBar() {
  const el = $('#creature-chips');
  el.innerHTML = '';
  world.creatures.forEach((s, i) => {
    const btn = document.createElement('button');
    const color = Object.values(s.parts)[0]?.color ?? '#ccc';
    btn.innerHTML = `<i style="background:${color}"></i>`;
    btn.append(creatureLabel(i));
    btn.classList.toggle('active', i === world.active);
    btn.onclick = () => {
      if (i === world.active) return;
      activate(i);
      flashPart();
      save();
      renderUI();
    };
    el.append(btn);
  });
  $<HTMLButtonElement>('#cr-del').disabled = world.creatures.length < 2;
}

/** A free spot on the floor to the right of everyone else. */
function freeSpot(): Placement {
  let maxX = -Infinity;
  for (const c of creatures) {
    const box = new THREE.Box3();
    c.root.updateMatrixWorld(true);
    for (const m of c.meshes()) box.expandByObject(m);
    if (!box.isEmpty()) maxX = Math.max(maxX, box.max.x);
  }
  return { x: Number.isFinite(maxX) ? Math.round((maxX + 0.9) * 100) / 100 : 0, z: 0, yaw: 0 };
}

function addCreature(s: CreatureState) {
  exitDraw();
  world.creatures.push(s);
  creatures.push(makeCreature(s));
  activate(world.creatures.length - 1);
  commit();
  renderUI();
  frameAll();
}

$('#cr-add').onclick = () => {
  const s = defaultState(structuredClone(state.rig));
  s.style = state.style;
  s.materialSettings = structuredClone(state.materialSettings);
  s.placement = freeSpot();
  addCreature(s);
  hint('Added a new creature: click any creature to switch between them', 2600);
};
$('#cr-dup').onclick = () => {
  const s = structuredClone(state);
  delete s.workbench;
  s.name = state.name?.trim() ? `${state.name.trim()} copy` : undefined;
  s.placement = freeSpot();
  addCreature(s);
};
$('#cr-del').onclick = () => {
  if (world.creatures.length < 2) return;
  if (!confirm(`Remove ${creatureLabel(world.active)} from the scene? (You can undo this.)`)) return;
  exitDraw();
  stopPlacing();
  const i = world.active;
  creatures[i].dispose();
  creatures.splice(i, 1);
  world.creatures.splice(i, 1);
  creature = undefined as unknown as Creature; // the old one is gone; don't try to reset it
  activate(Math.max(0, i - 1));
  commit();
  renderUI();
};
$('#cr-place').onclick = () => {
  if (!placing) return startPlacing();
  stopPlacing();
  commit();
};

function syncAttachBar() {
  const a = currentAttachment();
  if (!a) return;
  document.querySelectorAll<HTMLButtonElement>('#attach-bar [data-gizmo]').forEach((b) => b.classList.toggle('on', b.dataset.gizmo === gizmo.mode));
  const bone = creature.bones.get(a.bone);
  const hasTwin = !!bone && !!creature.twinOf(bone);
  $('#attach-mirror-label').hidden = !hasTwin;
  $<HTMLInputElement>('#attach-mirror').checked = a.mirror;
  $('#attach-mirror-label').classList.toggle('on', a.mirror);
  $('#attach-name').textContent = a.thing.name;
  if (!$('#attach-mat-pop').hidden) renderAttachMaterial();
}

function renderAttachMaterial() {
  const a = currentAttachment();
  if (!a) return;
  renderThingMaterial(a.thing, [...new Set(a.thing.pieces.map((p) => p.style))], $('#attach-mat-body'));
}

function attachThing(t: Thing) {
  const bone = creature.bones.get(selected);
  if (!bone) return;
  const a: Attachment = {
    id: uid(),
    bone: selected,
    thing: stripThumb(t),
    position: creature.attachPoint(selected),
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    mirror: !!creature.twinOf(bone),
  };
  state.attachments = [...(state.attachments ?? []), a];
  creature.sync();
  commit();
  $('#attach-pop').hidden = true;
  selectAttachment(a.id);
  hint('Drag the arrows to place it; switch to rotate or scale in the top bar', 3000);
}

function renderAttachList() {
  const el = $('#attach-list');
  el.innerHTML = '';
  const bone = creature.bones.get(selected);
  if (!bone) return;
  const twin = creature.twinOf(bone)?.def.id;
  const mine = (state.attachments ?? []).filter((a) => a.bone === selected || (a.mirror && a.bone === twin));
  for (const a of mine) {
    const btn = document.createElement('button');
    btn.textContent = `📎 ${a.thing.name}`;
    btn.classList.toggle('active', a.id === selectedAttachment);
    btn.onclick = () => (a.id === selectedAttachment ? deselectAttachment() : selectAttachment(a.id));
    el.append(btn);
  }
}

function pickAttachment(x: number, y: number): string | null {
  setRay(x, y);
  const hit = raycaster.intersectObjects(creature.attachmentMeshes(), false)[0];
  return hit ? (hit.object.userData.attachmentId as string) : null;
}

$('#attach-add').onclick = () => {
  const pop = $('#attach-pop');
  pop.hidden = !pop.hidden;
  renderCollection();
};
$('#attach-pop-close').onclick = () => ($('#attach-pop').hidden = true);
$('#attach-mat').onclick = () => {
  const pop = $('#attach-mat-pop');
  pop.hidden = !pop.hidden;
  if (!pop.hidden) renderAttachMaterial();
};
$('#attach-mat-close').onclick = () => ($('#attach-mat-pop').hidden = true);
document.querySelectorAll<HTMLButtonElement>('#attach-bar [data-gizmo]').forEach((b) => {
  b.onclick = () => {
    gizmo.setMode(b.dataset.gizmo as 'translate' | 'rotate' | 'scale');
    syncAttachBar();
  };
});
$<HTMLInputElement>('#attach-mirror').onchange = (e) => {
  const a = currentAttachment();
  if (!a) return;
  a.mirror = (e.target as HTMLInputElement).checked;
  creature.sync();
  commit();
  selectAttachment(a.id);
};
$('#attach-remove').onclick = () => {
  state.attachments = (state.attachments ?? []).filter((a) => a.id !== selectedAttachment);
  deselectAttachment();
  creature.sync();
  commit();
  renderAttachList();
};
$('#attach-done').onclick = () => deselectAttachment();

// ---------------------------------------------------------------------------
// files

// The top-bar menus share the same corner of the viewport, so only one is open at a time.
const POPOVERS: [button: string, pop: string][] = [['#file-btn', '#file-pop'], ['#backdrop-btn', '#backdrop'], ['#settings-btn', '#settings-pop']];
/** Open (or, if it's already open, close) one top-bar menu. Returns whether it's now open. */
function togglePopover(pop: string): boolean {
  const open = $(pop).hidden !== false;
  for (const [b, p] of POPOVERS) {
    $(p).hidden = !(open && p === pop);
    $(b).classList.toggle('on', open && p === pop);
  }
  return open;
}

$('#file-btn').onclick = () => {
  if (!togglePopover('#file-pop')) return;
  $<HTMLInputElement>('#creature-name').value = state.name ?? '';
  $<HTMLInputElement>('#scene-name').value = world.name ?? '';
};
$<HTMLInputElement>('#creature-name').oninput = (e) => {
  state.name = (e.target as HTMLInputElement).value;
  renderCreatureBar();
};
$<HTMLInputElement>('#creature-name').onchange = () => commit();
$<HTMLInputElement>('#scene-name').oninput = (e) => {
  world.name = (e.target as HTMLInputElement).value;
};
$<HTMLInputElement>('#scene-name').onchange = () => commit();

/** A creature as it goes into a file (the workbench isn't part of it). */
function forFile(s: CreatureState): CreatureState {
  const { workbench: _wb, ...data } = s;
  return data;
}

$('#file-save-creature').onclick = () => {
  downloadText(`${safeFileName(state.name ?? '', 'creature')}.creature`, JSON.stringify(envelope('creature', forFile(state))));
};
$('#file-save-scene').onclick = () => {
  const data = { name: world.name, active: world.active, creatures: world.creatures.map(forFile) };
  downloadText(`${safeFileName(world.name ?? '', 'scene')}.scene`, JSON.stringify(envelope('scene', data)));
};
$('#file-save-collection').onclick = () => {
  const data = { things: collection(), rigs: savedRigs() };
  downloadText('my-collection.collection', JSON.stringify(envelope('collection', data)));
};

// "open" replaces (a creature file replaces the current creature, a scene file
// the whole scene); "add" brings the file's creatures into the current scene.
let fileMode: 'open' | 'add' = 'open';
$('#file-open').onclick = () => {
  fileMode = 'open';
  $<HTMLInputElement>('#file-input').click();
};
$('#file-add').onclick = () => {
  fileMode = 'add';
  $<HTMLInputElement>('#file-input').click();
};
$<HTMLInputElement>('#file-input').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  for (const file of Array.from(input.files ?? [])) {
    try {
      openFile(await file.text(), fileMode);
    } catch (err) {
      hint(`${file.name}: ${(err as Error).message}`, 3500, true);
    }
  }
  input.value = '';
};

/** Read creatures out of a file, up to the current format, with worn stuff added to the collection. */
function creaturesFrom(data: unknown, many: boolean): CreatureState[] {
  const raw = many ? ((data as { creatures?: unknown[] }).creatures ?? []) : [data];
  const list = raw.map(migrate).filter((s): s is CreatureState => !!s);
  if (!list.length) throw new Error(many ? 'No creatures in this scene could be read.' : 'The creature in this file could not be read.');
  const have = new Set(collection().map((t) => t.id));
  for (const s of list) {
    delete s.workbench; // the workbench belongs to the scene, not the file
    for (const a of s.attachments ?? []) {
      if (have.has(a.thing.id)) continue;
      putThing(a.thing);
      have.add(a.thing.id);
    }
  }
  return list;
}

function openFile(text: string, how: 'open' | 'add') {
  const env = parseEnvelope(text);
  if (env.kind === 'creature' || env.kind === 'scene') {
    const incoming = creaturesFrom(env.data, env.kind === 'scene');
    exitDraw();
    deselectAttachment();
    stopPlacing();
    if (how === 'add') {
      // keep the file's own arrangement, shifted to free floor on the right
      const spot = freeSpot();
      const minX = Math.min(...incoming.map((s) => s.placement?.x ?? 0));
      for (const s of incoming) {
        s.placement = { x: spot.x + ((s.placement?.x ?? 0) - minX), z: s.placement?.z ?? 0, yaw: s.placement?.yaw ?? 0 };
        world.creatures.push(s);
        creatures.push(makeCreature(s));
      }
      activate(world.creatures.length - 1);
      commit();
      renderUI();
      frameAll();
      hint(incoming.length > 1 ? `Added ${incoming.length} creatures to the scene` : `Added ${incoming[0].name || 'a creature'} to the scene`, 2200);
    } else if (env.kind === 'scene') {
      const data = env.data as { name?: string; active?: number };
      for (const c of creatures) c.dispose();
      creatures.length = 0;
      creature = undefined as unknown as Creature; // replaced wholesale
      world = { creatures: incoming, active: Math.min(Math.max(0, data.active ?? 0), incoming.length - 1), workbench: world.workbench, name: data.name };
      incoming.forEach((s, i) => (creatures[i] = makeCreature(s)));
      selected = '';
      activate(world.active);
      commit();
      renderUI();
      if (mode !== 'stuff') frameAll();
      hint(`Opened ${data.name || 'scene'} (${incoming.length} creature${incoming.length > 1 ? 's' : ''})`, 2200);
    } else {
      // a creature file replaces the current creature, keeping its spot in the scene
      const s = incoming[0];
      s.placement = state.placement;
      state = s;
      selected = '';
      buildCreature();
      commit();
      renderUI();
      if (mode !== 'stuff') frameCreature(true);
      hint(`Opened ${s.name || 'creature'}`, 2000);
    }
  } else if (env.kind === 'stuff') {
    const t = env.data as Thing;
    if (!Array.isArray(t.pieces)) throw new Error('The stuff in this file could not be read.');
    putThing(t);
    renderCollection();
    hint(`Added "${t.name}" to your collection`, 2000);
  } else if (env.kind === 'collection') {
    const data = env.data as { things?: Thing[]; rigs?: RigState[] };
    for (const t of data.things ?? []) putThing(t);
    for (const r of data.rigs ?? []) saveRig(r, r.name);
    renderCollection();
    renderRigs();
    renderRigPanel();
    hint(`Added ${data.things?.length ?? 0} things and ${data.rigs?.length ?? 0} rigs to your collection`, 2500);
  }
}

// ---------------------------------------------------------------------------
// UI

const SWATCHES = [
  '#f26b5b', '#ff9f6b', '#f7c873', '#fff1c9', '#9fd98b', '#5fbf9f', '#7cc6e8', '#6d8fe0',
  '#b9a3e3', '#f6a5b5', '#e86aa6', '#c98b5e', '#8d6e63', '#fdfaf4', '#9a9aa6', '#3a3340',
];

function partLabel(src: string): string {
  const b = creature.bones.get(src)!;
  return b.def.sideSign !== 0 ? b.def.name.replace(/ \((L|R)\)$/, '') : b.def.name;
}

function sources(): BoneRT[] {
  return creature.list.filter((b) => !b.def.mirrorOf);
}

function selPart() {
  return state.parts[creature.bones.get(selected)!.src];
}

function selectPart(id: string) {
  selected = id;
  creature.select(id);
  flashPart();
  renderUI();
}

let flashStart = 0;
function flashPart() {
  flashStart = performance.now();
}

function renderRigs() {
  const el = $('#rigs');
  el.innerHTML = '';
  const options = [
    ...RIGS.map((r) => ({ base: r.id, icon: r.icon, name: r.name })),
    ...savedRigs().map((r) => ({ base: r.base, icon: '🦴', name: r.name })),
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.innerHTML = `<span>${o.icon}</span>`;
    btn.append(o.name);
    btn.title = o.name;
    btn.classList.toggle('active', o.base === state.rig.base);
    btn.onclick = () => switchRig(o.base);
    el.append(btn);
  }
}

function renderParts() {
  const el = $('#parts');
  el.innerHTML = '';
  const selSrc = creature.bones.get(selected)?.src;
  for (const b of sources()) {
    const btn = document.createElement('button');
    const p = state.parts[b.src];
    const twin = creature.list.some((o) => o.def.mirrorOf === b.def.id);
    btn.innerHTML = `<i style="background:${p.color}"></i>${partLabel(b.src)}${twin ? ' ×2' : ''}${p.outline ? ' ✓' : ''}`;
    btn.classList.toggle('active', b.src === selSrc);
    btn.onclick = () => selectPart(b.def.id);
    el.append(btn);
  }
}

function renderPartCard() {
  const p = selPart();
  $('#part-title').textContent = partLabel(creature.bones.get(selected)!.src);
  $<HTMLInputElement>('#thickness').value = String(p.thickness);
  $<HTMLInputElement>('#opacity').value = String(p.opacity ?? 1);
  $<HTMLButtonElement>('#reset-shape').disabled = !p.outline;
}

let opacityPending = false;
$<HTMLInputElement>('#opacity').oninput = (e) => {
  selPart().opacity = parseFloat((e.target as HTMLInputElement).value);
  if (opacityPending) return;
  opacityPending = true;
  requestAnimationFrame(() => {
    opacityPending = false;
    creature.sync();
  });
};
$<HTMLInputElement>('#opacity').onchange = () => {
  creature.sync();
  commit();
};

function renderColors() {
  const p = selPart();
  const el = $('#swatches');
  el.innerHTML = '';
  for (const c of SWATCHES) {
    const btn = document.createElement('button');
    btn.style.background = c;
    btn.title = c;
    btn.classList.toggle('active', c.toLowerCase() === p.color.toLowerCase());
    btn.onclick = () => setColor(c, true);
    el.append(btn);
  }
  $<HTMLInputElement>('#color').value = p.color;
}

function renderStyles() {
  const onlyPart = $<HTMLInputElement>('#style-part').checked;
  const current = onlyPart ? (selPart().style ?? state.style) : state.style;
  const el = $('#styles');
  el.innerHTML = '';
  for (const s of STYLES) {
    const btn = document.createElement('button');
    btn.innerHTML = `<span class="ball ${s.id}"></span><span><b>${s.name}</b><small>${s.desc}</small></span>`;
    btn.classList.toggle('active', s.id === current);
    btn.onclick = () => setStyle(s.id);
    el.append(btn);
  }
  renderStyleParams(current);
}

type SettingsOwner = { materialSettings?: CreatureState['materialSettings'] };

/**
 * A stuff item's material controls: an "Inherits material" box (use the
 * creature's settings) and, when it's off, sliders that only affect this item.
 */
function renderThingMaterial(thing: Thing, styles: StyleId[], el: HTMLElement) {
  el.innerHTML = '';
  const row = document.createElement('label');
  row.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !thing.ownMaterial;
  box.onchange = () => {
    thing.ownMaterial = !box.checked;
    if (thing.ownMaterial) {
      // start from what it looks like now
      thing.materialSettings ??= {};
      for (const st of styles) thing.materialSettings[st] ??= { ...creature.settingsFor(st) };
    }
    creature.sync();
    syncWorkbench();
    commit();
    renderThingMaterial(thing, styles, el);
  };
  row.append(box, ' Inherits material ');
  const note = document.createElement('span');
  note.className = 'muted small';
  note.textContent = thing.ownMaterial ? '(own settings, just for this item)' : "(shares the creature's settings)";
  row.append(note);
  el.append(row);
  const scaleRow = document.createElement('label');
  scaleRow.className = 'check';
  scaleRow.title = 'On: fuzz keeps the same real length when the item is scaled. Off: it grows and shrinks with the item.';
  const scaleBox = document.createElement('input');
  scaleBox.type = 'checkbox';
  scaleBox.checked = thing.scaleMaterial !== false;
  scaleBox.onchange = () => {
    thing.scaleMaterial = scaleBox.checked;
    creature.sync();
    commit();
  };
  scaleRow.append(scaleBox, ' Re-adjust material on scale');
  el.append(scaleRow);
  for (const st of styles) {
    const sub = document.createElement('div');
    sub.className = 'style-params';
    el.append(sub);
    renderStyleParams(st, sub, thing.ownMaterial ? thing : state);
  }
}

/**
 * Sliders for a material. With the default owner (the creature) they apply
 * everywhere that material is used, stuff included unless the item has its
 * own settings. The number boxes take any value, past either end of the slider.
 */
function renderStyleParams(style: StyleId, el: HTMLElement = $('#style-params'), owner: SettingsOwner = state) {
  el.innerHTML = '';
  const values = styleSettings(style, owner.materialSettings?.[style]);
  const head = document.createElement('div');
  head.className = 'style-params-head';
  head.innerHTML = `<span>${STYLES.find((s) => s.id === style)!.name} settings</span>`;
  const reset = document.createElement('button');
  reset.className = 'link';
  reset.textContent = 'Reset';
  reset.onclick = () => {
    if (owner.materialSettings) delete owner.materialSettings[style];
    creature.sync();
    syncWorkbench();
    commit();
    renderStyleParams(style, el, owner);
  };
  head.append(reset);
  el.append(head);
  let pending = false;
  for (const p of STYLE_PARAMS[style]) {
    const row = document.createElement('label');
    row.className = 'slider';
    const name = document.createElement('span');
    name.textContent = p.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(p.min);
    input.max = String(p.max);
    input.step = String(p.step);
    input.value = String(values[p.key]);
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'num';
    num.dataset.own = '1';
    num.step = String(p.step);
    num.value = String(values[p.key]);
    const apply = (v: number) => {
      owner.materialSettings ??= {};
      (owner.materialSettings[style] ??= {})[p.key] = v;
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        creature.sync();
        syncWorkbench();
        if (owner === state && floorPrefs.mode === 'material' && floorPrefs.style === style) buildFloorMesh();
      });
    };
    input.oninput = () => {
      num.value = input.value;
      apply(parseFloat(input.value));
    };
    input.onchange = () => commit();
    num.oninput = () => {
      const v = parseFloat(num.value);
      if (!Number.isFinite(v)) return;
      input.value = String(v); // the slider just pins at its end
      apply(v);
    };
    num.onchange = () => commit();
    row.append(name, input, num);
    el.append(row);
  }
}

function renderEyes() {
  const e = state.eyes;
  e.style ??= 'googly';
  const el = $('#eye-styles');
  el.innerHTML = '';
  const options: { id: EyeStyle | 'none'; name: string }[] = [{ id: 'none', name: 'None' }, ...EYE_STYLES];
  const icons: Record<string, string> = { none: '∅', googly: '👀', flat: '◉', bead: '●', dot: '•', button: '⊕' };
  for (const o of options) {
    const btn = document.createElement('button');
    btn.innerHTML = `<span>${icons[o.id]}</span>${o.name}`;
    btn.classList.toggle('active', o.id === 'none' ? !e.enabled : e.enabled && e.style === o.id);
    btn.onclick = () => {
      if (o.id === 'none') e.enabled = false;
      else {
        e.enabled = true;
        e.style = o.id;
      }
      creature.sync();
      commit();
      renderEyes();
    };
    el.append(btn);
  }
  eyePair = Math.min(eyePair, e.pairs.length - 1);
  const tabs = $('#eye-pairs');
  tabs.innerHTML = '';
  e.pairs.forEach((_, i) => {
    const btn = document.createElement('button');
    btn.textContent = `Pair ${i + 1}`;
    btn.classList.toggle('active', i === eyePair);
    btn.onclick = () => {
      eyePair = i;
      renderEyes();
    };
    tabs.append(btn);
  });
  const add = document.createElement('button');
  add.textContent = '+ Add';
  add.className = 'add';
  add.onclick = () => {
    const last = e.pairs[e.pairs.length - 1];
    e.pairs.push({ size: Math.max(0.15, last.size * 0.75), spacing: last.spacing, height: Math.max(0.1, last.height - 0.22), lift: last.lift ?? e.lift });
    eyePair = e.pairs.length - 1;
    e.enabled = true;
    creature.sync();
    commit();
    renderEyes();
  };
  tabs.append(add);
  if (e.pairs.length > 1) {
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.className = 'remove';
    del.onclick = () => {
      e.pairs.splice(eyePair, 1);
      creature.sync();
      commit();
      renderEyes();
    };
    tabs.append(del);
  }
  const pair = e.pairs[eyePair];
  $<HTMLInputElement>('#eye-size').value = String(pair.size);
  $<HTMLInputElement>('#eye-spacing').value = String(pair.spacing);
  $<HTMLInputElement>('#eye-height').value = String(pair.height);
  $('#eye-sliders').style.opacity = e.enabled ? '1' : '.4';
  $<HTMLInputElement>('#eye-lift').value = String(pair.lift ?? e.lift ?? 0);
  // finish and colour only apply to the styles made of a material
  const shaped = e.enabled && (e.style === 'bead' || e.style === 'dot' || e.style === 'button');
  $('#eye-look').hidden = !shaped;
  if (shaped) {
    const finish = e.finish ?? 'body';
    document.querySelectorAll<HTMLButtonElement>('#eye-finish button').forEach((b) => b.classList.toggle('active', b.dataset.finish === finish));
    const current = (e.color ?? (e.style === 'bead' ? '#1d1a22' : '#2a2730')).toLowerCase();
    const sw = $('#eye-swatches');
    sw.innerHTML = '';
    for (const c of EYE_SWATCHES) {
      const b = document.createElement('button');
      b.style.background = c;
      b.title = c;
      b.classList.toggle('active', c === current);
      b.onclick = () => setEyeLook((x) => (x.color = c));
      sw.append(b);
    }
    $<HTMLInputElement>('#eye-color').value = current;
  }
}

function renderUI() {
  if (!creature.bones.has(selected)) selected = creature.list[0].def.id;
  renderRigs();
  renderParts();
  renderPartCard();
  renderColors();
  renderStyles();
  renderMerge();
  renderEyes();
  renderRigPanel();
  renderAttachList();
  renderStuffPanel();
  renderCreatureBar();
}

function setColor(c: string, doCommit: boolean) {
  selPart().color = c;
  creature.sync();
  creature.markMergeDirty();
  if (doCommit) {
    commit();
    renderColors();
  }
  renderParts();
}

function setStyle(id: StyleId) {
  if ($<HTMLInputElement>('#style-part').checked) {
    selPart().style = id;
  } else {
    state.style = id;
    for (const p of Object.values(state.parts)) delete p.style;
  }
  creature.sync();
  creature.markMergeDirty();
  commit();
  renderStyles();
}

function switchRig(base: string) {
  if (base === state.rig.base) return;
  const rig = base.startsWith('saved:') ? savedRigs().find((r) => r.base === base) : rigFromTemplate(getRig(base));
  if (!rig) return;
  const dirty = Object.values(state.parts).some((p) => p.outline) || Object.keys(state.pose).length > 0;
  if (dirty && !confirm('Switch body plan? Your drawn shapes and pose will be cleared (colours and material stay).')) return;
  const body = state.parts[creature.list[0].src].color;
  const next = defaultState(rig, body);
  // same spot in the scene, same name
  next.placement = state.placement;
  next.name = state.name;
  next.style = state.style;
  next.eyes = state.eyes;
  exitDraw();
  state = next;
  selected = '';
  buildCreature();
  commit();
  renderUI();
  frameCreature(true);
}

function setMode(m: Mode) {
  if (drawState) exitDraw();
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('#build-panel').hidden = m !== 'build';
  $('#rig-panel').hidden = m !== 'rig';
  $('#pose-panel').hidden = m !== 'pose';
  $('#stuff-panel').hidden = m !== 'stuff';
  $('#creature-bar').hidden = m === 'stuff';
  if (m === 'stuff') stopPlacing();
  if (m !== 'build') {
    deselectAttachment();
    $('#attach-pop').hidden = true;
  }
  const wasStuff = board.visible;
  board.visible = m === 'stuff';
  for (const c of creatures) c.root.visible = m !== 'stuff';
  if (m === 'stuff') {
    syncWorkbench();
    renderStuffPanel();
    focusOnBoard();
    hint('Draw pieces on the board; the blue crosshair is where it attaches', 3200);
  } else if (wasStuff) {
    frameCreature();
  }
  creature.setRigMode(m === 'rig');
  updateSkeletonVisibility();
  if (m === 'pose') hint('Drag the orange joints to pose', 2200);
  if (m === 'rig') {
    hint('Drag joints to reshape the skeleton; purple squares move a whole limb', 3200);
    renderRigPanel();
  }
}

// ---------------------------------------------------------------------------
// rig editing

/** Apply a skeleton edit, give new bones a look, rebuild, and select the first new bone. */
function rigEdit(fn: (rig: RigState) => PartCopy[], copyShape: boolean) {
  const copies = fn(state.rig);
  for (const c of copies) {
    const from = state.parts[c.from];
    if (from && !state.parts[c.to]) state.parts[c.to] = { ...structuredClone(from), outline: copyShape ? structuredClone(from.outline) : null };
  }
  // an edited skeleton is no longer the saved/template one
  if (!state.rig.base.startsWith('custom')) state.rig.base = 'custom';
  buildCreature();
  // stuff on removed bones goes with them
  if (state.attachments) state.attachments = state.attachments.filter((a) => creature.bones.has(a.bone));
  if (copies.length) selected = copies[0].to;
  creature.select(selected);
  commit();
  renderUI();
}

function renderRigPanel() {
  const b = creature.bones.get(selected);
  const title = $<HTMLInputElement>('#rig-title');
  // a pair shares one name; the (L)/(R) is added on display
  if (document.activeElement !== title) title.value = b ? (state.rig.bones.find((d) => d.id === b.def.baseId)?.name ?? b.def.name) : '';
  title.disabled = !b;
  const isRoot = !b?.parent;
  const paired = !!b && b.def.sideSign !== 0;
  $<HTMLButtonElement>('#rig-dup').disabled = !b || isRoot;
  $<HTMLButtonElement>('#rig-del').disabled = !b || isRoot;
  $<HTMLButtonElement>('#rig-unlink').disabled = !paired || rigLocked();
  $<HTMLButtonElement>('#rig-eyes').disabled = !b || state.rig.headId === selected;
  $<HTMLButtonElement>('#rig-split').disabled = !b;
  $('#rig-pair-note').textContent = paired ? 'Mirrored pair: both sides move together.' : '';
  $<HTMLInputElement>('#rig-sym').checked = rigLocked();
  $('#rig-lock-icon').textContent = rigLocked() ? '🔒' : '🔓';
  if (b) {
    $<HTMLInputElement>('#rig-w0').value = String(b.def.width);
    $<HTMLInputElement>('#rig-w1').value = String(b.def.widthEnd ?? b.def.width);
    $('#rig-drawn-note').hidden = !state.parts[b.src]?.outline;
    $<HTMLInputElement>('#rig-roll').value = String(Math.round(((b.def.roll ?? 0) * 180) / Math.PI));
    $<HTMLInputElement>('#rig-bendy').checked = !!b.def.bendy;
    $<HTMLInputElement>('#rig-bend').value = String(b.def.bend ?? 0);
    $<HTMLInputElement>('#rig-bend-dir').value = String(Math.round(((b.def.bendDir ?? 0) * 180) / Math.PI));
    $('#rig-bend-row').classList.toggle('off', !b.def.bendy);
    $('#rig-bend-dir-row').classList.toggle('off', !b.def.bendy);
  }

  const list = $('#saved-rig-list');
  list.innerHTML = '';
  for (const r of savedRigs()) {
    const row = document.createElement('div');
    row.className = 'saved-rig';
    const load = document.createElement('button');
    load.className = 'ghost';
    load.textContent = `🦴 ${r.name}`;
    load.onclick = () => switchRig(r.base);
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = '✕';
    del.title = 'Delete saved rig';
    del.onclick = () => {
      if (!confirm(`Delete the saved rig "${r.name}"?`)) return;
      deleteSavedRig(r.name);
      renderRigPanel();
      renderRigs();
    };
    row.append(load, del);
    list.append(row);
  }
  if (!list.children.length) list.innerHTML = '<p class="muted small">No saved rigs yet.</p>';
}

$('#rig-add').onclick = () => rigEdit((rig) => addLimb(rig, selected, rigLocked()), false);
$('#rig-bone').onclick = () => rigEdit((rig) => addLimb(rig, selected, rigLocked(), 1), false);
$('#rig-split').onclick = () => {
  const r = splitBone(state.rig, selected);
  if (!r) {
    hint('This bone is too short to split', 1800, true);
    return;
  }
  // cut any drawing in two at the split so each half keeps its piece
  for (const [lo, hi] of r.pairs) {
    const p = state.parts[lo];
    if (!p) continue; // right twins share the left's drawing
    const upper: PartState = { ...structuredClone(p), outline: null };
    if (p.outline) {
      const below = clipLoop(p.outline, r.at, 'below');
      const above = clipLoop(p.outline, r.at, 'above');
      p.outline = below;
      upper.outline = above ? above.map(([x, y]) => [x, y - r.at] as Vec2) : null;
    }
    state.parts[hi] = upper;
  }
  rigEdit(() => [], false);
  hint('Split into two jointed halves', 1800);
};

// ---- lock symmetry (remembered) ----
const RIG_PREFS_KEY = 'creature-creator/rig-prefs';
let rigLock = (() => {
  try {
    return JSON.parse(localStorage.getItem(RIG_PREFS_KEY) ?? '{}').lock ?? true;
  } catch {
    return true;
  }
})() as boolean;
function rigLocked() {
  return rigLock;
}
$<HTMLInputElement>('#rig-sym').onchange = (e) => {
  rigLock = (e.target as HTMLInputElement).checked;
  try {
    localStorage.setItem(RIG_PREFS_KEY, JSON.stringify({ lock: rigLock }));
  } catch {
    /* ignore */
  }
  renderRigPanel();
  hint(rigLock ? 'Symmetry locked: new bones come in pairs, centre bones stay centred' : 'Symmetry unlocked', 2000);
};

// ---- per-bone default-shape widths and bend, applied live ----
let boneEditPending = false;
function editBone(fn: (d: BoneDef) => void) {
  const b = creature.bones.get(selected);
  const def = b && state.rig.bones.find((d) => d.id === b.def.baseId);
  if (!def) return;
  fn(def);
  if (boneEditPending) return;
  boneEditPending = true;
  requestAnimationFrame(() => {
    boneEditPending = false;
    // re-seat bones (bends move children) and rebuild the affected parts
    creature.relayout(state.rig);
    creature.sync();
  });
}
function commitBoneEdit() {
  if (!state.rig.base.startsWith('custom')) state.rig.base = 'custom';
  commit();
  renderRigPanel();
}
const round3n = (v: string) => Math.round(parseFloat(v) * 1000) / 1000;
$<HTMLInputElement>('#rig-w0').oninput = (e) => editBone((d) => (d.width = round3n((e.target as HTMLInputElement).value)));
$<HTMLInputElement>('#rig-w1').oninput = (e) => editBone((d) => (d.widthEnd = round3n((e.target as HTMLInputElement).value)));
$<HTMLInputElement>('#rig-bend').oninput = (e) => editBone((d) => (d.bend = round3n((e.target as HTMLInputElement).value)));
$<HTMLInputElement>('#rig-bend-dir').oninput = (e) =>
  editBone((d) => (d.bendDir = Math.round(parseFloat((e.target as HTMLInputElement).value) * (Math.PI / 180) * 1000) / 1000));
$<HTMLInputElement>('#rig-roll').oninput = (e) =>
  editBone((d) => (d.roll = Math.round(parseFloat((e.target as HTMLInputElement).value) * (Math.PI / 180) * 1000) / 1000));
for (const id of ['#rig-w0', '#rig-w1', '#rig-roll', '#rig-bend', '#rig-bend-dir']) $<HTMLInputElement>(id).onchange = () => commitBoneEdit();
$<HTMLInputElement>('#rig-bendy').onchange = (e) => {
  const on = (e.target as HTMLInputElement).checked;
  editBone((d) => {
    d.bendy = on;
    if (on && !d.bend) d.bend = 0.35; // start with a visible curve
  });
  requestAnimationFrame(() => commitBoneEdit());
};
// ---- naming a bone ----
function renameBone(commitIt: boolean) {
  const b = creature.bones.get(selected);
  const def = b && state.rig.bones.find((d) => d.id === b.def.baseId);
  const name = $<HTMLInputElement>('#rig-title').value.trim();
  if (!def || !name) return;
  def.name = name;
  // re-seat so the bones pick up the new name (it's shown on every part list)
  creature.relayout(state.rig);
  renderParts();
  if (commitIt) {
    commit();
    renderUI();
  }
}
$<HTMLInputElement>('#rig-title').oninput = () => renameBone(false);
$<HTMLInputElement>('#rig-title').onchange = () => renameBone(true);
$<HTMLInputElement>('#rig-title').onkeydown = (e) => {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
};

$('#rig-extend').onclick = () => rigEdit((rig) => extendBone(rig, selected), false);
$('#rig-dup').onclick = () => rigEdit((rig) => duplicateLimb(rig, selected), true);
$('#rig-unlink').onclick = () => rigEdit((rig) => unlinkPair(rig, selected), true);
$('#rig-del').onclick = () => {
  const parent = creature.bones.get(selected)?.parent?.def.id ?? '';
  rigEdit((rig) => {
    for (const d of deleteLimb(rig, selected)) {
      for (const id of partIds(d)) {
        delete state.parts[id];
        delete state.pose[id];
      }
    }
    return [];
  }, false);
  selectPart(creature.bones.has(parent) ? parent : creature.list[0].def.id);
};
$('#rig-eyes').onclick = () => {
  state.rig.headId = selected;
  buildCreature();
  commit();
  renderRigPanel();
  hint('Eyes moved to this part', 1800);
};
$('#rig-save').onclick = () => {
  const input = $<HTMLInputElement>('#rig-name');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    hint('Give the rig a name first', 1800, true);
    return;
  }
  saveRig(state.rig, name);
  state.rig.base = 'saved:' + name;
  state.rig.name = name;
  input.value = '';
  commit();
  renderRigs();
  renderRigPanel();
  hint(`Saved rig "${name}"`, 1800);
};

let hintTimer = 0;
function hint(text: string, ms = 2000, warn = false) {
  const el = $('#hint');
  clearTimeout(hintTimer);
  el.textContent = text;
  el.classList.toggle('show', !!text);
  el.classList.toggle('warn', warn);
  if (text && ms > 0) {
    hintTimer = window.setTimeout(() => {
      if (drawState) drawHint();
      else el.classList.remove('show');
    }, ms);
  }
}

// ---------------------------------------------------------------------------
// settings (remembered in this browser)

const SETTINGS_KEY = 'creature-creator/settings';
const settings: { numbers: boolean; seamless: SeamlessMode; seamlessLowPoly: boolean } = (() => {
  const defaults = { numbers: false, seamless: 'on' as SeamlessMode, seamlessLowPoly: false };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
})();
setSeamlessMode(settings.seamless);
setSeamlessLowPoly(settings.seamlessLowPoly);

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

function renderSettings() {
  document.body.classList.toggle('show-nums', settings.numbers);
  $<HTMLInputElement>('#set-nums').checked = settings.numbers;
  document.querySelectorAll<HTMLButtonElement>('#set-seamless button').forEach((b) => b.classList.toggle('active', b.dataset.seamless === settings.seamless));
  $<HTMLInputElement>('#set-seamless-lp').checked = settings.seamlessLowPoly;
  // nothing to apply it to while seamless joins are off
  $<HTMLInputElement>('#set-seamless-lp').disabled = settings.seamless === 'off';
  $('#set-seamless-lp-row').style.opacity = settings.seamless === 'off' ? '.45' : '1';
  if (settings.numbers) syncSliderNumbers();
}

/**
 * With "Show numbers" on, every slider has a number box beside it. Material
 * sliders make their own (marked `own`: they take values past the slider's
 * ends, so they aren't overwritten from it); the rest are added here and kept
 * in step with their slider.
 */
function syncSliderNumbers() {
  document.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((range) => {
    let num = range.nextElementSibling as HTMLInputElement | null;
    if (!num?.classList.contains('num')) {
      const box = document.createElement('input');
      box.type = 'number';
      box.className = 'num';
      box.oninput = () => {
        if (!Number.isFinite(parseFloat(box.value))) return;
        range.value = box.value;
        range.dispatchEvent(new Event('input', { bubbles: true }));
      };
      box.onchange = () => range.dispatchEvent(new Event('change', { bubbles: true }));
      range.after(box);
      num = box;
    }
    if (num.dataset.own || document.activeElement === num) return;
    num.step = range.step;
    const decimals = (range.step.split('.')[1] ?? '').length;
    const text = Number(range.value).toFixed(decimals);
    if (num.value !== text) num.value = text;
  });
}

$('#settings-btn').onclick = () => {
  if (togglePopover('#settings-pop')) renderSettings();
};
$<HTMLInputElement>('#set-seamless-lp').onchange = (e) => {
  settings.seamlessLowPoly = (e.target as HTMLInputElement).checked;
  setSeamlessLowPoly(settings.seamlessLowPoly);
  // low-poly creatures build (or drop) their skins
  for (const c of creatures) c.markMergeDirty();
  saveSettings();
  renderSettings();
};
$<HTMLInputElement>('#set-nums').onchange = (e) => {
  settings.numbers = (e.target as HTMLInputElement).checked;
  saveSettings();
  renderSettings();
};
document.querySelectorAll<HTMLButtonElement>('#set-seamless button').forEach((b) => {
  b.onclick = () => {
    settings.seamless = b.dataset.seamless as SeamlessMode;
    setSeamlessMode(settings.seamless);
    // each creature drops (or goes on to build) its skin
    for (const c of creatures) c.markMergeDirty();
    saveSettings();
    renderSettings();
    renderMerge();
  };
});

// wire up static controls
document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
$('#draw').onclick = () => enterDraw({ kind: 'bone', boneId: selected });
$('#cancel-draw').onclick = () => exitDraw();
$('#reset-shape').onclick = () => {
  selPart().outline = null;
  creature.sync();
  commit();
  renderUI();
};

let thicknessPending = false;
$<HTMLInputElement>('#thickness').oninput = (e) => {
  selPart().thickness = parseFloat((e.target as HTMLInputElement).value);
  if (thicknessPending) return;
  thicknessPending = true;
  requestAnimationFrame(() => {
    thicknessPending = false;
    creature.sync();
  });
};
$<HTMLInputElement>('#thickness').onchange = () => {
  creature.sync();
  commit();
};

$<HTMLInputElement>('#color').oninput = (e) => setColor((e.target as HTMLInputElement).value, false);
$<HTMLInputElement>('#color').onchange = (e) => setColor((e.target as HTMLInputElement).value, true);
$('#paint-all').onclick = () => {
  const c = selPart().color;
  for (const p of Object.values(state.parts)) p.color = c;
  creature.sync();
  commit();
  renderUI();
};
$<HTMLInputElement>('#style-part').onchange = () => renderStyles();

function renderBackdrops() {
  const el = $('#backdrops');
  el.innerHTML = '';
  for (const c of BACKDROPS) {
    const btn = document.createElement('button');
    btn.style.background = c;
    btn.title = c;
    btn.classList.toggle('active', c === backdrop);
    btn.onclick = () => {
      setBackdrop(c);
      renderBackdrops();
    };
    el.append(btn);
  }
  $<HTMLInputElement>('#backdrop-color').value = backdrop;
}
$('#backdrop-btn').onclick = () => {
  if (!togglePopover('#backdrop')) return;
  renderBackdrops();
  renderFloorUI();
  $<HTMLInputElement>('#light-turn').value = String(lightTurn);
};
$<HTMLInputElement>('#light-turn').oninput = (e) => {
  lightTurn = parseFloat((e.target as HTMLInputElement).value);
  applyLighting();
  try {
    localStorage.setItem(LIGHT_KEY, JSON.stringify({ turn: lightTurn }));
  } catch {
    /* ignore */
  }
};
$<HTMLInputElement>('#backdrop-color').oninput = (e) => {
  setBackdrop((e.target as HTMLInputElement).value);
  renderBackdrops();
};

const FLOOR_SWATCHES = ['#d6c7b3', '#b9a58a', '#8d6e63', '#ece6da', '#a9c2a4', '#a3b3cf', '#4a4350', '#2b2f3a'];

function renderFloorUI() {
  document.querySelectorAll<HTMLButtonElement>('#floor-mode button').forEach((b) => b.classList.toggle('active', b.dataset.floor === floorPrefs.mode));
  $('#floor-mirror-opts').hidden = floorPrefs.mode !== 'mirror';
  $('#floor-material-opts').hidden = floorPrefs.mode !== 'material';
  $<HTMLInputElement>('#floor-reflect').value = String(floorPrefs.reflect);
  $<HTMLInputElement>('#floor-color').value = floorPrefs.color;
  const styles = $('#floor-styles');
  styles.innerHTML = '';
  for (const s of STYLES) {
    if (s.id === 'glass') continue;
    const b = document.createElement('button');
    b.innerHTML = `<span class="ball ${s.id}"></span>`;
    b.append(s.name);
    b.classList.toggle('active', s.id === floorPrefs.style);
    b.onclick = () => updateFloor(() => (floorPrefs.style = s.id));
    styles.append(b);
  }
  const sw = $('#floor-swatches');
  sw.innerHTML = '';
  for (const c of FLOOR_SWATCHES) {
    const b = document.createElement('button');
    b.style.background = c;
    b.title = c;
    b.classList.toggle('active', c === floorPrefs.color);
    b.onclick = () => updateFloor(() => (floorPrefs.color = c));
    sw.append(b);
  }
}

function updateFloor(fn: () => void) {
  fn();
  saveFloor();
  applyFloor();
  renderFloorUI();
}

document.querySelectorAll<HTMLButtonElement>('#floor-mode button').forEach((b) => {
  b.onclick = () => updateFloor(() => (floorPrefs.mode = b.dataset.floor as FloorMode));
});
$<HTMLInputElement>('#floor-reflect').oninput = (e) => {
  floorPrefs.reflect = parseFloat((e.target as HTMLInputElement).value);
  saveFloor();
  applyFloor();
};
$<HTMLInputElement>('#floor-color').oninput = (e) => {
  floorPrefs.color = (e.target as HTMLInputElement).value;
  saveFloor();
  applyFloor();
};
$<HTMLInputElement>('#floor-color').onchange = () => renderFloorUI();
$<HTMLInputElement>('#ao').onchange = (e) => {
  gtao.enabled = (e.target as HTMLInputElement).checked;
};
// ---------------------------------------------------------------------------
// depth of field: focus follows the orbit target, nudged by `offset`

const DOF_KEY = 'creature-creator/dof';
const dof: { enabled: boolean; offset: number; blur: number } = (() => {
  try {
    return { enabled: false, offset: 0, blur: 0.35, ...JSON.parse(localStorage.getItem(DOF_KEY) ?? '{}') };
  } catch {
    return { enabled: false, offset: 0, blur: 0.35 };
  }
})();
let pickingFocus = false;
let focusMarkerUntil = 0;

// a ring floating on the focus plane, shown briefly while focus changes
const focusMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.2, 0.215, 64),
  new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.8, depthTest: false }),
);
focusMarker.renderOrder = 1001;
focusMarker.visible = false;
scene.add(focusMarker);

function saveDof() {
  try {
    localStorage.setItem(DOF_KEY, JSON.stringify(dof));
  } catch {
    /* ignore */
  }
}

function focusDistance() {
  return Math.max(0.2, camera.position.distanceTo(controls.target) + dof.offset);
}

function applyDof() {
  bokeh.enabled = dof.enabled;
  // blur 0..1 maps onto the lens aperture; maxblur caps the spread
  const u = bokeh.uniforms as Record<string, THREE.IUniform>;
  u.aperture.value = 0.0004 + Math.pow(dof.blur, 2) * 0.03;
  u.maxblur.value = 0.004 + dof.blur * 0.026;
  $<HTMLInputElement>('#dof').checked = dof.enabled;
  $<HTMLInputElement>('#dof-focus').value = String(dof.offset);
  $<HTMLInputElement>('#dof-blur').value = String(dof.blur);
  $('#dof-controls').style.opacity = dof.enabled ? '1' : '.4';
  $('#dof-pick').classList.toggle('on', pickingFocus);
}

function showFocusMarker() {
  focusMarkerUntil = performance.now() + 1200;
}

function updateFocus(now: number) {
  const d = focusDistance();
  (bokeh.uniforms as Record<string, THREE.IUniform>).focus.value = d;
  const show = dof.enabled && now < focusMarkerUntil;
  focusMarker.visible = show;
  if (show) {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    focusMarker.position.copy(camera.position).addScaledVector(dir, d);
    focusMarker.quaternion.copy(camera.quaternion);
    // keep the ring a constant size on screen
    focusMarker.scale.setScalar(d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9);
    (focusMarker.material as THREE.MeshBasicMaterial).opacity = Math.min(0.8, (focusMarkerUntil - now) / 400);
  }
}

/** Click-to-focus: put the focus plane on whatever is under the pointer. */
function focusAt(x: number, y: number) {
  setRay(x, y);
  const targets = mode === 'stuff' ? [board] : creatures.map((c) => c.root);
  const hit = raycaster.intersectObjects(targets, true).find((h) => h.object instanceof THREE.Mesh && h.object.visible);
  const point = hit?.point ?? raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  if (!point) return;
  const depth = point.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
  dof.offset = THREE.MathUtils.clamp(depth - camera.position.distanceTo(controls.target), -3, 3);
  dof.enabled = true;
  pickingFocus = false;
  saveDof();
  applyDof();
  showFocusMarker();
  $('#viewport').style.cursor = '';
  hint('Focus set', 1200);
}

$<HTMLInputElement>('#dof').onchange = (e) => {
  dof.enabled = (e.target as HTMLInputElement).checked;
  saveDof();
  applyDof();
  if (dof.enabled) showFocusMarker();
};
$<HTMLInputElement>('#dof-focus').oninput = (e) => {
  dof.offset = parseFloat((e.target as HTMLInputElement).value);
  saveDof();
  showFocusMarker();
};
$<HTMLInputElement>('#dof-blur').oninput = (e) => {
  dof.blur = parseFloat((e.target as HTMLInputElement).value);
  saveDof();
  applyDof();
};
$('#dof-reset').onclick = () => {
  dof.offset = 0;
  saveDof();
  applyDof();
  showFocusMarker();
};
$('#dof-pick').onclick = () => {
  pickingFocus = !pickingFocus;
  applyDof();
  $('#viewport').style.cursor = pickingFocus ? 'crosshair' : '';
  if (pickingFocus) hint('Click on the spot that should be sharp', 0);
  else hint('');
};
applyDof();

// Blending: each slider at 0 is the same as that kind of blending being off.
// The last non-zero amount is kept, so files and undo stay compatible.
$<HTMLInputElement>('#merge-radius').oninput = (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  state.merge = v > 0;
  if (v > 0) state.mergeRadius = v;
  creature.markMergeDirty();
  renderMerge();
};
$<HTMLInputElement>('#color-blend').oninput = (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  state.mergeColors = v > 0;
  if (v > 0) state.colorBlend = v;
  creature.markMergeDirty();
  renderMerge();
};
for (const id of ['#merge-radius', '#color-blend']) $<HTMLInputElement>(id).onchange = () => commit();

function renderMerge() {
  const on = state.merge ?? true;
  $<HTMLInputElement>('#merge-radius').value = String(on ? (state.mergeRadius ?? 0.1) : 0);
  $<HTMLInputElement>('#color-blend').value = String(state.mergeColors ? (state.colorBlend ?? 0.12) : 0);
  // colours only blend where parts blend
  $('#color-blend-row').classList.toggle('off', !on);
  // per creature, only when Settings leaves it to each creature
  $('#seamless-row').hidden = settings.seamless !== 'creature';
  $<HTMLInputElement>('#seamless').checked = state.seamless ?? true;
  $<HTMLInputElement>('#seamless').disabled = !on;
  $('#seamless-row').style.opacity = on ? '1' : '.45';
}

$<HTMLInputElement>('#seamless').onchange = (e) => {
  state.seamless = (e.target as HTMLInputElement).checked;
  creature.invalidateSkin();
  commit();
  renderMerge();
};

for (const k of ['size', 'spacing', 'height'] as const) {
  const input = $<HTMLInputElement>(`#eye-${k}`);
  input.oninput = () => {
    state.eyes.pairs[eyePair][k] = parseFloat(input.value);
    creature.sync();
  };
  input.onchange = () => commit();
}

const EYE_SWATCHES = ['#1d1a22', '#2a2730', '#3b2a20', '#1f3a5a', '#2f5d3a', '#6a1f2a', '#8a6d3b', '#f4f1ea'];

function setEyeLook(fn: (e: CreatureState['eyes']) => void) {
  fn(state.eyes);
  creature.sync();
  commit();
  renderEyes();
}
document.querySelectorAll<HTMLButtonElement>('#eye-finish button').forEach((b) => {
  b.onclick = () => setEyeLook((e) => (e.finish = b.dataset.finish as EyeFinish));
});
$<HTMLInputElement>('#eye-color').oninput = (ev) => {
  state.eyes.color = (ev.target as HTMLInputElement).value;
  creature.sync();
};
$<HTMLInputElement>('#eye-color').onchange = () => {
  commit();
  renderEyes();
};
$<HTMLInputElement>('#eye-lift').oninput = (ev) => {
  state.eyes.pairs[eyePair].lift = parseFloat((ev.target as HTMLInputElement).value);
  creature.sync();
};
$<HTMLInputElement>('#eye-lift').onchange = () => commit();

$<HTMLInputElement>('#skeleton-build').onchange = () => updateSkeletonVisibility();
$('#reset-pose').onclick = () => {
  creature.resetPose();
  commit();
};
$('#drop-floor').onclick = () => dropToFloor();
document.querySelectorAll<HTMLButtonElement>('#view-bar [data-view]').forEach((b) => (b.onclick = () => viewFrom(b.dataset.view!)));

$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#spin').onclick = () => {
  controls.autoRotate = !controls.autoRotate;
  $('#spin').classList.toggle('on', controls.autoRotate);
};
$('#new').onclick = () => {
  if (!confirm('Start a new creature? (You can undo this.)')) return;
  exitDraw();
  // a fresh creature in the same spot in the scene (named afresh too)
  state = { ...defaultState(state.rig), placement: state.placement };
  buildCreature();
  commit();
  renderUI();
  frameCreature(true);
};

/** Render one clean frame without handles or guides, then restore. */
function withCleanScene<T>(fn: () => T): T {
  const skel = handlesVisible();
  creature.setSkeletonVisible(false);
  creature.flash(null, 0);
  try {
    return fn();
  } finally {
    creature.setSkeletonVisible(skel);
  }
}

$('#shot').onclick = () => {
  const url = withCleanScene(() => {
    composer.render();
    return canvas.toDataURL('image/png');
  });
  download(url, 'creature.png');
};

$('#export').onclick = () => {
  const inks: THREE.Object3D[] = [];
  const roots = creatures.map((c) => c.root);
  for (const root of roots) {
    root.traverse((o) => {
      // ink hulls and felt fuzz are render-only effects; they don't belong in the model file
      const ink = o instanceof THREE.Mesh && (o.material as THREE.Material).userData?.ink;
      if ((ink || o.userData.fx) && o.visible) inks.push(o);
    });
  }
  withCleanScene(() => {
    inks.forEach((o) => (o.visible = false));
    new GLTFExporter().parse(
      // every creature in the scene, each at its placement
      roots,
      (result) => {
        inks.forEach((o) => (o.visible = true));
        const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
        const url = URL.createObjectURL(blob);
        download(url, 'creature.glb');
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      },
      (err) => {
        inks.forEach((o) => (o.visible = true));
        console.error(err);
        hint('Export failed, sorry!', 2500, true);
      },
      { binary: true, onlyVisible: true },
    );
  });
};

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  // typing in a text or number box
  if (tag === 'INPUT' && ['text', 'number'].includes((e.target as HTMLInputElement).type)) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
    e.preventDefault();
    redo();
  } else if (k === 'escape' && drawState) {
    exitDraw();
  } else if (k === 'enter' && drawState) {
    e.preventDefault();
    finishDraw();
  } else if ((k === 'e' || k === 'm' || k === 't' || k === 'r') && drawState && !e.ctrlKey && !e.metaKey) {
    setDrawTool(({ e: 'erase', m: 'move', t: 'scale', r: 'rotate' } as const)[k]);
  } else if (k === 's' && drawState && !e.ctrlKey && !e.metaKey) {
    toggleSymmetry();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (k === 'd' && mode === 'build') enterDraw();
    else if (k === 'd' && mode === 'stuff') enterDraw({ kind: 'piece', hole: false });
    else if (k === '4') setMode('stuff');
    else if (selectedAttachment && (k === 'w' || k === 'e' || k === 'r')) {
      gizmo.setMode(k === 'w' ? 'translate' : k === 'e' ? 'rotate' : 'scale');
      syncAttachBar();
    }
    else if (k === '1') setMode('build');
    else if (k === '2') setMode('rig');
    else if (k === '3') setMode('pose');
    else if (k === 'f') frameCreature();
    else if (k === 'a' && e.shiftKey) frameAll();
  }
});

// ---------------------------------------------------------------------------
// resize + loop

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(Math.min(devicePixelRatio, 2));
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const dpr = Math.min(devicePixelRatio, 2);
  overlay.width = w * dpr;
  overlay.height = h * dpr;
  sizeMirror();
  renderOverlay();
  invalidate();
}
new ResizeObserver(resize).observe(viewport);

// Anything the user does may change the scene. Pointer moves only count over
// the viewport (hover highlights, gizmo) or while a button is held.
for (const type of ['pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change', 'click']) {
  window.addEventListener(type, () => invalidate(), { capture: true, passive: true });
}
window.addEventListener(
  'pointermove',
  (e) => {
    if (e.buttons || viewport.contains(e.target as Node)) invalidate();
  },
  { capture: true, passive: true },
);

/**
 * Everything the shadow map depends on: each visible caster (and its geometry
 * edits) plus the key light's placement and frustum. Compared frame to frame.
 */
let shadowState: unknown[] = [];
function shadowsChanged(): boolean {
  scene.updateMatrixWorld();
  const next: unknown[] = [];
  const cam = key.shadow.camera;
  next.push(...key.matrixWorld.elements, ...key.target.matrixWorld.elements, cam.left, cam.right, cam.top, cam.bottom, cam.far);
  scene.traverseVisible((o) => {
    if (!(o instanceof THREE.Mesh) || !o.castShadow) return;
    const pos = o.geometry.getAttribute('position');
    next.push(o, o.geometry, pos?.version ?? 0, o.material, ...o.matrixWorld.elements);
  });
  const changed = next.length !== shadowState.length || next.some((v, i) => v !== shadowState[i]);
  shadowState = next;
  return changed;
}

/**
 * Once nothing has changed for a moment, rebuild merged joins as seamless
 * skins (in small chunks, so the page stays responsive). Not while you're
 * mid-drag, drawing, editing the rig or on the Stuff workbench.
 */
const SETTLE_AFTER_MS = 600;
function settleWhenIdle(now: number) {
  const busy = !!drawState || !!drag || gizmo.dragging || mode === 'rig' || mode === 'stuff';
  let building = false;
  for (const c of creatures) {
    if (c.skinState === 'building') building = true;
    else if (!busy && c.skinState === 'none' && now - c.lastChange > SETTLE_AFTER_MS) {
      void c.settle();
      // settle() flips the state synchronously before its first await
      building ||= (c.skinState as string) === 'building';
    }
  }
  $('#settle-badge').hidden = !building;
}

let lastSkins = '';
function loop(now: number) {
  requestAnimationFrame(loop);
  if (tween) {
    const t = Math.min(1, (now - tween.start) / tween.dur);
    const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    camera.position.lerpVectors(tween.p0, tween.p1, k);
    controls.target.lerpVectors(tween.t0v, tween.t1v, k);
    if (t >= 1) tween = null;
    invalidate(2);
  }
  // true while damping or auto-rotating
  if (controls.update()) invalidate(2);
  const f = 1 - (now - flashStart) / 700;
  // one extra frame after the flash ends clears the glow
  if (f > -0.1) invalidate(1);
  if (mode === 'stuff') flashPiece(drawState ? 0 : Math.max(0, f));
  else creature.flash(drawState ? null : selected, Math.max(0, f));
  for (const c of creatures) if (c.updateMerge()) invalidate();
  settleWhenIdle(now);
  // skins finish building asynchronously, between frames
  const skins = creatures.map((c) => c.skinState).join();
  if (skins !== lastSkins) invalidate();
  lastSkins = skins;
  if (drawState && !drawState.active) renderOverlay();
  if (dof.enabled && now < focusMarkerUntil + 100) invalidate(1);
  updateFocus(now);
  if (renderFrames <= 0) return;
  renderFrames--;
  // sliders moved by code (undo, switching parts...) keep their numbers in step
  if (settings.numbers) syncSliderNumbers();
  if (shadowsChanged()) renderer.shadowMap.needsUpdate = true;
  composer.render();
}

// ---------------------------------------------------------------------------
// boot

world.creatures.forEach((s, i) => (creatures[i] = makeCreature(s)));
activate(world.active);
commit();
renderUI();
renderSettings();
applyLighting();
applyFloor();
resize();
requestAnimationFrame(loop);

// handy for poking at the scene from the dev-tools console
if (import.meta.env.DEV) Object.assign(window, { __cc: { scene, camera, controls, flyTo, renderNow: () => { controls.update(); composer.render(); }, screenToLocal, localToOverlay, partPlane, get creature() { return creature; }, get drawState() { return drawState; }, openFile, selectAttachment } });

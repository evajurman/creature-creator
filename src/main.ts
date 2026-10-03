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
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  bendFromMid,
  Creature,
  defaultState,
  EYE_STYLES,
  partShapes,
  setPartShapes,
  setSeamlessLowPoly,
  setSeamlessMode,
  type Attachment,
  type BoneRT,
  type CreatureState,
  type EyeFinish,
  type EyeStyle,
  type PartShape,
  type PartState,
  type Placement,
  type SeamlessMode,
} from './creature';
import { bounds, clipLoop, combineLoops, getMeshDetail, pointInPolygon, setMeshDetail, signedArea, smoothLoop, symmetrize, type Vec2 } from './inflate';
import {
  buildThing,
  clearCollection,
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
  type Wearer,
} from './stuff';
import { FUR_LAYER, STYLE_PARAMS, STYLES, makeMaterial, setFuzzQuality, setGlassEnvironment, styleSettings, type StyleId } from './materials';
import { installScrollbars } from './scrollbars';
import { installCursorPress } from './cursorPress';
import {
  RIGS,
  addLimb,
  deleteLimb,
  deleteSavedRig,
  duplicateLimb,
  extendBone,
  getRig,
  moveJoint,
  partIds,
  rigFromTemplate,
  saveRig,
  scaleBone,
  savedRigs,
  splitBone,
  unlinkPair,
  type BoneDef,
  type PartCopy,
  type RigState,
  type V3,
} from './rigs';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** Font Awesome icon markup. Slab where it has the icon, classic regular (`fa-regular fa-…`) otherwise. */
const fa = (name: string) => `<i class="fa-slab fa-regular fa-${name}" aria-hidden="true"></i>`;
const faClassic = (name: string) => `<i class="fa-regular fa-${name}" aria-hidden="true"></i>`;
/** Sets an element to an icon followed by text (added as a text node, so names need no escaping). */
function iconLabel(el: HTMLElement, icon: string, text = '') {
  el.innerHTML = icon;
  if (text) el.append(` ${text}`);
}

// ---------------------------------------------------------------------------
// renderer / scene

const viewport = $('#viewport');
const canvas = $<HTMLCanvasElement>('#gl');
const overlay = $<HTMLCanvasElement>('#overlay');
const octx = overlay.getContext('2d')!;

// ---------------------------------------------------------------------------
// performance: how much work each frame and each shape takes (Settings)

type Quality = 'high' | 'balanced' | 'fast';
const QUALITY: Record<Quality, { dpr: number; detail: number; fuzz: number; samples: number; shadow: number; ao: boolean; aoSamples: number; glass: number }> = {
  high: { dpr: 2, detail: 1, fuzz: 1, samples: 4, shadow: 2048, ao: true, aoSamples: 16, glass: 1 },
  balanced: { dpr: 1.5, detail: 0.6, fuzz: 0.67, samples: 4, shadow: 2048, ao: true, aoSamples: 8, glass: 0.75 },
  fast: { dpr: 1, detail: 0.35, fuzz: 0.34, samples: 2, shadow: 1024, ao: false, aoSamples: 8, glass: 0.5 },
};
let quality: Quality = (() => {
  try {
    const q = JSON.parse(localStorage.getItem('creature-creator/settings') ?? '{}').quality;
    return q in QUALITY ? (q as Quality) : 'high';
  } catch {
    return 'high';
  }
})();
const pixelRatio = () => Math.min(devicePixelRatio, QUALITY[quality].dpr);
setMeshDetail(QUALITY[quality].detail);
setFuzzQuality(QUALITY[quality].fuzz);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(pixelRatio());
renderer.transmissionResolutionScale = QUALITY[quality].glass;
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
key.shadow.mapSize.setScalar(QUALITY[quality].shadow);
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
// backdrop color is seamless in every direction.
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
// A backdrop-colored veil over the mirror: reflection strength fades the
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
  const dpr = pixelRatio();
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

/**
 * Glass only refracts what's drawn before it, which is the opaque objects, so a
 * see-through shadow catcher would vanish behind a glass jar (a creature in a
 * jar would float with no shadow under it). So the catcher is drawn with the
 * opaque objects, keeping its alpha blending. Over a mirror it has to be drawn
 * after the veil instead, as a normal see-through layer.
 */
function setShadowCatcher(withOpaque: boolean) {
  if (shadowMat.transparent === !withOpaque) return;
  shadowMat.transparent = !withOpaque;
  shadowMat.blending = withOpaque ? THREE.CustomBlending : THREE.NormalBlending;
  shadowMat.blendSrc = THREE.SrcAlphaFactor;
  shadowMat.blendDst = THREE.OneMinusSrcAlphaFactor;
  // as three's normal blending: the picture's own alpha stays solid
  shadowMat.blendSrcAlpha = THREE.OneFactor;
  shadowMat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  shadowMat.needsUpdate = true;
}

function applyFloor() {
  const m = floorPrefs.mode;
  ground.visible = m === 'shadow' || m === 'mirror';
  setShadowCatcher(m !== 'mirror');

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

/** Pre-compensate a color so it comes out of tone mapping unchanged. */
function untoned(target: THREE.Color): THREE.Color {
  const want = [target.r, target.g, target.b];
  let c = want.slice();
  for (let i = 0; i < 40; i++) {
    const got = neutralTone(c);
    c = c.map((v, j) => Math.min(8, Math.max(0, v + (want[j] - got[j]))));
  }
  return new THREE.Color(c[0], c[1], c[2]);
}

/** Tints the shadow toward a deeper, slightly cooler version of the backdrop, and the bounce light toward it. */
function tintForBackdrop(c: THREE.Color) {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  shadowMat.color.setHSL((hsl.h + 0.02) % 1, Math.min(1, hsl.s * 0.8 + 0.1), hsl.l * 0.25);
  hemi.groundColor.copy(c).multiplyScalar(0.8);
}

function setBackdrop(hex: string) {
  backdrop = hex;
  const c = new THREE.Color(hex);
  scene.background = untoned(c);
  tintForBackdrop(c);
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
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: QUALITY[quality].samples }));

// Felt fuzz and ambient occlusion: AO darkens whatever pixels it lands on,
// and the fuzz halo sticks out past the body's edge over the floor's contact
// shadow, so it would come out with dark smudges along the silhouette. With AO
// on, the fuzz (shells and stray hairs, flagged `fx`) is hidden for the scene
// and AO passes and drawn afterwards, on top, by furPass.
let furHidden: THREE.Object3D[] = [];
function hideFur() {
  scene.traverseVisible((o) => {
    if (o.userData.fx) furHidden.push(o);
  });
  for (const o of furHidden) o.visible = false;
}
function showFur() {
  for (const o of furHidden) o.visible = true;
  furHidden = [];
}

const scenePass = new RenderPass(scene, camera);
const scenePassRender = scenePass.render.bind(scenePass);
scenePass.render = (...args: Parameters<RenderPass['render']>) => {
  if (furPass.enabled) hideFur();
  scenePassRender(...args);
};
composer.addPass(scenePass);
const gtao = new GTAOPass(scene, camera, 1, 1);
gtao.updateGtaoMaterial({ radius: 0.28, distanceExponent: 1.6, thickness: 1.2, scale: 1.3, samples: QUALITY[quality].aoSamples });
gtao.enabled = QUALITY[quality].ao;
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
gtao.blendIntensity = 1.0;
composer.addPass(gtao);

/**
 * Draws the fuzz over the AO'd image. The image's own depth was lost when AO
 * wrote it out, so AO's depth (the scene without fuzz) is copied in first:
 * fuzz behind the body stays hidden.
 */
class FurPass extends Pass {
  private depthCopy = new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDepth; varying vec2 vUv; void main() { gl_FragDepth = texture2D(tDepth, vUv).x; }',
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
      colorWrite: false,
    }),
  );

  constructor() {
    super();
    this.needsSwap = false;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const fur = furHidden;
    showFur();
    if (!fur.length) return;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    (this.depthCopy.material as THREE.ShaderMaterial).uniforms.tDepth.value = gtao.depthTexture;
    this.depthCopy.render(renderer);
    // only the fuzz: no backdrop (it would paint over everything), lights kept
    const background = scene.background;
    scene.background = null;
    const mask = camera.layers.mask;
    camera.layers.set(FUR_LAYER);
    renderer.render(scene, camera);
    camera.layers.mask = mask;
    scene.background = background;
    renderer.autoClear = autoClear;
  }
}
const furPass = new FurPass();
furPass.enabled = gtao.enabled;
composer.addPass(furPass);
// lights have to share the fuzz's layer to light it
for (const l of [hemi, key, fill, rim]) l.layers.enable(FUR_LAYER);
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
/** Nothing picked: no creature or part shows as selected (no handles, no part editor) until one is clicked. */
let idle = true;
type Mode = 'shape' | 'look' | 'stuff';
let mode: Mode = 'shape';
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
  if (mode === 'stuff') autosaveThing();
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
  if (mode === 'stuff') autosaveThing();
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
    creature.setSkeletonVisible(false);
    creature.flash(null, 0);
  }
  // gizmos belong to the previous creature
  if (switching) stopPlacing();
  world.active = i;
  state = world.creatures[i];
  creature = next;
  if (switching) deselectAttachment();
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
const pointer = { downX: 0, downY: 0, moved: false, touch: false };
/** A phone or tablet: hints talk about fingers, not mice and keys. */
const touchScreen = () => matchMedia('(pointer: coarse)').matches;
// the last tap on the 3D view, to spot a double tap
let lastTap = { t: 0, x: 0, y: 0 };
let lastDoubleTap = 0;
type DragKind = 'root' | 'start' | 'end' | 'bend' | 'len' | 'wid' | 'size' | 'roll';
let drag: {
  id: string;
  kind: DragKind;
  plane: THREE.Plane;
  offset: THREE.Vector3;
  startHit: THREE.Vector3;
  /** rig mode: skeleton at the start of the drag, so each move re-applies from scratch */
  rigBase?: string;
  /**
   * reshaping: turns a world-space move into skeleton space. The bone's base
   * rides its parent, so this undoes everything above it (the parent's pose,
   * a bendy parent's curve, the creature's turn and size) but not the bone's
   * own bend.
   */
  toDef?: THREE.Matrix3;
  /** size gizmo: what it's measured against on screen, and the drawing before the drag */
  sizer?: { anchor: THREE.Vector2; reach: THREE.Vector2; shapes: PartShape[]; meshX: Map<THREE.Mesh, number> };
  /** roll ring: where the press was, which way on screen the ring moves as the part rolls, and how many pixels per radian */
  roll?: {
    start: THREE.Vector2;
    dir: THREE.Vector2;
    pxPerRad: number;
    base: number;
    /** the part (and its twin) before the drag: rest turn and pose, to keep a posed limb where it is */
    rest: Map<string, THREE.Quaternion>;
    pose: CreatureState['pose'];
  };
  moved: boolean;
} | null = null;

/**
 * A pose is kept relative to a part's rest axes, which a roll turns: turn it
 * back the other way so a bent limb stays where it was and only spins about
 * its length. `rest` and `pose` are from before the roll.
 */
function keepPoseThroughRoll(rest: Map<string, THREE.Quaternion>, pose: CreatureState['pose']) {
  for (const [lid, before] of rest) {
    const q = pose[lid];
    const l = creature.bones.get(lid);
    if (!q || !l) continue;
    const d = before.clone().invert().multiply(l.restQuat);
    const kept = d.clone().invert().multiply(new THREE.Quaternion(...q)).multiply(d);
    state.pose[lid] = kept.toArray() as [number, number, number, number];
  }
  creature.applyPose();
}

/** Double-clicking a roll grip: straighten the part's roll (and its twin's). */
function resetRoll(id: string) {
  const b = creature.bones.get(id);
  const def = b && state.rig.bones.find((d) => d.id === b.def.baseId);
  if (!b || !def) return;
  if (!def.roll) {
    hint('Already straight', 1200);
    return;
  }
  const rest = new Map(creature.linked(id).map((l) => [l.def.id, l.restQuat.clone()] as const));
  const pose = structuredClone(state.pose);
  def.roll = 0;
  creature.relayout(state.rig);
  keepPoseThroughRoll(rest, pose);
  if (!state.rig.base.startsWith('custom')) state.rig.base = 'custom';
  buildCreature();
  settleOnFloor();
  creature.boing(id);
  commit();
  selectPart(id);
  hint('Roll straightened', 1400);
}

/** Double-clicking the green bend diamond: straighten the part (and its twin). */
function resetBend(id: string) {
  const b = creature.bones.get(id);
  const def = b && state.rig.bones.find((d) => d.id === b.def.baseId);
  if (!b || !def) return;
  if (!def.bendy || !def.bend) {
    hint('Already straight', 1200);
    return;
  }
  def.bendy = false;
  def.bend = 0;
  creature.relayout(state.rig);
  if (!state.rig.base.startsWith('custom')) state.rig.base = 'custom';
  buildCreature();
  settleOnFloor();
  creature.boing(id);
  commit();
  selectPart(id);
  hint('Bend straightened', 1400);
}

/** Where a point in a bone's own space lands on screen, in client pixels. */
function toScreen(obj: THREE.Object3D, local: THREE.Vector3): THREE.Vector2 {
  const r = canvas.getBoundingClientRect();
  const v = obj.localToWorld(local.clone()).project(camera);
  return new THREE.Vector2(r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height);
}

/** Height of the creature's lowest point above the floor. */
function floorGap(): number {
  const box = creatureBox(true);
  return box.isEmpty() ? 0 : box.min.y;
}
/** where the lowest point was when a move began: raising it means the creature should float */
let gapBefore = 0;
const lifted = () => floorGap() > Math.max(0, gapBefore) + 0.02;

/** Turn "Keep feet on the floor" on or off for this creature. */
function setKeepFloor(on: boolean, announce = false) {
  if ((state.keepFloor !== false) === on) return;
  state.keepFloor = on;
  $<HTMLInputElement>('#keep-floor').checked = on;
  if (announce) hint(on ? 'Feet back on the floor' : 'Floating: "Keep feet on the floor" is off', 2200);
}

/** After a bend or resize, a creature that keeps its feet on the floor settles back onto it. */
function settleOnFloor() {
  if (state.keepFloor === false) return;
  const box = creatureBox(true);
  if (box.isEmpty() || Math.abs(box.min.y) < 1e-4) return;
  const down = creature.root.worldToLocal(new THREE.Vector3(0, -box.min.y, 0)).sub(creature.root.worldToLocal(new THREE.Vector3()));
  creature.group.position.add(down);
  creature.capturePose();
}

canvas.addEventListener('pointerdown', (e) => {
  pointer.downX = e.clientX;
  pointer.downY = e.clientY;
  pointer.moved = false;
  pointer.touch = e.pointerType !== 'mouse';
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
  const kind: DragKind = id === 'root' ? 'root' : (h.userData.kind as DragKind);
  // bending is posing; sliding, curving and resizing reshape the skeleton itself
  const reshape = kind !== 'root' && kind !== 'end';
  let toDef: THREE.Matrix3 | undefined;
  const b = creature.bones.get(id);
  if (reshape && b) {
    b.pivot.updateMatrixWorld(true);
    // where the bone would be in the scene if it weren't bent itself
    const unbent = b.pivot.parent!.matrixWorld.clone().multiply(new THREE.Matrix4().compose(b.pivot.position, b.restQuat, new THREE.Vector3(1, 1, 1)));
    toDef = new THREE.Matrix3().setFromMatrix4(b.restWorld.clone().multiply(unbent.invert()));
  }
  let sizer: NonNullable<typeof drag>['sizer'];
  let roll: NonNullable<typeof drag>['roll'];
  if (b && kind === 'roll') {
    // which way the ring travels on screen as the part rolls a little (about its own length)
    const at = h.position.clone();
    const eps = 0.02;
    const moved = toScreen(b.pivot, at.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), eps)).sub(toScreen(b.pivot, at));
    const pxPerRad = moved.length() / eps;
    // seen end-on the ring barely moves: fall back to dragging sideways
    const visible = pxPerRad > 40;
    const dir = visible ? moved.normalize() : new THREE.Vector2(1, 0);
    const rest = new Map(creature.linked(id).map((l) => [l.def.id, l.restQuat.clone()] as const));
    roll = { start: new THREE.Vector2(e.clientX, e.clientY), dir, pxPerRad: visible ? pxPerRad : 120, base: state.rig.bones.find((d) => d.id === b.def.baseId)?.roll ?? 0, rest, pose: structuredClone(state.pose) };
  }
  if (b && (kind === 'len' || kind === 'wid' || kind === 'size')) {
    // measure the grab against the bone's base (length), its centre line (width) or both
    const at = h.position;
    const from = kind === 'len' ? new THREE.Vector3(at.x, 0, 0) : kind === 'wid' ? new THREE.Vector3(0, at.y, 0) : new THREE.Vector3();
    const anchor = toScreen(b.pivot, from);
    const reach = toScreen(b.pivot, at.clone()).sub(anchor);
    const meshX = new Map<THREE.Mesh, number>();
    for (const l of creature.linked(id)) if (l.mesh) meshX.set(l.mesh, l.mesh.scale.x);
    if (reach.lengthSq() > 4) sizer = { anchor, reach, shapes: state.parts[b.src] ? structuredClone(partShapes(state.parts[b.src])) : [], meshX };
    creature.invalidateSkin();
  }
  if (kind === 'root') gapBefore = floorGap();
  drag = { id, kind, plane, offset, startHit: pos, moved: false, rigBase: reshape ? JSON.stringify(state.rig) : undefined, toDef, sizer, roll };
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
    } else if (drag.roll) {
      if (!drag.moved) return;
      const b = creature.bones.get(drag.id);
      if (!b) return;
      const rl = drag.roll;
      const turn = new THREE.Vector2(e.clientX, e.clientY).sub(rl.start).dot(rl.dir) / rl.pxPerRad;
      state.rig = JSON.parse(drag.rigBase!) as RigState;
      const def = state.rig.bones.find((d) => d.id === b.def.baseId);
      if (!def) return;
      // defs describe the left twin; the right one turns the other way (as with the Roll slider)
      let r = rl.base + turn * (b.def.sideSign === -1 ? -1 : 1);
      r = Math.atan2(Math.sin(r), Math.cos(r));
      def.roll = Math.round(r * 1000) / 1000;
      creature.relayout(state.rig);
      keepPoseThroughRoll(rl.rest, rl.pose);
      invalidate();
    } else if (drag.sizer) {
      if (!drag.moved) return;
      const sz = drag.sizer;
      const b = creature.bones.get(drag.id);
      if (!b) return;
      // how far along the grip's own direction the pointer has gone: 1 = where it started
      const k = THREE.MathUtils.clamp(new THREE.Vector2(e.clientX, e.clientY).sub(sz.anchor).dot(sz.reach) / sz.reach.lengthSq(), 0.2, 5);
      const kLen = drag.kind === 'wid' ? 1 : k;
      const kWid = drag.kind === 'len' ? 1 : k;
      state.rig = JSON.parse(drag.rigBase!) as RigState;
      scaleBone(state.rig, drag.id, kLen, kWid);
      const part = state.parts[b.src];
      // (a side drawing's depth goes with the width, so the whole part grows together)
      const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
      if (part && sz.shapes.length) setPartShapes(part, sz.shapes.map((sh) => ({ ...sh, outline: sh.outline.map(([x, y]) => [r4(x * kWid), r4(y * kLen)] as Vec2) })));
      creature.relayout(state.rig);
      // the meshes stretch to fit until they're rebuilt on letting go
      for (const [m, x] of sz.meshX) m.scale.x = x * kWid;
      creature.updateSizer();
      invalidate();
    } else if (drag.rigBase && drag.kind === 'start') {
      if (!drag.moved) return;
      // slide the whole limb: the move in skeleton coordinates (the creature may be turned or posed, the bone may ride a curve)
      const d = hit.clone().sub(drag.startHit);
      if (drag.toDef) d.applyMatrix3(drag.toDef);
      state.rig = JSON.parse(drag.rigBase) as RigState;
      moveJoint(state.rig, drag.id, 'start', d.toArray() as V3, rigLocked());
      creature.relayout(state.rig);
    } else if (drag.id === 'root') {
      creature.group.position.copy(creature.root.worldToLocal(hit).add(drag.offset));
      creature.group.position.y = Math.max(creature.group.position.y, -1);
    } else if (drag.kind === 'end') {
      const chain = creature.dragTip(drag.id, hit, $<HTMLInputElement>('#ik').checked);
      if (rigLocked()) creature.mirrorPose(chain);
    }
    return;
  }
  if (handlesVisible() && e.buttons === 0) {
    const h = pickHandle(e.clientX, e.clientY);
    creature.setHandleHover(h);
    $('#viewport').style.cursor = h ? 'var(--cursor-click)' : '';
  }
});

/** Not every phone browser turns a double tap into a dblclick, so spot it on the way up (and act on it). */
function doubleTapped(e: PointerEvent): boolean {
  if (e.pointerType === 'mouse') return false;
  const now = performance.now();
  if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap.t = 0;
    lastDoubleTap = now;
    onDoubleClick(e.clientX, e.clientY);
    return true;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  return false;
}

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
        settleOnFloor();
        creature.boing(d.id);
        commit();
      }
      selectPart(d.id);
      if (!d.moved) doubleTapped(e);
      return;
    }
    creature.capturePose();
    if (d.moved) {
      // lifting the whole creature up means it's meant to float
      if (d.kind === 'root') {
        if (lifted()) setKeepFloor(false, true);
      } else settleOnFloor();
    }
    commit();
    return;
  }
  if (pointer.moved || e.button !== 0 || gizmo.dragging || drawState) return;
  if (doubleTapped(e)) return;
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
    idle = false;
    activate(other.index);
    if (other.boneId && creature.bones.has(other.boneId)) selected = other.boneId;
    creature.select(selected);
    flashPart();
    save();
    renderUI();
    hint(`Now editing ${creatureLabel(other.index)}`, 1600);
    return;
  }
  const eye = pickEye(e.clientX, e.clientY);
  if (eye !== null) {
    if (idle) {
      idle = false;
      updateSkeletonVisibility();
      renderUI();
    }
    showEyes(eye);
    return;
  }
  if (mode === 'look') {
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
  } else if (mode === 'shape' && !idle) deselectAll();
});

canvas.addEventListener('dblclick', (e) => {
  // a double tap that was already handled on the way up
  if (performance.now() - lastDoubleTap < 600) return;
  onDoubleClick(e.clientX, e.clientY);
});

function onDoubleClick(x: number, y: number) {
  // double-click a roll grip to straighten the part
  if (handlesVisible()) {
    const h = pickHandle(x, y);
    if (h?.userData.kind === 'roll') {
      resetRoll(h.userData.handle as string);
      return;
    }
    if (h?.userData.kind === 'bend') {
      resetBend(h.userData.handle as string);
      return;
    }
  }
  if (mode === 'stuff') {
    const id = drawState ? null : pickPiece(x, y);
    if (id) {
      selectedPiece = id;
      renderStuffPanel();
      enterDraw({ kind: 'piece', redraw: id });
    }
    return;
  }
  const other = pickOtherCreature(x, y);
  if (other) activate(other.index);
  // the first click already went to the eye settings
  else if (pickEye(x, y) !== null) return;
  const id = pickPart(x, y);
  if (!id) return;
  selectPart(id);
  if (mode !== 'shape') setMode('shape');
  enterDraw();
}

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

/** The eye pair under the pointer, if an eye is in front of every part there. */
function pickEye(x: number, y: number): number | null {
  setRay(x, y);
  const part = raycaster.intersectObjects(creature.meshes(), false)[0];
  const eye = creature.pickEye(raycaster.ray);
  return eye && (!part || eye.distance <= part.distance) ? eye.pair : null;
}

/** Opens the Look tab at the eye settings, with this pair picked. */
function showEyes(pair: number) {
  deselectAttachment();
  eyePair = pair;
  if (mode !== 'look') setMode('look');
  renderUI();
  $('#eyes-sec').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Handles are tiny, so pick the nearest one in screen space. */
function pickHandle(x: number, y: number): THREE.Object3D | null {
  const r = canvas.getBoundingClientRect();
  let best: THREE.Object3D | null = null;
  // fingers are less exact than a mouse
  let bestD = pointer.touch ? 28 : 16;
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
  // Arrange has its own handles at the creature's feet
  return !idle && !drawState && !placing && mode === 'shape';
}

/** Back to nothing picked: clicking empty space in Shape. */
function deselectAll() {
  idle = true;
  stopPlacing();
  deselectAttachment();
  creature.flash(null, 0);
  updateSkeletonVisibility();
  renderUI();
}

/** The sidebar's part editor and the on-screen Arrange/Mirror pills only make sense with something picked. */
function syncIdle() {
  $('.panel').classList.toggle('idle', idle && mode !== 'stuff');
  $('#shape-bar').classList.toggle('idle', idle);
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
    if (state.keepFloor === false) {
      setKeepFloor(true);
      commit();
    }
    hint('Already on the floor', 1500);
    return;
  }
  // the creature may be turned or resized: the drop is straight down in the scene
  const down = creature.root.worldToLocal(new THREE.Vector3(0, -box.min.y, 0)).sub(creature.root.worldToLocal(new THREE.Vector3()));
  creature.group.position.add(down);
  creature.capturePose();
  setKeepFloor(true);
  commit();
  hint('Dropped to the floor', 1500);
}

/** Face the part straight on: from the front, or from the side when it's being drawn from the side. */
function focusOnBone(b: BoneRT, side = false) {
  b.pivot.updateMatrixWorld(true);
  const geo = b.mesh?.userData.baseGeo as THREE.BufferGeometry | undefined;
  if (geo && !geo.boundingBox) geo.computeBoundingBox();
  const box = geo?.boundingBox ?? new THREE.Box3(new THREE.Vector3(-0.1, 0, -0.1), new THREE.Vector3(0.1, b.length, 0.1));
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  // the middle of the drawing plane, not of the whole part
  if (side) centre.x = 0;
  else centre.z = 0;
  const center = b.pivot.localToWorld(centre);
  const r = Math.max(side ? size.z : size.x, size.y, b.length) / 2;
  const normal = new THREE.Vector3(side ? 1 : 0, 0, side ? 0 : 1).transformDirection(b.pivot.matrixWorld);
  const toCam = camera.position.clone().sub(controls.target).normalize();
  if (normal.dot(toCam) < 0) normal.negate();
  if (Math.abs(normal.y) > 0.97) normal.add(new THREE.Vector3(0, 0, 0.1)).normalize(); // dodge orbit pole
  const dist = (r * 2.2 + 0.3) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  flyTo(center.clone().addScaledVector(normal, dist), center);
}

// ---------------------------------------------------------------------------
// drawing

/** What a stroke is for: a body part's outline, or a piece on the stuff workbench (new, or one being redrawn). */
type DrawTarget = { kind: 'bone'; boneId: string } | { kind: 'piece'; redraw?: string };
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
  /** a bone's shapes from before drawing: the shapes preview live on the part, and these go back on cancel */
  original?: PartShape[];
  /** a body part being drawn from the side (its YZ plane) rather than the front */
  side: boolean;
  /** a body part's shapes in the other view (front or side), kept while this one is drawn */
  other: Vec2[][];
  /** a body part: what its two views show of the creature (its own plane, then the one turned a quarter round) */
  views?: [BoneView, BoneView];
  /** symmetry in the turned view (on when that view looks the creature in the face) */
  sideSym: boolean;
}

type ViewKind = 'front' | 'side' | 'top';
interface BoneView {
  kind: ViewKind;
  /** left and right on the drawing are the creature's left and right */
  mirrored: boolean;
}
const VIEW_NAMES: Record<ViewKind, { name: string; icon: string }> = {
  front: { name: 'Front', icon: 'fa-regular fa-user' },
  side: { name: 'Side', icon: 'fa-regular fa-person-walking' },
  top: { name: 'Top', icon: 'fa-regular fa-arrow-down-to-line' },
};

/**
 * What a body part's two drawing planes show of the creature. The part's own
 * plane depends on how its bone lies (a quadruped's body is drawn as its
 * profile), so each view is named by the way it looks at the creature in its
 * rest pose: from the front, the side or the top.
 */
function boneViews(b: BoneRT): [BoneView, BoneView] {
  const rot = new THREE.Matrix3().setFromMatrix4(b.restGroup);
  // how well a view looking along `normal` counts as each kind (a slight lean towards front, then side)
  const scores = (normal: THREE.Vector3): Record<ViewKind, number> => {
    const n = normal.applyMatrix3(rot).normalize();
    return { front: Math.abs(n.z) * 1.15, side: Math.abs(n.x), top: Math.abs(n.y) * 0.85 };
  };
  const best = (s: Record<ViewKind, number>, not?: ViewKind) =>
    (Object.keys(s) as ViewKind[]).filter((k) => k !== not).sort((a, c) => s[c] - s[a])[0];
  const across = (v: THREE.Vector3) => Math.abs(v.applyMatrix3(rot).normalize().x) > 0.7;
  const own = best(scores(new THREE.Vector3(0, 0, 1)));
  // the two views are a quarter turn apart: never call them the same thing
  const turned = best(scores(new THREE.Vector3(1, 0, 0)), own);
  return [
    { kind: own, mirrored: across(new THREE.Vector3(1, 0, 0)) },
    { kind: turned, mirrored: across(new THREE.Vector3(0, 0, 1)) },
  ];
}
let drawState: DrawState | null = null;

const DRAW_PREFS_KEY = 'creature-creator/draw';
// symmetry is remembered separately for body parts and for stuff (letters,
// badges... are rarely symmetric, so stuff starts with it off)
const drawPrefs: { symmetry: boolean; pieceSymmetry: boolean; smoothing: number } = (() => {
  try {
    return { symmetry: true, pieceSymmetry: false, smoothing: 0.5, ...JSON.parse(localStorage.getItem(DRAW_PREFS_KEY) ?? '{}') };
  } catch {
    return { symmetry: true, pieceSymmetry: false, smoothing: 0.5 };
  }
})();
/** Is symmetry on for what's being drawn right now? */
function symOn(): boolean {
  // the turned view keeps its own setting for this drawing
  if (drawState?.side) return drawState.sideSym;
  return drawState?.target.kind === 'piece' ? drawPrefs.pieceSymmetry : drawPrefs.symmetry;
}
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
    const done = touchScreen() ? 'Done' : 'Done (Enter)';
    const msg = {
      draw: target.kind === 'bone' ? `Draw more to add to it (apart = an extra shape). Press ${done} to keep it` : `Draw more to add to the shape. Press ${done} to keep it`,
      erase: `Draw over the parts to cut away. Press ${done} to keep it`,
      move: `Drag the shape to move it. Press ${done} to keep it`,
      scale: touchScreen() ? 'Drag away from the middle to make it bigger' : 'Drag away from the middle to make it bigger (Shift keeps its proportions)',
      rotate: 'Drag around the middle to turn the shape',
    }[drawState.tool];
    hint(msg, 0);
    return;
  }
  // how to look around while the drawing layer is in the way
  const nav = touchScreen() ? ' · Two fingers move the view' : ' · Right-drag or Space+drag to pan, F to face it again';
  if (target.kind === 'piece') {
    hint((symOn() ? 'Draw a piece: across the dashed line = one symmetric shape, to one side = a mirrored pair' : 'Draw a piece as one closed loop. Erase inside it to make holes') + nav, 0);
    return;
  }
  if (drawState.side) {
    const from = VIEW_NAMES[drawState.views?.[1].kind ?? 'side'].name.toLowerCase();
    hint((symOn() ? `Draw one half of the ${label} as seen from the ${from}; it mirrors across the dashed line` : `Draw the ${label} as seen from the ${from}`) + nav, 0);
    return;
  }
  hint((symOn() ? `Draw one half of the ${label}; it mirrors across the dashed line` : `Draw the ${label} as one closed loop`) + nav, 0);

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
    // start from the shapes as they are (draw to add, erase to cut), in the view the part was first drawn in
    const shapes = partShapes(state.parts[b.src]);
    const side = !!shapes[0]?.side;
    const views = boneViews(b);
    const inView = shapes.filter((s) => !!s.side === side).map((s) => structuredClone(s.outline));
    drawState = {
      target,
      frame: boneFrame(b, side),
      label: partLabel(b.src).toLowerCase(),
      axis: [[0, b.length / 2 - reach], [0, b.length / 2 + reach]],
      pts: [],
      local: [],
      pen: null,
      active: false,
      pending: inView.length ? inView : null,
      holes: [],
      tool: 'draw',
      grab: null,
      stamp: null,
      stampDrag: null,
      original: structuredClone(shapes),
      side,
      other: shapes.filter((s) => !!s.side !== side).map((s) => structuredClone(s.outline)),
      views,
      // symmetric when it looks the creature in the face, not when it's a profile
      sideSym: views[1].mirrored,
    };
    creature.setDrawFocus(target.boneId, side);
    // other creatures step aside while you draw on this one
    for (const c of creatures) if (c !== creature) c.root.visible = false;
    focusOnBone(b, side);
  } else {
    // a piece lifted off the board is redrawn on its own plane
    const own = target.redraw ? piece() : undefined;
    const lifted = own?.place;
    const frame = lifted ? framePiece(own!) : board;
    drawState = { target, frame, label: 'piece', axis: [[0, -1.3], [0, 1.3]], pts: [], local: [], pen: null, active: false, pending: null, holes: [], tool: 'draw', grab: null, stamp: null, stampDrag: null, side: false, other: [], sideSym: false };
    if (target.redraw && own) {
      // start from the shape as it is: draw to add, erase to cut, or move, size and turn it
      drawState.pending = [structuredClone(own.outline)];
      drawState.holes = structuredClone(own.holes);
    }
    // pieces are drawn flat: show the thing unbent meanwhile
    syncWorkbench();
    if (lifted) focusOnPlane(frame);
    else focusOnBoard();
  }
  overlay.classList.add('active');
  $('#draw-bar').hidden = false;
  syncDrawBar();
  updateSkeletonVisibility();
  drawHint();
  refreshPieceGizmo();
}

/** Drawing from the side: a plane standing in the bone's YZ plane (its X axis is the bone's -Z, its Z the bone's X). */
const sideFrame = new THREE.Object3D();
sideFrame.rotation.y = Math.PI / 2;

/** The object whose XY plane a body part is drawn on, from the front or the side. */
function boneFrame(b: BoneRT, side: boolean): THREE.Object3D {
  if (!side) {
    sideFrame.removeFromParent();
    return b.pivot;
  }
  b.pivot.add(sideFrame);
  sideFrame.updateMatrixWorld(true);
  return sideFrame;
}

/** Switch a body part's drawing between front and side; the shapes drawn in the other view stay put. */
function setDrawSide(side: boolean) {
  const ds = drawState;
  if (!ds || ds.target.kind !== 'bone' || ds.side === side) return;
  const b = creature.bones.get(ds.target.boneId);
  if (!b) return;
  const here = ds.pending ?? [];
  ds.pending = ds.other.length ? ds.other : null;
  ds.other = here;
  ds.holes = [];
  ds.side = side;
  ds.frame = boneFrame(b, side);
  ds.active = false;
  ds.pts = [];
  ds.local = [];
  ds.grab = null;
  ds.stampDrag = null;
  if (!ds.pending) ds.tool = 'draw';
  creature.setDrawFocus(b.def.id, side);
  focusOnBone(b, side);
  previewPending();
  drawHint();
}

/** Leave drawing. Unless the shape is being kept (Done), a bone's previewed outline goes back. */
function exitDraw(keep = false) {
  const ds = drawState;
  drawState = null;
  overlay.classList.remove('active');
  $('#draw-bar').hidden = true;
  if (ds?.target.kind === 'bone' && !keep) {
    const b = creature.bones.get(ds.target.boneId);
    if (b) setPartShapes(state.parts[b.src], ds.original ?? []);
    creature.sync();
  }
  sideFrame.removeFromParent();
  creature.setDrawFocus(null);
  if (ds?.target.kind === 'piece') syncWorkbench();
  for (const c of creatures) c.root.visible = mode !== 'stuff';
  updateSkeletonVisibility();
  octx.clearRect(0, 0, overlay.width, overlay.height);
  hint('');
}

function syncDrawBar() {
  $<HTMLInputElement>('#sym').checked = symOn();
  $<HTMLInputElement>('#smooth').value = String(drawPrefs.smoothing);
  $('#sym-label').classList.toggle('on', symOn());
  const isBone = drawState?.target.kind === 'bone';
  $('#draw-view').hidden = !isBone;
  document.querySelectorAll<HTMLButtonElement>('#draw-view [data-view]').forEach((b) => {
    const turned = b.dataset.view === 'side';
    b.classList.toggle('on', turned === !!drawState?.side);
    // named by what it shows of the creature: a quadruped's own plane is its side
    const v = VIEW_NAMES[drawState?.views?.[turned ? 1 : 0].kind ?? (turned ? 'side' : 'front')];
    b.innerHTML = `<i class="${v.icon}" aria-hidden="true"></i> ${v.name}${turned ? ' <kbd>V</kbd>' : ''}`;
    b.title = `Draw the part as seen from the ${v.name.toLowerCase()}${turned ? ' (V)' : ''}`;
  });
  const has = !!drawState?.pending;
  // a body part can be kept (or cleared) with shapes in the other view only
  const any = has || !!drawState?.other.length;
  $<HTMLButtonElement>('#done-draw').disabled = !any;
  $<HTMLButtonElement>('#reset-draw').disabled = !any;
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
  // the turned view's setting lasts for this drawing (it starts from which way the view faces)
  if (drawState?.side) drawState.sideSym = !drawState.sideSym;
  else if (drawState?.target.kind === 'piece') drawPrefs.pieceSymmetry = !drawPrefs.pieceSymmetry;
  else drawPrefs.symmetry = !drawPrefs.symmetry;
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
    if (symOn()) local = symmetrize(local);
    local = smoothLoop(local, drawPrefs.smoothing);
  }
  return [local];
}

/** A workbench stroke: across the centre line = one symmetric piece, off to one side = a mirrored pair. */
function pieceLoops(raw: Vec2[]): Vec2[][] {
  let loops: Vec2[][] = [raw];
  if (raw.length >= 6 && symOn()) {
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
  // (a part that already has shapes in the other view is added to, not started afresh from a half)
  if (ds.pending || ds.other.length) {
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
  if (symOn() && Math.abs(cx) < sd.r * 0.3) cx = 0;
  const loop = shapeLoop(ds.stamp, cx, cy, sd.r);
  return symOn() && cx !== 0 ? [loop, mirrorLoop(loop)] : [loop];
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
  applyLoops(ds, symOn() ? [loop, mirrorLoop(loop)] : [loop], ds.tool === 'erase');
}

const mirrorLoop = (l: Vec2[]) => l.map(([x, y]) => [-x, y] as Vec2).reverse();

/** Add loops to the shape (or cut them out of it); the first ones simply become the shape. */
function applyLoops(ds: DrawState, loops: Vec2[][], cut: boolean) {
  if (!ds.pending) {
    if (cut) return;
    // overlapping mirror images merge into one
    setPending(loops.length > 1 ? combineLoops([], [], loops, false).outers : loops);
    return;
  }
  const res = combineLoops(ds.pending, ds.holes, loops, cut);
  if (!res.outers.length) {
    setPending(null);
    hint('Erased it all: draw a new shape', 2000);
    return;
  }
  // a body part can be several shapes, but each one is solid
  if (ds.target.kind === 'bone' && res.holes.length) hint("A body part can't have holes: draw it as separate shapes instead", 2400);
  ds.pending = res.outers;
  ds.holes = ds.target.kind === 'bone' ? [] : res.holes;
  previewPending();
  drawHint();
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
  ds.holes = ds.target.kind === 'piece' ? res.holes : [];
  previewPending();
}

function pendingShape(ds: DrawState): { outers: Vec2[][]; holes: Vec2[][] } {
  return { outers: ds.pending ?? [], holes: ds.holes };
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
    if (!symOn()) return 1;
    const bb = bounds(l);
    return bb.minX < -1e-3 && bb.maxX > 1e-3 ? 0 : (bb.minX + bb.maxX) / 2 >= 0 ? 1 : -1;
  };
  const grabSide = symOn() && g.start[0] < 0 ? -1 : 1;
  let fn: (l: Vec2[]) => Vec2[];
  if (ds.tool === 'move') {
    const dx = p[0] - g.start[0], dy = p[1] - g.start[1];
    fn = (l) => {
      const sd = side(l);
      const mx = symOn() ? dx * sd * grabSide : dx;
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
      if (symOn() && sd !== 0) {
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

/** A body part's shapes as drawn so far, front and side (the front ones first). */
function drawnShapes(ds: DrawState): PartShape[] {
  const here = (ds.pending ?? []).map((outline) => ({ outline, side: ds.side }));
  const there = ds.other.map((outline) => ({ outline, side: !ds.side }));
  return ds.side ? [...there, ...here] : [...here, ...there];
}

/** Show the pending shape: inflated live on the part being drawn, or on the workbench. */
function previewPending() {
  const ds = drawState;
  if (!ds) return;
  if (ds.target.kind === 'bone') {
    const b = creature.bones.get(ds.target.boneId);
    if (b) {
      setPartShapes(state.parts[b.src], drawnShapes(ds));
      creature.sync();
      // the rebuilt part keeps the see-through drawing look
      creature.setDrawFocus(ds.target.boneId, ds.side);
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
  if (!ds?.pending && !ds?.other.length) return;
  if (ds.target.kind === 'piece' && ds.target.redraw) {
    replacePiece(ds.target.redraw, pendingPieces(ds));
    return;
  }
  if (ds.target.kind === 'piece') {
    addPieces(pendingPieces(ds));
    return;
  }
  const b = creature.bones.get(ds.target.boneId)!;
  setPartShapes(state.parts[b.src], drawnShapes(ds));
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
    const centre: Vec2 = [symOn() ? 0 : (bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
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
// While drawing, the right (or middle) button still moves the view: the
// press is handed to the camera controls under the drawing layer, which then
// follow the pointer until it's let go.
overlay.addEventListener('pointerdown', (e) => {
  if (!drawState || e.button === 0) return;
  canvas.dispatchEvent(new PointerEvent('pointerdown', e));
});
overlay.addEventListener('contextmenu', (e) => e.preventDefault());

// On a touch screen a second finger means "move the view": whatever the first
// finger had started is dropped and both touches go to the camera controls,
// which follow them (on the document) until they're lifted.
const drawTouches = new Map<number, PointerEvent>();
let touchView = false;
overlay.addEventListener('pointerdown', (e) => {
  if (!drawState || e.pointerType !== 'touch') return;
  drawTouches.set(e.pointerId, e);
  if (!touchView && drawTouches.size < 2) return;
  e.stopImmediatePropagation();
  if (!touchView) {
    touchView = true;
    const ds = drawState;
    ds.active = false;
    ds.pts = [];
    ds.local = [];
    ds.stampDrag = null;
    if (ds.grab) {
      ds.pending = ds.grab.outers;
      ds.holes = ds.grab.holes;
      ds.grab = null;
      schedulePreview();
    }
    renderOverlay();
    for (const t of drawTouches.values()) canvas.dispatchEvent(new PointerEvent('pointerdown', t));
  } else canvas.dispatchEvent(new PointerEvent('pointerdown', e));
}, { capture: true });
overlay.addEventListener('pointermove', (e) => {
  if (drawTouches.has(e.pointerId)) drawTouches.set(e.pointerId, e);
}, { capture: true });
for (const type of ['pointerup', 'pointercancel'] as const) {
  window.addEventListener(type, (e) => {
    drawTouches.delete(e.pointerId);
    if (!drawTouches.size) touchView = false;
  });
}

// Hold Space to pan with the left button too (the drawing layer steps aside meanwhile).
let spacePan = false;
function setSpacePan(on: boolean) {
  if (spacePan === on) return;
  spacePan = on;
  overlay.style.pointerEvents = on ? 'none' : '';
  controls.mouseButtons.LEFT = on ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  viewport.classList.toggle('space-pan', on);
}
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') setSpacePan(false);
});
window.addEventListener('blur', () => setSpacePan(false));

function renderOverlay() {
  const dpr = overlay.width / overlay.clientWidth || 1;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
  if (!drawState) return;
  const frame = drawState.frame;
  octx.lineJoin = octx.lineCap = 'round';

  if (symOn()) {
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

  if (symOn() && drawState.local.length > 1) {
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
  octx.fillStyle = symOn() ? 'transparent' : inkSoft + '.12)';
  octx.strokeStyle = ink;
  octx.lineWidth = 4;
  if (erasing) octx.setLineDash([8, 6]);
  octx.beginPath();
  pts.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
  if (!symOn()) octx.fill();
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
$('#reset-draw').onclick = () => {
  // a body part starts again from nothing, front and side
  if (drawState) drawState.other = [];
  setPending(null);
};
document.querySelectorAll<HTMLButtonElement>('#draw-view [data-view]').forEach((b) => {
  b.onclick = () => setDrawSide(b.dataset.view === 'side');
});
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
  // opaque lines (pre-faded colors) so glass pieces show the grid through them;
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
  const redraw = ds.target.redraw;
  if (redraw) {
    shown.pieces = wb.pieces.flatMap((p) =>
      p.id !== redraw ? [p] : pendingPieces(ds).map((pp, i) => ({ ...p, outline: pp.outline, holes: pp.holes, id: i ? `preview${i}` : p.id })),
    );
    return shown;
  }
  if (!ds.pending) return shown;
  const target = piece();
  shown.pieces = [...wb.pieces, ...pendingPieces(ds).map((pp, i) => ({ ...newPiece(pp.outline, target), holes: pp.holes, id: `preview${i}` }))];
  return shown;
}

/** On the workbench, a thing that inherits its material shows the creature's. */
function benchWearer(): Wearer {
  return { style: state.style, settingsFor: (s) => creature.settingsFor(s) };
}

function syncWorkbench() {
  const thing = benchThing();
  const key = JSON.stringify([thing.pieces, thing.ownMaterial, thing.inherit, thing.materialSettings, thing.bend, thing.bendMode, state.materialSettings, state.style, getMeshDetail()]);
  if (key === benchKey) {
    refreshPieceGizmo();
    return;
  }
  piecePivot = null;
  benchKey = key;
  if (bench) {
    board.remove(bench);
    disposeThing(bench);
  }
  bench = buildThing(thing, benchWearer());
  board.add(bench);
  refreshPieceGizmo();
}

// ---- moving, turning and resizing a piece after it's drawn ----
// The selected piece is wrapped in a pivot at its middle (inside a holder
// that carries its 3D placement), so it turns and grows about itself.
// 2D keeps it flat on its own plane and bakes the change into its outline;
// 3D lifts and tilts the plane itself, leaving the drawing as it is.

type PieceMode = 'translate' | 'rotate' | 'scale';
let pieceMode: PieceMode = 'translate';
let pieceDim: '2d' | '3d' = '2d';
let piecePivot: THREE.Group | null = null;

function refreshPieceGizmo() {
  const p = piece();
  const on = mode === 'stuff' && !drawState && !!p && !!bench;
  $('#piece-bar').hidden = !on;
  if (!on) {
    if (piecePivot && gizmo.object === piecePivot) gizmo.detach();
    piecePivot = null;
    return;
  }
  // still wrapped round this piece's current mesh: nothing to do
  if (piecePivot && piecePivot.parent?.parent === bench && piecePivot.userData.pieceId === p.id && gizmo.object === piecePivot) {
    setPieceMode(pieceMode);
    return;
  }
  const mesh = bench!.children.find((m) => m.userData.pieceId === p.id);
  if (!mesh) return;
  const b = bounds(p.outline);
  const c = new THREE.Vector2((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
  // holder = the piece's plane in the thing; pivot = its middle on that plane
  const holder = new THREE.Group();
  holder.position.copy(mesh.position);
  holder.quaternion.copy(mesh.quaternion);
  const pivot = new THREE.Group();
  pivot.userData.pieceId = p.id;
  pivot.userData.center = c;
  pivot.position.set(c.x, c.y, 0);
  bench!.add(holder);
  holder.add(pivot);
  pivot.add(mesh);
  mesh.position.set(-c.x, -c.y, 0);
  mesh.quaternion.identity();
  piecePivot = pivot;
  gizmo.attach(pivot);
  setPieceMode(pieceMode);
  $('#piece-name').textContent = `Piece ${workbench().pieces.indexOf(p) + 1}`;
}

function setPieceMode(m: PieceMode) {
  const p = piece();
  // flat, a turned piece is spun round the centre line: it can only slide up and down, or grow
  const turned2d = p?.kind === 'turned' && pieceDim === '2d';
  if (turned2d && m === 'rotate') m = 'translate';
  pieceMode = m;
  gizmo.setMode(m);
  gizmo.setSpace('local');
  if (pieceDim === '3d' && m !== 'scale') {
    gizmo.showX = gizmo.showY = gizmo.showZ = true;
  } else {
    // everything happens in the piece's own plane (resizing always does)
    gizmo.showX = m === 'scale' || (m === 'translate' && !turned2d);
    gizmo.showY = m !== 'rotate';
    gizmo.showZ = m === 'rotate';
  }
  document.querySelectorAll<HTMLButtonElement>('#piece-bar [data-piece]').forEach((b) => {
    b.classList.toggle('on', b.dataset.piece === m);
    if (b.dataset.piece === 'rotate') b.disabled = turned2d;
  });
  document.querySelectorAll<HTMLButtonElement>('#piece-bar [data-dim]').forEach((b) => b.classList.toggle('on', b.dataset.dim === pieceDim));
  $('#piece-flat').hidden = !p?.place;
  invalidate();
}

function setPieceDim(d: '2d' | '3d') {
  pieceDim = d;
  setPieceMode(pieceMode);
  if (d === '3d') hint('3D: lift pieces off the board and tilt them any way', 2200);
}

/** Make the gizmo's change permanent. */
function bakePiece() {
  const p = piece();
  const pivot = piecePivot;
  const holder = pivot?.parent;
  if (!p || !pivot || !holder || pivot.userData.pieceId !== p.id) return;
  pivot.updateMatrix();
  holder.updateMatrix();
  const c = pivot.userData.center as THREE.Vector2;
  if (pivot.matrix.equals(new THREE.Matrix4().makeTranslation(c.x, c.y, 0))) return;
  const r = (n: number, k = 1e4) => Math.round(n * k) / k;
  if (pieceDim === '3d' && pieceMode !== 'scale') {
    // 3D: move the piece's plane; its drawing stays as drawn
    const m = holder.matrix.clone().multiply(pivot.matrix).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, 0));
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    m.decompose(pos, q, new THREE.Vector3());
    const flat = pos.lengthSq() < 1e-8 && Math.abs(q.w) > 1 - 1e-9;
    if (flat) delete p.place;
    else p.place = { position: pos.toArray().map((v) => r(v)) as [number, number, number], quaternion: q.toArray().map((v) => r(v, 1e6)) as [number, number, number, number] };
  } else {
    // 2D (and resizing): run the outline and holes through the move, on the piece's own plane
    const v = new THREE.Vector3();
    const move = ([x, y]: Vec2): Vec2 => {
      v.set(x - c.x, y - c.y, 0).applyMatrix4(pivot.matrix);
      return [r(v.x), r(v.y)];
    };
    // a flip (negative size) turns the outline inside out: keep its direction
    const flip = pivot.scale.x * pivot.scale.y < 0;
    const fix = (l: Vec2[]) => (flip ? l.map(move).reverse() : l.map(move));
    p.outline = fix(p.outline);
    p.holes = p.holes.map(fix);
  }
  // rebuilt from the new shape; the gizmo wraps the new mesh
  piecePivot = null;
  syncWorkbench();
  commit();
  autosaveThing();
}

/** Put a lifted piece back down flat on the board. */
function layPieceFlat() {
  const p = piece();
  if (!p?.place) return;
  delete p.place;
  piecePivot = null;
  syncWorkbench();
  commit();
  autosaveThing();
  hint('Back flat on the board', 1500);
}

/** A tilted piece's own plane in the scene, for cutting holes into it. */
const pieceFrame = new THREE.Group();
board.add(pieceFrame);
function framePiece(p: Piece): THREE.Object3D {
  if (!p.place) return board;
  pieceFrame.position.set(...p.place.position);
  pieceFrame.quaternion.set(...p.place.quaternion);
  pieceFrame.updateMatrixWorld(true);
  return pieceFrame;
}

document.querySelectorAll<HTMLButtonElement>('#piece-bar [data-piece]').forEach((b) => {
  b.onclick = () => setPieceMode(b.dataset.piece as PieceMode);
});
document.querySelectorAll<HTMLButtonElement>('#piece-bar [data-dim]').forEach((b) => {
  b.onclick = () => setPieceDim(b.dataset.dim as '2d' | '3d');
});
$('#piece-flat').onclick = () => layPieceFlat();


// ---- auto-save: the thing on the workbench is kept in My stuff as you go ----

let thingSaveTimer = 0;
function autosaveThing() {
  if (!world.workbench?.pieces.length) return;
  clearTimeout(thingSaveTimer);
  thingSaveTimer = window.setTimeout(saveWorkbenchNow, 450);
}

/** Put the workbench thing in the collection now (with a fresh picture), and update anything wearing it. */
function saveWorkbenchNow() {
  clearTimeout(thingSaveTimer);
  const wb = world.workbench;
  if (!wb?.pieces.length) return;
  // a shape waiting for Done would end up in the picture: wait for it
  if (drawState) {
    autosaveThing();
    return;
  }
  const saved: Thing = { ...structuredClone(wb), name: wb.name.trim() || 'Thing' };
  saved.thumb = mode === 'stuff' ? captureThumb() : collection().find((t) => t.id === wb.id)?.thumb;
  const ok = putThing(saved);
  const badge = $('#thing-saved');
  if (ok) iconLabel(badge, fa('check'), 'Saved');
  else badge.textContent = 'Storage full: download it to keep it';
  badge.classList.toggle('warn', !ok);
  if (!ok) return;
  // creatures already wearing it get the new shape; how its material looks
  // stays each wearer's own choice
  world.creatures.forEach((s, i) => {
    let changed = false;
    for (const a of s.attachments ?? []) {
      if (a.thing.id !== wb.id) continue;
      const { inherit, ownMaterial, materialSettings, scaleMaterial } = a.thing;
      a.thing = { ...stripThumb(saved), inherit, ownMaterial, materialSettings, scaleMaterial };
      changed = true;
    }
    if (changed) creatures[i]?.sync();
  });
  save();
  renderCollection();
}

/** Put a thing on the workbench (saving the one that was there first). */
function openOnBench(t: Thing) {
  saveWorkbenchNow();
  world.workbench = stripThumb(t);
  selectedPiece = '';
  $('#thing-saved').textContent = '';
  syncWorkbench();
  commit();
  renderStuffPanel();
  focusOnBoard();
}

/** Look straight at a drawing plane (a tilted piece's), from the side it faces. */
function focusOnPlane(frame: THREE.Object3D) {
  const c = frame.getWorldPosition(new THREE.Vector3());
  const n = new THREE.Vector3(0, 0, 1).transformDirection(frame.matrixWorld);
  // face it from whichever side the camera is already on
  if (n.dot(camera.position.clone().sub(c)) < 0) n.negate();
  flyTo(c.clone().addScaledVector(n, 1.4), c);
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

/** Done on the workbench: add the drawn pieces, with any holes erased in them. */
function addPieces(shapes: { outline: Vec2[]; holes: Vec2[][] }[]) {
  const wb = workbench();
  const made = shapes.map((sh) => ({ ...newPiece(sh.outline, piece()), holes: sh.holes }));
  wb.pieces.push(...made);
  selectedPiece = made[0].id;
  exitDraw(true);
  syncWorkbench();
  commit();
  renderStuffPanel();
  flashPart();
}

/** Done redrawing a piece: it keeps its color, material, kind and place, with the new outline. */
function replacePiece(id: string, shapes: { outline: Vec2[]; holes: Vec2[][] }[]) {
  const wb = workbench();
  const i = wb.pieces.findIndex((p) => p.id === id);
  if (i < 0 || !shapes.length) {
    exitDraw();
    return;
  }
  const old = wb.pieces[i];
  const next = shapes.map((sh, k) => ({ ...structuredClone(old), outline: sh.outline, holes: sh.holes, id: k ? uid() : old.id }));
  wb.pieces.splice(i, 1, ...next);
  selectedPiece = old.id;
  exitDraw(true);
  syncWorkbench();
  commit();
  renderStuffPanel();
  flashPart();
  if (next.length > 1) hint(`Redrawn as ${next.length} pieces`, 1800);
}

function pickPiece(x: number, y: number): string | null {
  if (!bench) return null;
  setRay(x, y);
  // fuzz and ink sit inside a piece's mesh, and the selected piece sits in a pivot
  for (const hit of raycaster.intersectObjects(bench.children, true)) {
    for (let o: THREE.Object3D | null = hit.object; o && o !== bench; o = o.parent) if (o.userData.pieceId) return o.userData.pieceId as string;
  }
  return null;
}

/** Glow the selected piece (k fades 1 -> 0). */
function flashPiece(k: number) {
  bench?.traverse((m) => {
    if (!m.userData.pieceId || !(m as THREE.Mesh).isMesh) return;
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
  // pictured from wherever the camera is: crop a square round the thing as it's seen now
  camera.updateMatrixWorld();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < 8; k++) {
    const v = new THREE.Vector3(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).project(camera);
    const px = ((v.x + 1) / 2) * canvas.width;
    const py = ((1 - v.y) / 2) * canvas.height;
    x0 = Math.min(x0, px);
    x1 = Math.max(x1, px);
    y0 = Math.min(y0, py);
    y1 = Math.max(y1, py);
  }
  const side = Math.min(Math.max(x1 - x0, y1 - y0) * 1.15, canvas.width, canvas.height);
  const sx = THREE.MathUtils.clamp((x0 + x1) / 2 - side / 2, 0, canvas.width - side);
  const sy = THREE.MathUtils.clamp((y0 + y1) / 2 - side / 2, 0, canvas.height - side);
  boardGrid.visible = false;
  const url = withCleanScene(() => {
    composer.render();
    const size = 160;
    const out = document.createElement('canvas');
    out.width = out.height = size;
    out.getContext('2d')!.drawImage(canvas, sx, sy, side, side, 0, 0, size, size);
    return out.toDataURL('image/jpeg', 0.82);
  });
  boardGrid.visible = true;
  // put the grid and handles straight back on screen
  invalidate();
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
  // one row per piece: pick it, redraw it, or throw it away
  wb.pieces.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'piece-row';
    row.classList.toggle('active', p.id === selectedPiece);
    const pick = document.createElement('button');
    pick.className = 'piece-pick';
    pick.innerHTML = `<i style="background:${p.color}"></i>`;
    pick.insertAdjacentHTML('beforeend', p.kind === 'flat' ? fa('rectangle-wide') : p.kind === 'turned' ? faClassic('jar') : fa('cloud'));
    pick.append(` Piece ${i + 1}${p.holes.length ? ` (${p.holes.length} hole${p.holes.length > 1 ? 's' : ''})` : ''}`);
    pick.onclick = () => {
      selectedPiece = p.id;
      flashPart();
      renderStuffPanel();
    };
    const edit = document.createElement('button');
    edit.className = 'piece-icon';
    edit.innerHTML = fa('pencil');
    edit.title = 'Redraw this piece: add to it, erase bits (erase inside it for a hole), or move, size and turn it. Or double-click it';
    edit.onclick = () => {
      selectedPiece = p.id;
      renderStuffPanel();
      enterDraw({ kind: 'piece', redraw: p.id });
    };
    const del = document.createElement('button');
    del.className = 'piece-icon';
    del.innerHTML = fa('xmark');
    del.title = 'Delete this piece';
    del.onclick = () => deletePiece(p.id);
    row.append(pick, edit, del);
    list.append(row);
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
    // an item that inherits its material shows the wearer's instead
    st.hidden = !!wb.inherit;
    for (const s of STYLES) {
      const b = document.createElement('button');
      b.innerHTML = `<span class="ball ${s.id}"></span>`;
      b.append(s.name);
      b.classList.toggle('active', s.id === p.style);
      b.onclick = () => updatePiece((q) => (q.style = s.id));
      st.append(b);
    }
    renderThingMaterial(wb, [p.style], $('#piece-style-params'), state.style);
  }
  renderCollection();
  refreshPieceGizmo();
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
  const current = world.workbench?.id;
  for (const [sel, forAttach] of [['#thing-list', false], ['#attach-options', true]] as const) {
    const el = $(sel);
    el.innerHTML = '';
    const things = collection();
    if (forAttach && !things.length) {
      el.innerHTML = `<p class="muted small">Nothing here yet. Make something in the ${fa('box')} Stuff tab first.</p>`;
      continue;
    }
    const card = (name: string, thumb: string | undefined, onclick: () => void) => {
      const c = document.createElement('div');
      c.className = 'thing-card pick';
      const img = document.createElement(thumb ? 'img' : 'div');
      img.className = 'thumb';
      if (thumb) (img as HTMLImageElement).src = thumb;
      const label = document.createElement('span');
      label.className = 'thing-name';
      label.textContent = name;
      c.title = name;
      c.append(img, label);
      c.onclick = onclick;
      el.append(c);
      return c;
    };
    if (!forAttach) {
      // start something new (an empty workbench already is something new)
      const fresh = card('New', undefined, () => {
        if (world.workbench?.pieces.length) openOnBench(newThing());
      });
      fresh.classList.add('new-card');
      fresh.querySelector('.thumb')!.innerHTML = faClassic('plus');
      fresh.classList.toggle('current', !things.some((t) => t.id === current));
    }
    for (const t of things) {
      const c = card(t.name, t.thumb, () => {
        if (forAttach) attachThing(t);
        else if (t.id !== current) openOnBench(t);
      });
      if (!forAttach) c.classList.toggle('current', t.id === current);
    }
  }
}

$('#piece-draw').onclick = () => enterDraw({ kind: 'piece' });
function deletePiece(id: string) {
  if (drawState) exitDraw();
  const wb = workbench();
  wb.pieces = wb.pieces.filter((p) => p.id !== id);
  if (selectedPiece === id) selectedPiece = '';
  syncWorkbench();
  commit();
  renderStuffPanel();
  autosaveThing();
}
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
$('#thing-dup').onclick = () => {
  const wb = workbench();
  if (!wb.pieces.length) return;
  openOnBench({ ...structuredClone(wb), id: uid(), name: `${wb.name.trim() || 'Thing'} copy` });
  hint('Made a copy to change', 1800);
};
$('#thing-download').onclick = () => {
  const wb = workbench();
  // one kind of file: a save holding just this thing opens straight into My stuff
  saveBundle({ creatures: [], stuff: [stripThumb(wb)], rigs: [] }, wb.name.trim() || 'thing');
};
$('#thing-delete').onclick = () => {
  const wb = workbench();
  const name = wb.name.trim() || 'this thing';
  if (wb.pieces.length && !confirm(`Delete "${name}" from My stuff? (Creatures already wearing it keep their copy.)`)) return;
  clearTimeout(thingSaveTimer);
  removeThing(wb.id);
  // carry on with the last thing in the list, or a fresh one
  const next = collection().at(-1);
  world.workbench = next ? stripThumb(next) : newThing();
  selectedPiece = '';
  $('#thing-saved').textContent = '';
  syncWorkbench();
  commit();
  renderStuffPanel();
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
  invalidate();
  if (placing) {
    // creatures only grow or shrink evenly: whichever handle moved sets the size
    const s = creature.root.scale;
    if (gizmo.mode === 'scale' && !(s.x === s.y && s.y === s.z)) {
      const pick = [s.x, s.y, s.z].reduce((a, v) => (Math.abs(v - placeScale) > Math.abs(a - placeScale) ? v : a), placeScale);
      s.setScalar(Math.max(0.02, pick));
    }
    placeScale = s.x;
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
gizmo.addEventListener('mouseDown', () => {
  if (placing) gapBefore = floorGap();
});
gizmo.addEventListener('mouseUp', () => {
  if (piecePivot && gizmo.object === piecePivot) {
    bakePiece();
    return;
  }
  // a rescaled felt attachment regrows its fuzz at the new size
  if (selectedAttachment) creature.syncAttachments();
  if (placing && gizmo.mode === 'translate' && lifted()) setKeepFloor(false, true);
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
  gizmo.showX = gizmo.showY = gizmo.showZ = true;
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
// arranging creatures in the scene: the same gizmo moves, turns and resizes
// a whole creature anywhere in 3D

let placing = false;
/** the creature's size when the scale handles were last read */
let placeScale = 1;
type PlaceMode = 'translate' | 'rotate' | 'scale';

function setPlaceMode(m: PlaceMode) {
  gizmo.setMode(m);
  // move along the scene's axes; turn and size about the creature's own
  gizmo.setSpace(m === 'translate' ? 'world' : 'local');
  placeScale = creature.root.scale.x;
  document.querySelectorAll<HTMLButtonElement>('#place-bar [data-place]').forEach((b) => b.classList.toggle('on', b.dataset.place === m));
}

/** Arrange: rest the creature on the floor (its lowest point, stuff included, at floor level). */
function placeOnFloor() {
  const box = creatureBox(true);
  if (box.isEmpty()) return;
  creature.root.position.y -= box.min.y;
  creature.capturePlacement();
  setKeepFloor(true);
  fitShadows();
  commit();
}

function startPlacing() {
  if (mode === 'stuff') return;
  if (selectedAttachment) deselectAttachment();
  placing = true;
  gizmo.showX = gizmo.showY = gizmo.showZ = true;
  gizmo.attach(creature.root);
  setPlaceMode('translate');
  $('#place-bar').hidden = false;
  $('#place-name').textContent = creatureLabel(world.active);
  $('#cr-place').classList.add('on');
  $('#shape-legend').hidden = true;
  updateSkeletonVisibility();
}

function stopPlacing() {
  if (!placing) return;
  placing = false;
  gizmo.detach();
  gizmo.setSpace('local');
  $('#place-bar').hidden = true;
  $('#cr-place').classList.remove('on');
  $('#shape-legend').hidden = false;
  updateSkeletonVisibility();
}

document.querySelectorAll<HTMLButtonElement>('#place-bar [data-place]').forEach((b) => {
  b.onclick = () => setPlaceMode(b.dataset.place as PlaceMode);
});
$('#place-floor').onclick = () => placeOnFloor();
$('#place-reset').onclick = () => {
  // upright, normal size, still facing the same way
  const yaw = new THREE.Euler().setFromQuaternion(creature.root.quaternion, 'YXZ').y;
  creature.root.rotation.set(0, yaw, 0);
  creature.root.scale.setScalar(1);
  creature.root.position.y = 0;
  placeScale = 1;
  creature.capturePlacement();
  setKeepFloor(true);
  settleOnFloor();
  fitShadows();
  commit();
};
$('#place-done').onclick = () => {
  stopPlacing();
  commit(); // records the move if anything changed (no-op otherwise)
};

// ---------------------------------------------------------------------------
// the creature switcher

function renderCreatureBar() {
  const el = $('#creature-rows');
  el.innerHTML = '';
  // one row per creature, like the pieces in Stuff: pick (or rename) it, copy it, or remove it
  world.creatures.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'piece-row creature-row';
    row.classList.toggle('active', i === world.active && !idle);
    const pick = document.createElement('button');
    pick.className = 'piece-pick';
    const color = Object.values(s.parts)[0]?.color ?? '#ccc';
    pick.innerHTML = `<i style="background:${color}"></i>`;
    const name = document.createElement('span');
    name.className = 'creature-name';
    name.textContent = creatureLabel(i);
    pick.append(name);
    pick.title = i === world.active && !idle ? `${creatureLabel(i)}: click to rename` : creatureLabel(i);
    pick.onclick = () => {
      if (i === world.active && !idle) return renameCreatureRow(pick);
      idle = false;
      activate(i);
      flashPart();
      save();
      renderUI();
    };
    const dup = document.createElement('button');
    dup.className = 'piece-icon';
    dup.innerHTML = fa('copy');
    dup.title = 'Copy this creature';
    dup.onclick = () => duplicateCreature(i);
    const del = document.createElement('button');
    del.className = 'piece-icon';
    del.innerHTML = fa('trash');
    del.title = world.creatures.length < 2 ? 'The scene needs at least one creature' : 'Remove this creature from the scene';
    del.disabled = world.creatures.length < 2;
    del.onclick = () => removeCreature(i);
    row.append(pick, dup, del);
    el.append(row);
  });
}

/** Turns the active creature's row into a name box: Enter or clicking away keeps it, Escape doesn't. */
function renameCreatureRow(btn: HTMLButtonElement) {
  const before = state.name;
  const input = document.createElement('input');
  input.className = 'text chip-name';
  input.maxLength = 60;
  input.placeholder = `Creature ${world.active + 1}`;
  input.value = state.name ?? '';
  btn.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    state.name = keep ? input.value.trim() || undefined : before;
    renderCreatureBar();
    if (keep && state.name !== before) commit();
  };
  input.onkeydown = (e) => {
    e.stopPropagation(); // typing a name isn't a shortcut
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
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
  idle = false;
  exitDraw();
  world.creatures.push(s);
  creatures.push(makeCreature(s));
  activate(world.creatures.length - 1);
  commit();
  renderUI();
  frameAll();
}

$('#cr-add').onclick = () => {
  const s = defaultState(freshRig(state.rig));
  s.style = state.style;
  s.materialSettings = structuredClone(state.materialSettings);
  s.placement = freeSpot();
  addCreature(s);
  hint('Added a new creature: click any creature to switch between them', 2600);
};
function duplicateCreature(i: number) {
  const src = world.creatures[i];
  const s = structuredClone(src);
  delete s.workbench;
  s.name = src.name?.trim() ? `${src.name.trim()} copy` : undefined;
  // same size, turn and height; just moved over to free floor
  const spot = freeSpot();
  s.placement = { ...(src.placement ?? spot), x: spot.x, z: spot.z };

  addCreature(s);
}
function removeCreature(i: number) {
  if (world.creatures.length < 2) return;
  const label = creatureLabel(i); // no are-you-sure: undo brings it back
  exitDraw();
  stopPlacing();
  if (i !== world.active) activate(i);
  creatures[i].dispose();
  creatures.splice(i, 1);
  world.creatures.splice(i, 1);
  creature = undefined as unknown as Creature; // the old one is gone; don't try to reset it
  activate(Math.max(0, i - 1));
  commit();
  renderUI();
  hint(`Removed ${label}: Ctrl+Z brings it back`, 2600);
}
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
  const part = state.parts[creature.bones.get(a.bone)?.src ?? ''];
  renderThingMaterial(a.thing, [...new Set(a.thing.pieces.map((p) => p.style))], $('#attach-mat-body'), part?.style ?? state.style);
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
    iconLabel(btn, fa('paperclip'), a.thing.name);
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
};
$<HTMLInputElement>('#creature-name').oninput = (e) => {
  state.name = (e.target as HTMLInputElement).value;
  renderCreatureBar();
};
$<HTMLInputElement>('#creature-name').onchange = () => commit();
/** Files are named after who's in the scene: "Bimble", or "Bimble-Twin-Creature 3". */
function sceneFileName(): string {
  return world.creatures.map((_, i) => creatureLabel(i)).join('-');
}

/** A creature as it goes into a file (the workbench isn't part of it). */
function forFile(s: CreatureState): CreatureState {
  const { workbench: _wb, ...data } = s;
  return data;
}

// One kind of save: a .creature file holds everything (creatures, My stuff,
// saved body plans and the backdrop). Opening one lets you pick what to bring in.

/** The backdrop, floor, lights and depth of field. */
interface SceneLook {
  backdrop: string;
  floor: typeof floorPrefs;
  light: number;
  dof: typeof dof;
}

/** What a save holds. Older files (.scene, .stuff, .collection, single creatures) are read into one too. */
interface Bundle {
  name?: string;
  active?: number;
  creatures: CreatureState[];
  stuff: Thing[];
  rigs: RigState[];
  look?: SceneLook;
}

function currentLook(): SceneLook {
  return { backdrop, floor: { ...floorPrefs }, light: lightTurn, dof: { ...dof } };
}

function saveBundle(b: Bundle, name: string) {
  downloadText(`${safeFileName(name, 'my-creatures')}.creature`, JSON.stringify(envelope('creature', b)));
}

$('#file-save').onclick = () => {
  saveBundle(
    { active: world.active, creatures: world.creatures.map(forFile), stuff: collection(), rigs: savedRigs(), look: currentLook() },
    sceneFileName(),
  );
};
$('#file-open').onclick = () => $<HTMLInputElement>('#file-input').click();
$<HTMLInputElement>('#file-input').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    openFile(await file.text(), file.name);
  } catch (err) {
    hint(`${file.name}: ${(err as Error).message}`, 3500, true);
  }
};

/** Read any CritterKiln file into a bundle. */
function bundleFrom(text: string): Bundle {
  const env = parseEnvelope(text);
  const d = env.data as Record<string, unknown>;
  const creaturesOf = (raw: unknown[]) => raw.map(migrate).filter((s): s is CreatureState => !!s);
  if (env.kind === 'creature' && Array.isArray(d.creatures)) {
    return {
      name: d.name as string | undefined,
      active: d.active as number | undefined,
      creatures: creaturesOf(d.creatures),
      stuff: ((d.stuff as Thing[] | undefined) ?? []).filter((t) => Array.isArray(t?.pieces)),
      rigs: (d.rigs as RigState[] | undefined) ?? [],
      look: d.look as SceneLook | undefined,
    };
  }
  if (env.kind === 'creature') return { creatures: creaturesOf([d]), stuff: [], rigs: [] };
  if (env.kind === 'scene') return { name: d.name as string | undefined, active: d.active as number | undefined, creatures: creaturesOf((d.creatures as unknown[]) ?? []), stuff: [], rigs: [] };
  if (env.kind === 'stuff') {
    if (!Array.isArray(d.pieces)) throw new Error('The stuff in this file could not be read.');
    return { creatures: [], stuff: [d as unknown as Thing], rigs: [] };
  }
  return { creatures: [], stuff: (d.things as Thing[] | undefined) ?? [], rigs: (d.rigs as RigState[] | undefined) ?? [] };
}

function openFile(text: string, fileName = '') {
  const b = bundleFrom(text);
  for (const s of b.creatures) delete s.workbench; // the workbench belongs to the scene, not the file
  if (!b.creatures.length && !b.stuff.length && !b.rigs.length && !b.look) throw new Error('There was nothing in this file that could be read.');
  // a single thing comes straight into My stuff; anything with a creature asks
  // whether it joins the scene or replaces it
  if (!b.creatures.length && b.stuff.length === 1 && !b.rigs.length) {
    loadBundle(b, { creatures: b.creatures.map(() => true), stuff: b.stuff.map(() => true), rigs: [], look: false }, false);
    return;
  }
  showLoadPicker(b, b.name?.trim() || fileName.replace(/\.[^.]+$/, ''));
}

interface LoadChoice {
  creatures: boolean[];
  stuff: boolean[];
  rigs: boolean[];
  look: boolean;
}

/** Bring the chosen parts of a bundle in: alongside what's here, or in place of the scene. */
function loadBundle(b: Bundle, pick: LoadChoice, replace: boolean) {
  const incoming = b.creatures.filter((_, i) => pick.creatures[i]);
  const things = b.stuff.filter((_, i) => pick.stuff[i]);
  const rigs = b.rigs.filter((_, i) => pick.rigs[i]);
  exitDraw();
  deselectAttachment();
  stopPlacing();
  // stuff the creatures are wearing joins My stuff, so it can be moved or worn again
  const have = new Set(collection().map((t) => t.id));
  for (const t of [...incoming.flatMap((s) => (s.attachments ?? []).map((a) => a.thing)), ...things]) {
    if (have.has(t.id)) continue;
    putThing(t);
    have.add(t.id);
  }
  for (const r of rigs) saveRig(r, r.name);
  if (pick.look && b.look) applyLook(b.look);

  if (incoming.length && replace) {
    for (const c of creatures) c.dispose();
    creatures.length = 0;
    creature = undefined as unknown as Creature; // replaced wholesale
    const active = Math.max(0, incoming.indexOf(b.creatures[b.active ?? 0]));
    world = { creatures: incoming, active, workbench: world.workbench, name: b.name };
    incoming.forEach((s, i) => (creatures[i] = makeCreature(s)));
    selected = '';
    activate(world.active);
  } else if (incoming.length) {
    // keep the file's own arrangement, shifted to free floor on the right
    const spot = freeSpot();
    const minX = Math.min(...incoming.map((s) => s.placement?.x ?? 0));
    for (const s of incoming) {
      s.placement = { ...s.placement, x: spot.x + ((s.placement?.x ?? 0) - minX), z: s.placement?.z ?? 0, yaw: s.placement?.yaw ?? 0 };
      world.creatures.push(s);
      creatures.push(makeCreature(s));
    }
    activate(world.creatures.length - 1);
  }
  commit();
  renderUI();
  renderCollection();
  renderRigs();
  if (incoming.length && mode !== 'stuff') frameAll();

  const bits = [
    incoming.length === 1 ? incoming[0].name || 'a creature' : incoming.length ? `${incoming.length} creatures` : '',
    things.length === 1 ? `"${things[0].name || 'a thing'}"` : things.length ? `${things.length} things` : '',
    rigs.length ? `${rigs.length} body plan${rigs.length > 1 ? 's' : ''}` : '',
    pick.look && b.look ? 'the backdrop' : '',
  ].filter(Boolean);
  hint(`${replace && incoming.length ? 'Opened' : 'Added'} ${bits.join(', ').replace(/, ([^,]*)$/, ' and $1')}`, 2400);
}

function applyLook(l: SceneLook) {
  setBackdrop(l.backdrop);
  Object.assign(floorPrefs, l.floor);
  saveFloor();
  applyFloor();
  lightTurn = l.light ?? 0;
  applyLighting();
  try {
    localStorage.setItem(LIGHT_KEY, JSON.stringify({ turn: lightTurn }));
  } catch {
    /* ignore */
  }
  Object.assign(dof, l.dof);
  saveDof();
  applyDof();
}

/** The "what do you want from this file?" picker. */
function showLoadPicker(b: Bundle, title: string) {
  const pick: LoadChoice = {
    creatures: b.creatures.map(() => true),
    stuff: b.stuff.map(() => true),
    rigs: b.rigs.map(() => true),
    look: !!b.look,
  };
  // just one thing to bring in: no checklist, only "add or replace?"
  const single = b.creatures.length + b.stuff.length + b.rigs.length + (b.look ? 1 : 0) === 1;
  if (single && b.creatures[0]?.name?.trim()) title = b.creatures[0].name.trim();
  $('#load-title').textContent = title ? `Open “${title}”` : 'Open';
  $('#load-note').hidden = !single;
  $('#load-all-row').hidden = single;
  $('#load-list').hidden = single;
  const list = $('#load-list');
  list.innerHTML = '';
  const boxes: HTMLInputElement[] = [];
  const sync = () => {
    const n = [...pick.creatures, ...pick.stuff, ...pick.rigs, pick.look && !!b.look].filter(Boolean).length;
    const all = $<HTMLInputElement>('#load-all');
    all.checked = n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
    $<HTMLButtonElement>('#load-add').disabled = n === 0;
    // replacing the scene needs someone to replace it with
    $<HTMLButtonElement>('#load-replace').disabled = !pick.creatures.some(Boolean);
  };
  const group = (label: string) => {
    const h = document.createElement('div');
    h.className = 'pop-sub';
    h.textContent = label;
    list.append(h);
  };
  const row = (icon: string, name: string, get: () => boolean, set: (v: boolean) => void) => {
    const l = document.createElement('label');
    l.className = 'load-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = get();
    cb.onchange = () => {
      set(cb.checked);
      sync();
    };
    boxes.push(cb);
    const ic = document.createElement('span');
    ic.className = 'load-icon';
    ic.innerHTML = icon;
    const nm = document.createElement('span');
    nm.textContent = name;
    l.append(cb, ic, nm);
    list.append(l);
  };
  if (b.creatures.length) {
    group('Creatures');
    b.creatures.forEach((s, i) => {
      const color = Object.values(s.parts)[0]?.color ?? '#ccc';
      row(`<i class="load-dot" style="background:${color}"></i>`, s.name?.trim() || `Creature ${i + 1}`, () => pick.creatures[i], (v) => (pick.creatures[i] = v));
    });
  }
  if (b.stuff.length) {
    group('Stuff');
    b.stuff.forEach((t, i) => {
      const icon = t.thumb ? `<img src="${t.thumb}" alt="" />` : fa('box');
      row(icon, t.name?.trim() || 'Thing', () => pick.stuff[i], (v) => (pick.stuff[i] = v));
    });
  }
  if (b.rigs.length) {
    group('Body plans');
    b.rigs.forEach((r, i) => row(faClassic('bone'), r.name, () => pick.rigs[i], (v) => (pick.rigs[i] = v)));
  }
  if (b.look) {
    group('Scene');
    row(`<i class="load-dot" style="background:${b.look.backdrop}"></i>`, 'Backdrop & lighting', () => pick.look, (v) => (pick.look = v));
  }
  $<HTMLInputElement>('#load-all').onchange = (e) => {
    const on = (e.target as HTMLInputElement).checked;
    pick.creatures.fill(on);
    pick.stuff.fill(on);
    pick.rigs.fill(on);
    pick.look = on && !!b.look;
    for (const cb of boxes) cb.checked = on;
    sync();
  };
  const close = () => ($('#load-pop').hidden = true);
  $('#load-close').onclick = close;
  $('#load-add').onclick = () => {
    close();
    loadBundle(b, pick, false);
  };
  $('#load-replace').onclick = () => {
    close();
    loadBundle(b, pick, true);
  };
  sync();
  for (const [btn, p] of POPOVERS) {
    $(p).hidden = true;
    $(btn).classList.remove('on');
  }
  $('#load-pop').hidden = false;
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
  idle = false;
  selected = id;
  creature.select(id);
  updateSkeletonVisibility();
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
    ...RIGS.map((r) => ({ base: r.id, icon: `<i class="${r.icon}" aria-hidden="true"></i>`, name: r.name })),
    ...savedRigs().map((r) => ({ base: r.base, icon: faClassic('bone'), name: r.name })),
  ];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.innerHTML = `<span>${o.icon}</span>`;
    btn.title = o.name;
    btn.setAttribute('aria-label', o.name);
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
    btn.innerHTML = `<i style="background:${p.color}"></i>${partLabel(b.src)}${twin ? ' ×2' : ''}${p.outline ? ` ${fa('check')}` : ''}`;
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
  // parts blended into this one are one surface: they share its opacity
  const others = creature.blendedWith(selected).filter((src) => src !== creature.bones.get(selected)!.src);
  $('#opacity-note').hidden = !others.length;
  $('#opacity-note').textContent = others.length ? `Blended with ${others.map(partLabel).join(', ')}: they fade together.` : '';
  $<HTMLButtonElement>('#reset-shape').disabled = !p.outline;
}

let opacityPending = false;
$<HTMLInputElement>('#opacity').oninput = (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  for (const src of creature.blendedWith(selected)) state.parts[src].opacity = v;
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
 * A stuff item's material controls. "Inherits material" makes it take the
 * material of whatever wears it (type and settings: the body part it's on);
 * otherwise each piece keeps its own material, with sliders just for this item.
 */
function renderThingMaterial(thing: Thing, styles: StyleId[], el: HTMLElement, wearerStyle: StyleId) {
  el.innerHTML = '';
  // items from before inheriting meant this shared the creature's settings:
  // give them their own copy, looking just as they do now
  if (!thing.inherit && !thing.ownMaterial) {
    thing.ownMaterial = true;
    thing.materialSettings ??= {};
    for (const st of styles) thing.materialSettings[st] ??= { ...creature.settingsFor(st) };
  }
  const row = document.createElement('label');
  row.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !!thing.inherit;
  box.onchange = () => {
    thing.inherit = box.checked;
    if (!thing.inherit) {
      // back to its own pieces' materials, starting from what those look like on the creature
      thing.ownMaterial = true;
      thing.materialSettings ??= {};
      for (const st of styles) thing.materialSettings[st] ??= { ...creature.settingsFor(st) };
    }
    creature.sync();
    syncWorkbench();
    commit();
    if (mode === 'stuff') renderStuffPanel();
    else renderThingMaterial(thing, styles, el, wearerStyle);
  };
  row.append(box, ' Inherits material');
  el.append(row);
  const styleName = STYLES.find((s) => s.id === wearerStyle)?.name ?? wearerStyle;
  if (thing.inherit) {
    const note = document.createElement('p');
    note.className = 'muted small inherit-note';
    note.textContent = `Made of ${styleName}, like the ${mode === 'stuff' ? 'creature' : 'part it’s on'}. Change it in Build › Material.`;
    el.append(note);
  }
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
  if (thing.inherit) return;
  for (const st of styles) {
    const sub = document.createElement('div');
    sub.className = 'style-params';
    el.append(sub);
    renderStyleParams(st, sub, thing);
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
  const icons: Record<string, string> = {
    none: fa('eye-slash'),
    googly: faClassic('eyes'),
    flat: fa('circle'),
    bead: fa('circle-half-stroke'),
    dot: faClassic('circle-small'),
    button: faClassic('circle-dot'),
  };
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
    btn.textContent = `${e.pairs[i].single ? 'Eye' : 'Pair'} ${i + 1}`;
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
    const on = e.pairs[eyePair] ?? last;
    e.pairs.push({ size: Math.max(0.15, last.size * 0.75), spacing: last.spacing, height: Math.max(0.1, last.height - 0.22), lift: last.lift ?? e.lift, bone: on.bone, single: on.single, turn: on.turn ?? e.turn });
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
  // which part they're on: a mirrored pair of parts is one choice
  const where = $<HTMLSelectElement>('#eye-bone');
  where.innerHTML = '';
  for (const b of sources()) where.append(new Option(partLabel(b.def.id), b.src));
  where.value = creature.eyeBones(pair)[0]?.src ?? '';
  $<HTMLInputElement>('#eye-single').checked = !!pair.single;
  $<HTMLInputElement>('#eye-size').value = String(pair.size);
  $<HTMLInputElement>('#eye-spacing').value = String(pair.spacing);
  $<HTMLInputElement>('#eye-spacing').disabled = !!pair.single;
  $<HTMLInputElement>('#eye-height').value = String(pair.height);
  $('#eye-sliders').style.opacity = e.enabled ? '1' : '.4';
  $<HTMLInputElement>('#eye-lift').value = String(pair.lift ?? e.lift ?? 0);
  $<HTMLInputElement>('#eye-turn').value = String(Math.round(((pair.turn ?? e.turn ?? 0) * 180) / Math.PI));
  // finish and color only apply to the styles made of a material
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
  syncIdle();
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

/**
 * A fresh copy of the skeleton a creature was started from: the current
 * template (or saved rig), so new creatures get its latest version. An edited
 * skeleton is kept as it is.
 */
function freshRig(rig: RigState): RigState {
  if (rig.base.startsWith('saved:')) return structuredClone(savedRigs().find((r) => r.base === rig.base) ?? rig);
  const t = RIGS.find((r) => r.id === rig.base);
  return t ? rigFromTemplate(t) : structuredClone(rig);
}

function switchRig(base: string) {
  const rig = base.startsWith('saved:') ? savedRigs().find((r) => r.base === base) : rigFromTemplate(getRig(base));
  if (!rig) return;
  // picking the plan it already has only does something if its skeleton is
  // out of date (made before the template changed)
  if (base === state.rig.base && JSON.stringify(rig.bones) === JSON.stringify(state.rig.bones)) return;
  // no confirm: switching clears drawn shapes and pose, but it's one undo away
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
  // leaving the workbench: keep what's on it (while it's still there to photograph)
  if (mode === 'stuff' && m !== 'stuff') saveWorkbenchNow();
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('#parts-sec').hidden = m === 'stuff';
  $('#plan-sec').hidden = m !== 'shape';
  $('#shape-panel').hidden = m !== 'shape';
  $('#look-panel').hidden = m !== 'look';
  $('#shape-bar').hidden = m === 'stuff';
  $('#shape-bar').classList.toggle('look', m === 'look');
  $('#stuff-panel').hidden = m !== 'stuff';
  $('#creature-bar').hidden = m === 'stuff';
  if (m === 'stuff') stopPlacing();
  if (m !== 'look') {
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
    autosaveThing();
    hint('Draw pieces on the board; the blue crosshair is where it attaches', 3200);
  } else if (wasStuff) {
    frameCreature();
  }
  updateSkeletonVisibility();
  syncIdle();
  refreshPieceGizmo();
  if (m === 'shape') {
    hint(`Drag the orange balls to bend · the teal arrows to stretch · ${touchScreen() ? 'double-tap' : 'double-click'} a part to draw it`, 3600);
    renderRigPanel();
  }
  if (m === 'look') hint('Click a part, then pick its color and material', 2200);
}

// ---------------------------------------------------------------------------
// rig editing

/** Apply a skeleton edit, give new bones a look, rebuild, and select the first new bone. */
function rigEdit(fn: (rig: RigState) => PartCopy[], copyShape: boolean) {
  const copies = fn(state.rig);
  for (const c of copies) {
    const from = state.parts[c.from];
    if (from && !state.parts[c.to]) {
      const to: PartState = structuredClone(from);
      if (!copyShape) setPartShapes(to, []);
      state.parts[c.to] = to;
    }
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
  $<HTMLButtonElement>('#rig-eyes').disabled = !b;
  $<HTMLButtonElement>('#rig-split').disabled = !b;
  $('#rig-pair-note').textContent = paired ? 'Mirrored pair: both sides move together.' : '';
  $<HTMLInputElement>('#rig-sym').checked = rigLocked();
  $<HTMLInputElement>('#keep-floor').checked = state.keepFloor !== false;
  $('#mirror-pill').classList.toggle('on', rigLocked());
  if (b) {
    $<HTMLInputElement>('#rig-w0').value = String(b.def.width);
    $<HTMLInputElement>('#rig-w1').value = String(b.def.widthEnd ?? b.def.width);
    // a drawn shape sets its own widths: these only count again after Reset shape
    const drawn = !!state.parts[b.src]?.outline;
    for (const w of ['w0', 'w1']) {
      $<HTMLInputElement>(`#rig-${w}`).disabled = drawn;
      $(`#rig-${w}-row`).classList.toggle('off', drawn);
      $(`#rig-${w}-row`).title = drawn ? 'This part has a drawing, which sets its own widths. Reset shape to use these.' : '';
    }
  }

  const list = $('#saved-rig-list');
  list.innerHTML = '';
  for (const r of savedRigs()) {
    const row = document.createElement('div');
    row.className = 'saved-rig';
    const load = document.createElement('button');
    load.className = 'ghost';
    iconLabel(load, faClassic('bone'), r.name);
    load.onclick = () => switchRig(r.base);
    const del = document.createElement('button');
    del.className = 'ghost';
    del.innerHTML = fa('xmark');
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
    const upper: PartState = structuredClone(p);
    // every shape is cut at the same height (side drawings run along the bone too)
    const shapes = partShapes(p);
    const below = shapes.flatMap((sh) => {
      const l = clipLoop(sh.outline, r.at, 'below');
      return l ? [{ ...sh, outline: l }] : [];
    });
    const above = shapes.flatMap((sh) => {
      const l = clipLoop(sh.outline, r.at, 'above');
      return l ? [{ ...sh, outline: l.map(([x, y]) => [x, y - r.at] as Vec2) }] : [];
    });
    setPartShapes(p, below);
    setPartShapes(upper, above);
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
function setMirror(on: boolean) {
  rigLock = on;
  try {
    localStorage.setItem(RIG_PREFS_KEY, JSON.stringify({ lock: rigLock }));
  } catch {
    /* ignore */
  }
  renderRigPanel();
  hint(rigLock ? 'Mirror on: both sides bend, stretch and grow together' : 'Mirror off: each side on its own', 2000);
}
$<HTMLInputElement>('#rig-sym').onchange = (e) => setMirror((e.target as HTMLInputElement).checked);

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
for (const id of ['#rig-w0', '#rig-w1']) $<HTMLInputElement>(id).onchange = () => commitBoneEdit();
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
  const b = creature.bones.get(selected);
  if (!b) return;
  const e = state.eyes;
  // a limb (one of a mirrored pair, or a stalk) gets a single eye near its tip; a head gets a pair
  const limb = b.def.sideSign !== 0 || b.length > 1.6 * b.def.width;
  e.pairs.push({ size: 0.5, spacing: 0.5, height: limb ? 0.8 : 0.55, bone: b.src, single: limb || undefined });
  e.enabled = true;
  creature.sync();
  commit();
  showEyes(e.pairs.length - 1);
  hint(limb ? 'Eye added: shape it under Eyes' : 'Eyes added: shape them under Eyes', 1800);
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
  // fingers tap
  if (touchScreen()) text = text.replace(/([Cc])lick(ing|ed)?/g, (_, c: string, end = '') => (c === 'C' ? 'T' : 't') + 'ap' + (end && 'p' + end));
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
const settings: { numbers: boolean; seamless: SeamlessMode; seamlessLowPoly: boolean; quality: Quality } = (() => {
  const defaults = { numbers: false, seamless: 'on' as SeamlessMode, seamlessLowPoly: false, quality };
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
  document.querySelectorAll<HTMLButtonElement>('#set-quality button').forEach((b) => b.classList.toggle('active', b.dataset.quality === quality));
  if (settings.numbers) syncSliderNumbers();
}

/**
 * With "Show numbers" on, every slider has a number box beside it. Material
 * sliders make their own (marked `own`: they take values past the slider's
 * ends, so they aren't overwritten from it); the rest are added here and kept
 * in step with their slider.
 */
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;

/**
 * Let a slider hold a value past its ends (typed into its number box, or put
 * back from a saved value): it shows pinned at the end but reads back the real
 * number, so every handler that reads `.value` just works. Touching the slider
 * itself goes back to its own range.
 */
function unlimited(range: HTMLInputElement) {
  if (range.dataset.unlimited) return;
  range.dataset.unlimited = '1';
  let over: string | null = null;
  Object.defineProperty(range, 'value', {
    configurable: true,
    get: () => over ?? (nativeValue.get!.call(range) as string),
    set: (v: string) => {
      nativeValue.set!.call(range, v);
      const n = parseFloat(v);
      over = Number.isFinite(n) && (n < parseFloat(range.min) || n > parseFloat(range.max)) ? String(v) : null;
    },
  });
  const drop = () => (over = null);
  range.addEventListener('pointerdown', drop);
  range.addEventListener('keydown', drop);
}

function syncSliderNumbers() {
  document.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((range) => {
    let num = range.nextElementSibling as HTMLInputElement | null;
    if (!num?.classList.contains('num')) {
      unlimited(range);
      const box = document.createElement('input');
      box.type = 'number';
      box.className = 'num';
      box.oninput = () => {
        if (!Number.isFinite(parseFloat(box.value))) return;
        // past either end, the slider pins there but keeps the typed value
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
/** Switch performance level: renderer settings now, and every shape rebuilt at the new detail. */
function setQuality(q: Quality) {
  if (q === quality) return;
  quality = settings.quality = q;
  const Q = QUALITY[q];
  setMeshDetail(Q.detail);
  setFuzzQuality(Q.fuzz);
  renderer.transmissionResolutionScale = Q.glass;
  // a new shadow map size takes a fresh map
  key.shadow.mapSize.setScalar(Q.shadow);
  key.shadow.map?.dispose();
  key.shadow.map = null;
  renderer.shadowMap.needsUpdate = true;
  // anti-aliasing: the targets are rebuilt with the new sample count on next use
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
    rt.samples = Q.samples;
    rt.dispose();
  }
  gtao.updateGtaoMaterial({ samples: Q.aoSamples });
  gtao.enabled = furPass.enabled = Q.ao;
  $<HTMLInputElement>('#ao').checked = Q.ao;
  resize();
  // every creature (and the workbench) remeshed at the new detail
  exitDraw();
  stopPlacing();
  for (let i = 0; i < creatures.length; i++) {
    creatures[i].dispose();
    creatures[i] = makeCreature(world.creatures[i]);
  }
  creature = undefined as unknown as Creature; // replaced wholesale
  activate(world.active);
  benchKey = '';
  syncWorkbench();
  fitShadows();
  saveSettings();
  renderSettings();
  renderUI();
}
document.querySelectorAll<HTMLButtonElement>('#set-quality button').forEach((b) => {
  b.onclick = () => setQuality(b.dataset.quality as Quality);
});

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

/** Drops the top bar's button labels whenever they'd overflow it (narrow window or zoomed in). */
function fitTopbar() {
  const bar = $('.topbar');
  bar.classList.remove('compact');
  // on a phone the tools scroll rather than overflow the bar
  const tools = $('.topbar .tools');
  bar.classList.toggle('compact', bar.scrollWidth > bar.clientWidth || tools.scrollWidth > tools.clientWidth);
}
new ResizeObserver(fitTopbar).observe($('.topbar'));
document.fonts.ready.then(fitTopbar); // the icon font and Nunito change the buttons' widths
installScrollbars();
installCursorPress();

// On a phone the panel is a sheet under the viewport: drag its grip to resize it, tap to fold it away.
const SHEET_KEY = 'creature-creator/sheet';
{
  const app = $('#app');
  const grip = $<HTMLButtonElement>('#sheet-grip');
  const MIN_VIEW = 140; // always leave this much of the viewport
  let open = 0.42; // share of the window the open sheet takes
  let folded = false;
  try {
    const s = JSON.parse(localStorage.getItem(SHEET_KEY) ?? '{}');
    if (typeof s.open === 'number') open = s.open;
    folded = !!s.folded;
  } catch {}
  const apply = () => {
    const max = Math.max(0, app.clientHeight - 48 - grip.offsetHeight - MIN_VIEW);
    const px = folded ? 0 : Math.min(max, Math.max(80, open * app.clientHeight));
    app.style.setProperty('--sheet', `${Math.round(px)}px`);
  };
  const store = () => {
    try {
      localStorage.setItem(SHEET_KEY, JSON.stringify({ open, folded }));
    } catch {}
  };
  let drag: { y: number; px: number; moved: boolean } | null = null;
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, px: $('.panel').offsetHeight, moved: false };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const px = drag.px + dy;
    // drag it most of the way down and it folds away
    folded = px < 60;
    if (!folded) open = px / app.clientHeight;
    apply();
  });
  grip.addEventListener('pointerup', () => {
    if (drag && !drag.moved) folded = !folded;
    drag = null;
    apply();
    store();
  });
  grip.addEventListener('pointercancel', () => (drag = null));
  // picking a mode means wanting to see its panel
  document.querySelectorAll('.modes button').forEach((b) =>
    b.addEventListener('click', () => {
      if (!folded) return;
      folded = false;
      apply();
      store();
    }),
  );
  new ResizeObserver(apply).observe(app);
}
$('#draw').onclick = () => enterDraw({ kind: 'bone', boneId: selected });
$('#cancel-draw').onclick = () => exitDraw();
$('#reset-shape').onclick = () => {
  setPartShapes(selPart(), []);
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
  // without AO the fuzz is simply drawn with everything else
  furPass.enabled = gtao.enabled;
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
  // colors only blend where parts blend
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
$<HTMLSelectElement>('#eye-bone').onchange = (ev) => {
  const pair = state.eyes.pairs[eyePair];
  const src = (ev.target as HTMLSelectElement).value;
  // the head is the default, so a pair moved back there forgets its part
  if (creature.bones.get(state.rig.headId)?.src === src) delete pair.bone;
  else pair.bone = src;
  creature.sync();
  commit();
  renderEyes();
};
$<HTMLInputElement>('#eye-single').onchange = (ev) => {
  const pair = state.eyes.pairs[eyePair];
  if ((ev.target as HTMLInputElement).checked) pair.single = true;
  else delete pair.single;
  creature.sync();
  commit();
  renderEyes();
};
$<HTMLInputElement>('#eye-turn').oninput = (ev) => {
  state.eyes.pairs[eyePair].turn = Math.round(parseFloat((ev.target as HTMLInputElement).value) * (Math.PI / 180) * 1000) / 1000;
  creature.sync();
};
$<HTMLInputElement>('#eye-turn').onchange = () => commit();
$('#eye-front').onclick = () => {
  // undo their part's roll too, so the eyes look where the creature faces
  const pair = state.eyes.pairs[eyePair];
  const on = creature.eyeBones(pair)[0];
  const turn = Math.round(-(on?.def.roll ?? 0) * 1000) / 1000 || 0;
  if ((pair.turn ?? state.eyes.turn ?? 0) === turn) {
    hint('Already facing front', 1200);
    return;
  }
  pair.turn = turn;
  creature.sync();
  commit();
  renderEyes();
  hint('Eyes facing front', 1400);
};

$('#reset-pose').onclick = () => {
  creature.resetPose();
  settleOnFloor();
  commit();
  hint('Standing up straight', 1400);
};
$('#drop-floor').onclick = () => dropToFloor();
$<HTMLInputElement>('#keep-floor').onchange = (e) => {
  setKeepFloor((e.target as HTMLInputElement).checked);
  settleOnFloor();
  commit();
};
document.querySelectorAll<HTMLButtonElement>('#view-bar [data-view]').forEach((b) => (b.onclick = () => viewFrom(b.dataset.view!)));

$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#spin').onclick = () => {
  controls.autoRotate = !controls.autoRotate;
  $('#spin').classList.toggle('on', controls.autoRotate);
};
$('#new').onclick = () => {
  if (!confirm('You sure you want to start fresh?')) return;
  exitDraw();
  stopPlacing();
  deselectAttachment();
  if (mode !== 'shape') setMode('shape');
  clearCollection();
  selectedPiece = '';
  selected = '';
  // a fresh scene: one biped, an empty workbench
  restore(JSON.stringify({ creatures: [defaultState(rigFromTemplate(RIGS[0]))], active: 0 } satisfies World));
  commit();
  frameCreature(true);
  hint('Fresh start!', 1500);
};

/** Render one clean frame without handles or guides, then restore. */
function withCleanScene<T>(fn: () => T): T {
  const skel = handlesVisible();
  const helper = gizmo.getHelper();
  const gizmoShown = helper.visible;
  creature.setSkeletonVisible(false);
  creature.flash(null, 0);
  helper.visible = false;
  try {
    return fn();
  } finally {
    creature.setSkeletonVisible(skel);
    helper.visible = gizmoShown;
  }
}

/** The frame just rendered, as pixels. */
function grabFrame(): ImageData {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/**
 * A photo with no backdrop. The scene is rendered over black and over grey:
 * whatever changed between the two is see-through by that much, so soft edges,
 * fuzz and floor shadows keep their partial transparency. The sums are done in
 * linear light (blending happens there, not in the picture's sRGB), and the
 * grey is mid-range, where tone mapping is close to a straight line.
 */
function transparentShot(): string {
  const background = scene.background;
  // shadows are normally tinted toward the backdrop; with no backdrop, keep them neutral
  const shadowColor = shadowMat.color.clone();
  const groundColor = hemi.groundColor.clone();
  tintForBackdrop(new THREE.Color('#ffffff'));
  const render = (c: THREE.Color) => {
    scene.background = c;
    refreshFloorColors();
    composer.render();
    return grabFrame();
  };
  const GREY = 0.5;
  const greyOut = neutralTone([GREY, GREY, GREY])[0];
  const toLinear = Array.from({ length: 256 }, (_, v) => {
    const s = v / 255;
    return s < 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  try {
    const black = render(new THREE.Color(0, 0, 0));
    const grey = render(new THREE.Color(GREY, GREY, GREY));
    const b = black.data;
    const g = grey.data;
    const c = new THREE.Color();
    for (let i = 0; i < b.length; i += 4) {
      const lb = [toLinear[b[i]], toLinear[b[i + 1]], toLinear[b[i + 2]]];
      const lg = [toLinear[g[i]], toLinear[g[i + 1]], toLinear[g[i + 2]]];
      const seen = Math.max(lg[0] - lb[0], lg[1] - lb[1], lg[2] - lb[2]) / greyOut;
      const a = Math.min(1, Math.max(0, 1 - seen));
      // over black, color = alpha * own color: undo that
      if (a > 0) c.setRGB(lb[0] / a, lb[1] / a, lb[2] / a).convertLinearToSRGB();
      b[i] = Math.min(255, Math.round(c.r * 255));
      b[i + 1] = Math.min(255, Math.round(c.g * 255));
      b[i + 2] = Math.min(255, Math.round(c.b * 255));
      b[i + 3] = Math.round(a * 255);
    }
    const out = document.createElement('canvas');
    out.width = black.width;
    out.height = black.height;
    out.getContext('2d')!.putImageData(black, 0, 0);
    return out.toDataURL('image/png');
  } finally {
    scene.background = background;
    shadowMat.color.copy(shadowColor);
    hemi.groundColor.copy(groundColor);
    refreshFloorColors();
    invalidate();
  }
}

$('#shot').onclick = () => {
  const clear = $<HTMLInputElement>('#shot-clear').checked;
  const url = withCleanScene(() => {
    if (clear) return transparentShot();
    composer.render();
    return canvas.toDataURL('image/png');
  });
  // named after who's in the scene
  const name = sceneFileName();
  download(url, `${safeFileName(name, 'creature')}.png`);
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
  } else if (k === 'v' && drawState && !e.ctrlKey && !e.metaKey) {
    setDrawSide(!drawState.side);
  } else if (e.code === 'Space' && drawState) {
    e.preventDefault();
    setSpacePan(true);
  } else if (k === 'f' && drawState) {
    // back to a straight-on view of the drawing
    if (drawState.target.kind === 'bone') {
      const b = creature.bones.get(drawState.target.boneId);
      if (b) focusOnBone(b, drawState.side);
    } else if (drawState.frame !== board) focusOnPlane(drawState.frame);
    else focusOnBoard();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (k === 'd' && mode === 'shape' && !idle) enterDraw();
    else if (k === 'd' && mode === 'stuff') enterDraw({ kind: 'piece' });
    else if (k === '3') setMode('stuff');
    else if (k === 'm' && mode === 'shape' && !drawState) setMirror(!rigLock);
    else if (mode === 'stuff' && piecePivot && !drawState && (k === 'w' || k === 'e' || k === 'r')) setPieceMode(k === 'w' ? 'translate' : k === 'e' ? 'rotate' : 'scale');
    else if (selectedAttachment && (k === 'w' || k === 'e' || k === 'r')) {
      gizmo.setMode(k === 'w' ? 'translate' : k === 'e' ? 'rotate' : 'scale');
      syncAttachBar();
    }
    else if (placing && (k === 'w' || k === 'e' || k === 'r')) setPlaceMode(k === 'w' ? 'translate' : k === 'e' ? 'rotate' : 'scale');
    else if (k === '1') setMode('shape');
    else if (k === '2') setMode('look');
    else if (k === 'f') {
      if (mode === 'stuff') focusOnBoard();
      else frameCreature();
    }

    else if (k === 'a' && e.shiftKey) frameAll();
  }
});

// ---------------------------------------------------------------------------
// resize + loop

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(pixelRatio());
  composer.setPixelRatio(pixelRatio());
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
    // soft (VSM) shadow maps draw receivers as well as casters
    if (!(o instanceof THREE.Mesh) || !(o.castShadow || o.receiveShadow)) return;
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
  const busy = !!drawState || !!drag || gizmo.dragging || mode === 'stuff';
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
// A one-time nudge towards Settings > Performance when frames keep coming slowly.
let lastDrawn = 0;
let slowFrames = 0;
let slowHinted = false;
function watchSpeed(now: number) {
  const dt = now - lastDrawn;
  lastDrawn = now;
  // only while drawing frame after frame (a drag, a camera move...)
  if (slowHinted || quality === 'fast' || drawState || dt > 250) return;
  slowFrames = dt > 55 ? slowFrames + 1 : Math.max(0, slowFrames - 2);
  if (slowFrames > 40) {
    slowHinted = true;
    hint('Running slowly? Try Settings › Performance › Fast', 6000);
  }
}

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
  if (creature.tickBoing(now)) invalidate(1);
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
  watchSpeed(now);
}

// ---------------------------------------------------------------------------
// boot

$<HTMLInputElement>('#ao').checked = gtao.enabled;
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
if (import.meta.env.DEV) Object.assign(window, { __cc: { scene, camera, renderer, controls, flyTo, renderNow: () => { controls.update(); composer.render(); }, screenToLocal, localToOverlay, partPlane, get creature() { return creature; }, get drawState() { return drawState; }, openFile, selectAttachment, gizmo } });

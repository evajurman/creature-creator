import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { Creature, defaultState, EYE_STYLES, type BoneRT, type CreatureState, type EyeStyle } from './creature';
import { bounds, signedArea, smoothLoop, symmetrize, type Vec2 } from './inflate';
import { STYLE_PARAMS, STYLES, styleSettings, type StyleId } from './materials';
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
  savedRigs,
  unlinkPair,
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
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
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
fill.position.set(-4, 1.8, 2.5);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xfff4f8, 1.4);
rim.position.set(-1.5, 3, -4.5);
scene.add(rim);

// Invisible floor that only shows shadows and contact occlusion, so the
// backdrop colour is seamless in every direction.
const shadowMat = new THREE.ShadowMaterial({ opacity: 0.55 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), shadowMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

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
composer.addPass(gtao);
// optional macro-photo depth of field, focused on whatever the camera orbits
const bokeh = new BokehPass(scene, camera, { focus: 5, aperture: 0.004, maxblur: 0.012 });
bokeh.enabled = false;
composer.addPass(bokeh);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// state + history

const STORAGE_KEY = 'creature-creator/v1';
let state: CreatureState = load() ?? defaultState(rigFromTemplate(RIGS[0]));
let creature: Creature;
let selected = '';
type Mode = 'build' | 'rig' | 'pose';
let mode: Mode = 'build';
let eyePair = 0;

function load(): CreatureState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as CreatureState & { rigId?: string };
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked; nothing to do */
  }
}

const history: string[] = [];
let hIndex = -1;

function commit() {
  const snap = JSON.stringify(state);
  if (snap === history[hIndex]) return;
  history.splice(hIndex + 1);
  history.push(snap);
  if (history.length > 120) history.shift();
  hIndex = history.length - 1;
  save();
  updateUndo();
}

function restore(snap: string) {
  const s = JSON.parse(snap) as CreatureState;
  if (JSON.stringify(s.rig) !== JSON.stringify(state.rig)) {
    state = s;
    buildCreature();
  } else {
    state = s;
    creature.state = s;
    creature.sync();
  }
  save();
  renderUI();
}

function undo() {
  if (hIndex <= 0) return;
  restore(history[--hIndex]);
  updateUndo();
}

function redo() {
  if (hIndex >= history.length - 1) return;
  restore(history[++hIndex]);
  updateUndo();
}

function updateUndo() {
  $<HTMLButtonElement>('#undo').disabled = hIndex <= 0;
  $<HTMLButtonElement>('#redo').disabled = hIndex >= history.length - 1;
}

function buildCreature() {
  if (creature) scene.remove(creature.group);
  creature = new Creature(state);
  creature.setRigMode(mode === 'rig');
  scene.add(creature.group);
  if (!creature.bones.has(selected)) selected = creature.list[0].def.id;
  creature.select(selected);
  updateSkeletonVisibility();
}

// ---------------------------------------------------------------------------
// controls (our pointer handlers are registered first so they can veto orbiting)

const raycaster = new THREE.Raycaster();
const pointer = { downX: 0, downY: 0, moved: false };
let drag: {
  id: string;
  kind: 'root' | 'start' | 'end';
  plane: THREE.Plane;
  offset: THREE.Vector3;
  startHit: THREE.Vector3;
  /** rig mode: skeleton at the start of the drag, so each move re-applies from scratch */
  rigBase?: string;
  moved: boolean;
} | null = null;

canvas.addEventListener('pointerdown', (e) => {
  pointer.downX = e.clientX;
  pointer.downY = e.clientY;
  pointer.moved = false;
  if (e.button !== 0 || !handlesVisible()) return;
  const h = pickHandle(e.clientX, e.clientY);
  if (!h) return;
  controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
  const pos = h.getWorldPosition(new THREE.Vector3());
  const id = h.userData.handle as string;
  const normal =
    id === 'root' ? new THREE.Vector3(0, 1, 0) : camera.getWorldDirection(new THREE.Vector3()).negate();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pos);
  const offset = id === 'root' ? creature.group.position.clone().sub(pos) : new THREE.Vector3();
  const kind = id === 'root' ? 'root' : (h.userData.kind as 'start' | 'end');
  drag = { id, kind, plane, offset, startHit: pos, moved: false, rigBase: mode === 'rig' ? JSON.stringify(state.rig) : undefined };
  $('#viewport').style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (e) => {
  if (Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) > 5) pointer.moved = true;
  if (drag) {
    setRay(e.clientX, e.clientY);
    const hit = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (!hit) return;
    drag.moved = drag.moved || pointer.moved;
    if (drag.rigBase && drag.kind !== 'root') {
      if (!drag.moved) return;
      const d = hit.clone().sub(drag.startHit);
      state.rig = JSON.parse(drag.rigBase) as RigState;
      moveJoint(state.rig, drag.id, drag.kind, d.toArray() as V3);
      creature.relayout(state.rig);
    } else if (drag.id === 'root') {
      creature.group.position.copy(hit.add(drag.offset));
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
  if (!pointer.moved && e.button === 0) {
    const id = pickPart(e.clientX, e.clientY);
    if (id) selectPart(id);
  }
});

canvas.addEventListener('dblclick', (e) => {
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
  return !drawState && (mode !== 'build' || $<HTMLInputElement>('#skeleton-build').checked);
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

function frameCreature(threeQuarter = false) {
  const box = new THREE.Box3();
  creature.group.updateMatrixWorld(true);
  for (const m of creature.meshes()) box.expandByObject(m);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const dir = threeQuarter
    ? new THREE.Vector3(0.62, 0.32, 0.72).normalize()
    : camera.position.clone().sub(controls.target).normalize();
  const dist = (radius * 0.95) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  flyTo(center.clone().addScaledVector(dir, Math.max(dist, 2)), center);
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

interface DrawState {
  boneId: string;
  /** stroke in screen space, after the stabiliser */
  pts: Vec2[];
  /** the same stroke in the part's plane, for the mirror preview */
  local: Vec2[];
  /** stabiliser position */
  pen: Vec2 | null;
  active: boolean;
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
  const name = partLabel(creature.bones.get(drawState.boneId)!.src).toLowerCase();
  hint(drawPrefs.symmetry ? `Draw one half of the ${name}; it mirrors across the dashed line` : `Draw the ${name} as one closed loop`, 0);
}

function enterDraw() {
  if (drawState) exitDraw();
  const b = creature.bones.get(selected);
  if (!b) return;
  controls.autoRotate = false;
  $('#spin').classList.remove('on');
  drawState = { boneId: selected, pts: [], local: [], pen: null, active: false };
  overlay.classList.add('active');
  $('#draw-bar').hidden = false;
  syncDrawBar();
  creature.setDrawFocus(selected);
  updateSkeletonVisibility();
  focusOnBone(b);
  drawHint();
}

function exitDraw() {
  drawState = null;
  overlay.classList.remove('active');
  $('#draw-bar').hidden = true;
  creature.setDrawFocus(null);
  updateSkeletonVisibility();
  octx.clearRect(0, 0, overlay.width, overlay.height);
  hint('');
}

function syncDrawBar() {
  $<HTMLInputElement>('#sym').checked = drawPrefs.symmetry;
  $<HTMLInputElement>('#smooth').value = String(drawPrefs.smoothing);
  $('#sym-label').classList.toggle('on', drawPrefs.symmetry);
}

function toggleSymmetry() {
  drawPrefs.symmetry = !drawPrefs.symmetry;
  saveDrawPrefs();
  syncDrawBar();
  drawHint();
  renderOverlay();
}

function partPlane(b: BoneRT): THREE.Plane {
  b.pivot.updateMatrixWorld(true);
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(b.pivot.matrixWorld);
  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, b.pivot.getWorldPosition(new THREE.Vector3()));
}

function screenToLocal(b: BoneRT, plane: THREE.Plane, x: number, y: number): Vec2 | null {
  setRay(x, y);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  const l = b.pivot.worldToLocal(hit);
  return [Math.round(l.x * 1e4) / 1e4, Math.round(l.y * 1e4) / 1e4];
}

/** Part-plane point -> overlay pixel coordinates. */
function localToOverlay(b: BoneRT, [x, y]: Vec2): Vec2 {
  const v = b.pivot.localToWorld(new THREE.Vector3(x, y, 0)).project(camera);
  return [((v.x + 1) / 2) * overlay.clientWidth, ((1 - v.y) / 2) * overlay.clientHeight];
}

function strokeToLocal(b: BoneRT, pts: Vec2[]): Vec2[] {
  const plane = partPlane(b);
  const out: Vec2[] = [];
  for (const [x, y] of pts) {
    const p = screenToLocal(b, plane, x, y);
    if (!p) continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.004) out.push(p);
  }
  return out;
}

function finishStroke() {
  if (!drawState) return;
  const b = creature.bones.get(drawState.boneId)!;
  let local = strokeToLocal(b, drawState.pts);
  drawState.pts = [];
  drawState.local = [];
  drawState.active = false;
  if (local.length >= 6) {
    if (drawPrefs.symmetry) local = symmetrize(local);
    local = smoothLoop(local, drawPrefs.smoothing);
  }
  const bb = local.length ? bounds(local) : null;
  if (!bb || local.length < 6 || Math.abs(signedArea(local)) < 0.0015 || Math.max(bb.w, bb.h) < 0.05) {
    renderOverlay();
    hint('Too small or too thin: try a bigger loop', 1800, true);
    return;
  }
  state.parts[b.src].outline = local;
  exitDraw();
  creature.sync();
  commit();
  renderParts();
  flashPart();
  hint('Inflated! Drag to look around, or pick another part', 2200);
}

function addStrokePoint(p: Vec2) {
  if (!drawState) return;
  drawState.pts.push(p);
  const b = creature.bones.get(drawState.boneId)!;
  const l = screenToLocal(b, partPlane(b), p[0], p[1]);
  if (l) drawState.local.push(l);
}

overlay.addEventListener('pointerdown', (e) => {
  if (!drawState || e.button !== 0) return;
  overlay.setPointerCapture(e.pointerId);
  drawState.active = true;
  drawState.pts = [];
  drawState.local = [];
  drawState.pen = [e.clientX, e.clientY];
  addStrokePoint([e.clientX, e.clientY]);
  hint('');
});
overlay.addEventListener('pointermove', (e) => {
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
  if (drawState?.active) finishStroke();
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
  const b = creature.bones.get(drawState.boneId)!;
  octx.lineJoin = octx.lineCap = 'round';

  if (drawPrefs.symmetry) {
    // the mirror axis runs along the bone
    const reach = Math.max(b.length, b.def.width) * 2.5 + 0.5;
    const a = localToOverlay(b, [0, b.length / 2 - reach]);
    const z = localToOverlay(b, [0, b.length / 2 + reach]);
    octx.setLineDash([10, 8]);
    octx.strokeStyle = 'rgba(59,130,246,.75)';
    octx.lineWidth = 2;
    octx.beginPath();
    octx.moveTo(a[0], a[1]);
    octx.lineTo(z[0], z[1]);
    octx.stroke();
    octx.setLineDash([]);
  }

  if (drawState.pts.length < 2) return;
  const r = overlay.getBoundingClientRect();
  const pts = drawState.pts.map(([x, y]) => [x - r.left, y - r.top]);

  if (drawPrefs.symmetry && drawState.local.length > 1) {
    // live preview of the mirrored half
    octx.strokeStyle = 'rgba(255,107,74,.45)';
    octx.lineWidth = 3;
    octx.beginPath();
    drawState.local.forEach(([x, y], i) => {
      const [sx, sy] = localToOverlay(b, [-x, y]);
      if (i) octx.lineTo(sx, sy);
      else octx.moveTo(sx, sy);
    });
    octx.stroke();
  } else {
    // closing segment preview
    octx.setLineDash([6, 8]);
    octx.strokeStyle = 'rgba(255,107,74,.6)';
    octx.lineWidth = 2;
    octx.beginPath();
    octx.moveTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    octx.lineTo(pts[0][0], pts[0][1]);
    octx.stroke();
    octx.setLineDash([]);
  }
  octx.fillStyle = drawPrefs.symmetry ? 'transparent' : 'rgba(255,107,74,.12)';
  octx.strokeStyle = '#ff6b4a';
  octx.lineWidth = 4;
  octx.beginPath();
  pts.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
  if (!drawPrefs.symmetry) octx.fill();
  octx.stroke();
}

$<HTMLInputElement>('#sym').onchange = () => toggleSymmetry();
$<HTMLInputElement>('#smooth').oninput = (e) => {
  drawPrefs.smoothing = parseFloat((e.target as HTMLInputElement).value);
  saveDrawPrefs();
};

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
  $<HTMLButtonElement>('#reset-shape').disabled = !p.outline;
}

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

/** Sliders for whichever material is showing; they apply to every part using it. */
function renderStyleParams(style: StyleId) {
  const el = $('#style-params');
  el.innerHTML = '';
  const values = styleSettings(style, state.materialSettings?.[style]);
  const head = document.createElement('div');
  head.className = 'style-params-head';
  head.innerHTML = `<span>${STYLES.find((s) => s.id === style)!.name} settings</span>`;
  const reset = document.createElement('button');
  reset.className = 'link';
  reset.textContent = 'Reset';
  reset.onclick = () => {
    if (state.materialSettings) delete state.materialSettings[style];
    creature.sync();
    commit();
    renderStyleParams(style);
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
    input.oninput = () => {
      state.materialSettings ??= {};
      (state.materialSettings[style] ??= {})[p.key] = parseFloat(input.value);
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        creature.sync();
      });
    };
    input.onchange = () => commit();
    row.append(name, input);
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
    e.pairs.push({ size: Math.max(0.15, last.size * 0.75), spacing: last.spacing, height: Math.max(0.1, last.height - 0.22) });
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
}

function setColor(c: string, doCommit: boolean) {
  selPart().color = c;
  creature.sync();
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
  if (copies.length) selected = copies[0].to;
  creature.select(selected);
  commit();
  renderUI();
}

function renderRigPanel() {
  const b = creature.bones.get(selected);
  $('#rig-title').textContent = b ? b.def.name : 'Nothing selected';
  const isRoot = !b?.parent;
  const paired = !!b && b.def.sideSign !== 0;
  $<HTMLButtonElement>('#rig-dup').disabled = !b || isRoot;
  $<HTMLButtonElement>('#rig-del').disabled = !b || isRoot;
  $<HTMLButtonElement>('#rig-unlink').disabled = !paired;
  $<HTMLButtonElement>('#rig-eyes').disabled = !b || state.rig.headId === selected;
  $('#rig-pair-note').textContent = paired ? 'Mirrored pair: both sides move together.' : '';

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

$('#rig-add').onclick = () => rigEdit((rig) => addLimb(rig, selected, $<HTMLInputElement>('#rig-sym').checked), false);
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

// wire up static controls
document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode as Mode)));
$('#draw').onclick = () => enterDraw();
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
  const pop = $('#backdrop');
  pop.hidden = !pop.hidden;
  $('#backdrop-btn').classList.toggle('on', !pop.hidden);
  renderBackdrops();
};
$<HTMLInputElement>('#backdrop-color').oninput = (e) => {
  setBackdrop((e.target as HTMLInputElement).value);
  renderBackdrops();
};
$<HTMLInputElement>('#ao').onchange = (e) => {
  gtao.enabled = (e.target as HTMLInputElement).checked;
};
$<HTMLInputElement>('#dof').onchange = (e) => {
  bokeh.enabled = (e.target as HTMLInputElement).checked;
};

$<HTMLInputElement>('#merge').onchange = (e) => {
  state.merge = (e.target as HTMLInputElement).checked;
  creature.markMergeDirty();
  commit();
  renderMerge();
};
$<HTMLInputElement>('#merge-radius').oninput = (e) => {
  state.mergeRadius = parseFloat((e.target as HTMLInputElement).value);
  creature.markMergeDirty();
};
$<HTMLInputElement>('#merge-radius').onchange = () => commit();

function renderMerge() {
  $<HTMLInputElement>('#merge').checked = state.merge ?? true;
  $<HTMLInputElement>('#merge-radius').value = String(state.mergeRadius ?? 0.1);
  $('#merge-slider').style.opacity = (state.merge ?? true) ? '1' : '.4';
}

for (const k of ['size', 'spacing', 'height'] as const) {
  const input = $<HTMLInputElement>(`#eye-${k}`);
  input.oninput = () => {
    state.eyes.pairs[eyePair][k] = parseFloat(input.value);
    creature.sync();
  };
  input.onchange = () => commit();
}

$<HTMLInputElement>('#skeleton-build').onchange = () => updateSkeletonVisibility();
$('#reset-pose').onclick = () => {
  creature.resetPose();
  commit();
};

$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#spin').onclick = () => {
  controls.autoRotate = !controls.autoRotate;
  $('#spin').classList.toggle('on', controls.autoRotate);
};
$('#new').onclick = () => {
  if (!confirm('Start a new creature? (You can undo this.)')) return;
  exitDraw();
  state = defaultState(state.rig);
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
  creature.group.traverse((o) => {
    // ink hulls and felt fuzz are render-only effects; they don't belong in the model file
    const ink = o instanceof THREE.Mesh && (o.material as THREE.Material).userData?.ink;
    if ((ink || o.userData.fx) && o.visible) inks.push(o);
  });
  withCleanScene(() => {
    inks.forEach((o) => (o.visible = false));
    new GLTFExporter().parse(
      creature.group,
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
  if (tag === 'INPUT' && (e.target as HTMLInputElement).type === 'text') return;
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
  } else if (k === 's' && drawState && !e.ctrlKey && !e.metaKey) {
    toggleSymmetry();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (k === 'd' && mode === 'build') enterDraw();
    else if (k === '1') setMode('build');
    else if (k === '2') setMode('rig');
    else if (k === '3') setMode('pose');
    else if (k === 'f') frameCreature();
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
  renderOverlay();
}
new ResizeObserver(resize).observe(viewport);

function loop(now: number) {
  requestAnimationFrame(loop);
  if (tween) {
    const t = Math.min(1, (now - tween.start) / tween.dur);
    const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    camera.position.lerpVectors(tween.p0, tween.p1, k);
    controls.target.lerpVectors(tween.t0v, tween.t1v, k);
    if (t >= 1) tween = null;
  }
  controls.update();
  const f = 1 - (now - flashStart) / 700;
  creature.flash(drawState ? null : selected, Math.max(0, f));
  creature.updateMerge();
  if (drawState && !drawState.active) renderOverlay();
  (bokeh.uniforms as Record<string, THREE.IUniform>).focus.value = camera.position.distanceTo(controls.target);
  composer.render();
}

// ---------------------------------------------------------------------------
// boot

buildCreature();
commit();
renderUI();
resize();
requestAnimationFrame(loop);

// handy for poking at the scene from the dev-tools console
if (import.meta.env.DEV) Object.assign(window, { __cc: { scene, camera, controls, flyTo, screenToLocal, localToOverlay, partPlane, get creature() { return creature; } } });

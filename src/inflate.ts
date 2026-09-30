import Delaunator from 'delaunator';
import * as THREE from 'three';

export type Vec2 = [number, number];

export interface InflateOptions {
  /** 1 = round cross-section, <1 flatter, >1 puffier */
  thickness: number;
  /** coarse, jittered, flat-shaded mesh */
  lowPoly: boolean;
  /** low-poly facet size multiplier (1 = default) */
  facetScale?: number;
  /** low-poly per-facet brightness variation */
  colorJitter?: number;
  /** strength of hand-made lumps (clay); 0 = smooth */
  lumps?: number;
  seed?: number;
}

// ---------------------------------------------------------------------------
// 2D helpers

export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j][0] - poly[i][0]) * (poly[j][1] + poly[i][1]);
  }
  return a / 2;
}

export function pointInPolygon(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToPolygon(x: number, y: number, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - x;
    const ey = ay + t * dy - y;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

export function bounds(poly: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Evenly resample a closed polyline. */
export function resampleClosed(pts: Vec2[], spacing: number): Vec2[] {
  const n = pts.length;
  const seg: number[] = [];
  let per = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(l);
    per += l;
  }
  const count = Math.max(8, Math.round(per / spacing));
  const step = per / count;
  const out: Vec2[] = [];
  let i = 0;
  let acc = 0; // distance at start of segment i
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (i < n - 1 && acc + seg[i] < target) acc += seg[i++];
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const t = seg[i] > 0 ? (target - acc) / seg[i] : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function smoothClosed(pts: Vec2[], iterations: number): Vec2[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length;
    cur = cur.map((p, i) => {
      const a = cur[(i - 1 + n) % n];
      const b = cur[(i + 1) % n];
      return [p[0] * 0.5 + (a[0] + b[0]) * 0.25, p[1] * 0.5 + (a[1] + b[1]) * 0.25] as Vec2;
    });
  }
  return cur;
}

/** Tidy a raw hand-drawn stroke into an even, smooth, counter-clockwise loop. */
export function cleanOutline(raw: Vec2[], spacing: number): Vec2[] {
  const fine = resampleClosed(raw, spacing / 4);
  const smooth = smoothClosed(fine, 6);
  const out = resampleClosed(smooth, spacing);
  if (signedArea(out) < 0) out.reverse();
  return out;
}

// ---------------------------------------------------------------------------
// noise

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  ) * 2 - 1;
}

// ---------------------------------------------------------------------------
// inflation

/**
 * Turn a closed 2D outline into a puffy, closed 3D mesh lying in the XY plane,
 * inflated symmetrically along ±Z.
 *
 * Height at each interior point is the union of spheres inscribed in the
 * outline (every interior sample u contributes a sphere of radius dist(u)).
 * This gives round cross-sections everywhere: fat bodies and skinny limbs both
 * look like balloons rather than pillows.
 */
export function buildInflatedGeometry(outline: Vec2[], opts: InflateOptions): THREE.BufferGeometry {
  const raw = bounds(outline);
  const size = Math.max(raw.w, raw.h, 1e-3);
  const area = Math.max(Math.abs(signedArea(outline)), size * size * 0.002);

  const facet = opts.facetScale ?? 1;
  let s = opts.lowPoly ? Math.sqrt(area / 45) * facet : Math.sqrt(area / 650);
  s = Math.max(s, opts.lowPoly ? (size * facet) / 14 : size / 90);

  const boundary = cleanOutline(outline, s);
  const bb = bounds(boundary);
  const nb = boundary.length;
  const rand = mulberry32(opts.seed ?? 1234);

  const pts: Vec2[] = boundary.slice();
  const dist: number[] = new Array(nb).fill(0);
  const isLattice: boolean[] = new Array(nb).fill(false);

  // Inset rings hug the silhouette so the steep sides get enough vertices.
  const rings = opts.lowPoly ? [0.3] : [0.07, 0.22, 0.46];
  for (const f of rings) {
    const off = f * s;
    const accepted: Vec2[] = [];
    for (let i = 0; i < nb; i++) {
      const a = boundary[(i - 1 + nb) % nb];
      const b = boundary[(i + 1) % nb];
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const p: Vec2 = [boundary[i][0] - ty * off, boundary[i][1] + tx * off];
      if (!pointInPolygon(p[0], p[1], boundary)) continue;
      const d = distToPolygon(p[0], p[1], boundary);
      if (d < off * 0.8) continue;
      const min2 = (0.35 * s) ** 2;
      if (accepted.some((q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < min2)) continue;
      accepted.push(p);
      pts.push(p);
      dist.push(d);
      isLattice.push(false);
    }
  }

  // Hex lattice samples of the interior (x, y, distance to the silhouette),
  // centred so symmetric drawings stay symmetric.
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const lattice = (step: number, minDist: number): [number, number, number][] => {
    const out: [number, number, number][] = [];
    const rowH = (step * Math.sqrt(3)) / 2;
    const y0 = cy - Math.ceil((cy - bb.minY) / rowH) * rowH;
    for (let row = 0, y = y0; y <= bb.maxY; y += rowH, row++) {
      const shift = row % 2 ? step / 2 : 0;
      const x0 = cx + shift - Math.ceil((cx + shift - bb.minX) / step) * step;
      for (let x = x0; x <= bb.maxX; x += step) {
        if (!pointInPolygon(x, y, boundary)) continue;
        const d = distToPolygon(x, y, boundary);
        if (d >= minDist) out.push([x, y, d]);
      }
    }
    return out;
  };

  // Low-poly: the shape is measured on the same fine samples as a smooth part,
  // so its thickness is the same; only the mesh on top is coarse. Its vertices
  // are picked from those samples thickest-first, so the ridge down the middle
  // (the part's full depth) always gets vertices, then spread out a facet apart.
  let fine: [number, number, number][] = [];
  if (opts.lowPoly) {
    const fs = Math.max(Math.sqrt(area / 650), size / 90);
    fine = lattice(fs, 0.3 * fs);
    const order = fine.map((f, i) => ({ i, key: f[2] + rand() * 0.25 * s })).sort((a, b) => b.key - a.key);
    const taken: Vec2[] = [];
    const ring = pts.slice(nb);
    for (const { i } of order) {
      const [x, y, d] = fine[i];
      if (d < 0.55 * s) continue;
      if (taken.some((q) => (q[0] - x) ** 2 + (q[1] - y) ** 2 < (0.8 * s) ** 2)) continue;
      if (ring.some((q) => (q[0] - x) ** 2 + (q[1] - y) ** 2 < (0.5 * s) ** 2)) continue;
      taken.push([x, y]);
      pts.push([x, y]);
      dist.push(d);
      isLattice.push(true);
    }
  } else {
    for (const [x, y, d] of lattice(s, 0.85 * s)) {
      pts.push([x, y]);
      dist.push(d);
      isLattice.push(true);
    }
  }

  const N = pts.length;
  const coords = new Float64Array(N * 2);
  pts.forEach((p, i) => {
    coords[i * 2] = p[0];
    coords[i * 2 + 1] = p[1];
  });
  const del = new Delaunator(coords);

  // Keep triangles inside the outline, oriented counter-clockwise.
  const tris: number[] = [];
  const t = del.triangles;
  for (let k = 0; k < t.length; k += 3) {
    let a = t[k], b = t[k + 1], c = t[k + 2];
    const [ax, ay] = pts[a], [bx, by] = pts[b], [cx2, cy2] = pts[c];
    // An outline edge's midpoint lies exactly on the boundary, so only test chords.
    const isOutlineEdge = (i: number, j: number) =>
      i < nb && j < nb && (Math.abs(i - j) === 1 || Math.abs(i - j) === nb - 1);
    const midInside = (i: number, j: number) =>
      isOutlineEdge(i, j) || pointInPolygon((pts[i][0] + pts[j][0]) / 2, (pts[i][1] + pts[j][1]) / 2, boundary);
    const inside =
      pointInPolygon((ax + bx + cx2) / 3, (ay + by + cy2) / 3, boundary) &&
      midInside(a, b) &&
      midInside(b, c) &&
      midInside(c, a);
    if (!inside) continue;
    const cross = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
    if (Math.abs(cross) < 1e-12) continue;
    if (cross < 0) [b, c] = [c, b];
    tris.push(a, b, c);
  }

  // Union-of-spheres height field: every interior sample is the centre of a
  // sphere as big as its distance to the silhouette (low-poly uses the fine samples).
  const spheres: [number, number, number][] = opts.lowPoly ? fine : pts.slice(nb).map((q, i) => [q[0], q[1], dist[nb + i]]);
  const h = new Float64Array(N);
  for (let v = nb; v < N; v++) {
    const [vx, vy] = pts[v];
    let best2 = dist[v] * dist[v];
    for (const [ux, uy, du] of spheres) {
      const du2 = du * du;
      if (du2 <= best2) continue;
      const dx = ux - vx;
      const dy = uy - vy;
      const r2 = du2 - dx * dx - dy * dy;
      if (r2 > best2) best2 = r2;
    }
    h[v] = Math.sqrt(best2);
  }

  // A compact set of inscribed spheres describing the solid, used as a cheap
  // distance function when blending neighbouring parts together.
  const order = spheres.filter((q) => q[2] > 0.3 * s).sort((a, b) => b[2] - a[2]);
  const kept: number[] = [];
  for (const [ux, uy, du] of order) {
    let covered = false;
    for (let k = 0; k < kept.length; k += 3) {
      if (Math.hypot(kept[k] - ux, kept[k + 1] - uy) < 0.45 * du + 0.5 * s) {
        covered = true;
        break;
      }
    }
    if (!covered) kept.push(ux, uy, du);
    if (kept.length >= 3 * 260) break;
  }

  // Gentle smoothing of the interior to remove sphere-union ridges. Not for
  // low-poly: flat facets hide the ridges anyway, and on a coarse mesh
  // averaging with the silhouette's zero height would flatten the whole part.
  const nbrs: number[][] = Array.from({ length: N }, () => []);
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k], b = tris[k + 1], c = tris[k + 2];
    nbrs[a].push(b, c);
    nbrs[b].push(a, c);
    nbrs[c].push(a, b);
  }
  for (let pass = 0; pass < (opts.lowPoly ? 0 : 3); pass++) {
    const next = Float64Array.from(h);
    for (let v = nb; v < N; v++) {
      if (!isLattice[v] || nbrs[v].length === 0) continue;
      let sum = 0;
      for (const n of nbrs[v]) sum += h[n];
      next[v] = h[v] * 0.5 + (sum / nbrs[v].length) * 0.5;
    }
    h.set(next);
  }

  // Assemble: shared silhouette ring, front interior, back interior.
  const ni = N - nb;
  const positions = new Float32Array((nb + ni * 2) * 3);
  const front = (i: number) => (i < nb ? i : i);
  const back = (i: number) => (i < nb ? i : i + ni);
  for (let i = 0; i < N; i++) {
    const z = h[i] * opts.thickness;
    positions.set([pts[i][0], pts[i][1], z], front(i) * 3);
    if (i >= nb) positions.set([pts[i][0], pts[i][1], -z], back(i) * 3);
  }
  const index: number[] = [];
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k], b = tris[k + 1], c = tris[k + 2];
    index.push(front(a), front(b), front(c));
    index.push(back(a), back(c), back(b));
  }

  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();

  if (opts.lumps) applyLumps(geo, Math.min(size * 0.012, 0.012) * opts.lumps);

  if (opts.lowPoly) {
    geo = geo.toNonIndexed();
    geo.computeVertexNormals();
    // A little per-facet colour variation reads nicely as papercraft.
    const count = geo.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let f = 0; f < count; f += 3) {
      const j = opts.colorJitter ?? 0.14;
      const k = 1 - j * 0.7 + rand() * j;
      for (let j = 0; j < 3; j++) colors.set([k, k, k], (f + j) * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  // Planar UVs in local units; textures tile via material repeat.
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) + pos.getZ(i) * 0.35;
    uv[i * 2 + 1] = pos.getY(i) + pos.getZ(i) * 0.2;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  geo.userData.solid = { spheres: new Float32Array(kept), thickness: opts.thickness } satisfies Solid;
  // low-poly: the facet size this part was built with (a seamless skin re-facets to match)
  if (opts.lowPoly) geo.userData.facet = s;
  return geo;
}

/** Union of spheres (x, y, r triples) in the XY plane, squashed along Z by `thickness`. */
export interface Solid {
  spheres: Float32Array;
  thickness: number;
  /** per-sphere z centres, once a bend has carried the spheres out of the XY plane */
  zs?: Float32Array;
}

/**
 * Approximate signed distance from local point (x, y, z) to a Solid, plus the
 * outward gradient written into `grad`. Negative inside.
 */
export function solidDistance(solid: Solid, x: number, y: number, z: number, grad: THREE.Vector3): number {
  const t = Math.max(solid.thickness, 0.05);
  const sp = solid.spheres;
  const zc = solid.zs;
  let best = Infinity;
  let bi = -1;
  let bl = 1;
  let bz = 0;
  for (let i = 0; i < sp.length; i += 3) {
    const dx = x - sp[i], dy = y - sp[i + 1];
    const dz = (z - (zc ? zc[i / 3] : 0)) / t;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const d = l - sp[i + 2];
    if (d < best) {
      best = d;
      bi = i;
      bl = l;
      bz = dz;
    }
  }
  if (bi < 0) {
    grad.set(0, 0, 1);
    return Infinity;
  }
  grad.set(x - sp[bi], y - sp[bi + 1], bz / t).divideScalar(bl || 1).normalize();
  return best * Math.min(1, t);
}

/** Hand-moulded clay lumps: push each vertex in or out along its normal by smooth noise. */
export function applyLumps(geo: THREE.BufferGeometry, amp: number) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const freq = 9;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = valueNoise3(x * freq, y * freq, z * freq) + 0.5 * valueNoise3(x * freq * 2.3, y * freq * 2.3, z * freq * 2.3);
    pos.setXYZ(i, x + nor.getX(i) * n * amp, y + nor.getY(i) * n * amp, z + nor.getZ(i) * n * amp);
  }
  geo.computeVertexNormals();
}

/** Default capsule-ish outline running along +Y from 0 to length. */
export function defaultOutline(length: number, width: number, widthEnd = width): Vec2[] {
  const out: Vec2[] = [];
  const ry = length / 2 + ((width + widthEnd) / 2) * 0.28;
  const cy = length / 2;
  const n = 64;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // slight superellipse so limbs look like sausages, not pointy ellipses
    const c = Math.cos(a), sn = Math.sin(a);
    const e = 0.8;
    const y = cy + ry * Math.sign(sn) * Math.abs(sn) ** e;
    // taper from the base width to the tip width along the bone
    const t = Math.min(1, Math.max(0, (y - (cy - ry)) / (2 * ry)));
    const rx = (width + (widthEnd - width) * t) / 2;
    out.push([rx * Math.sign(c) * Math.abs(c) ** e, y]);
  }
  return out;
}

/**
 * Keep the part of a closed loop below (or above) the horizontal line y = h
 * (Sutherland-Hodgman against one half-plane). Returns null if nothing is left.
 */
export function clipLoop(loop: Vec2[], h: number, keep: 'below' | 'above'): Vec2[] | null {
  const inside = (p: Vec2) => (keep === 'below' ? p[1] <= h : p[1] >= h);
  const cut = (a: Vec2, b: Vec2): Vec2 => {
    const t = (h - a[1]) / (b[1] - a[1]);
    return [a[0] + (b[0] - a[0]) * t, h];
  };
  const out: Vec2[] = [];
  for (let i = 0; i < loop.length; i++) {
    const cur = loop[i], prev = loop[(i + loop.length - 1) % loop.length];
    if (inside(cur)) {
      if (!inside(prev)) out.push(cut(prev, cur));
      out.push(cur);
    } else if (inside(prev)) {
      out.push(cut(prev, cur));
    }
  }
  return out.length >= 3 ? out : null;
}

// ---------------------------------------------------------------------------
// drawing helpers

/**
 * Make a loop mirror-symmetric about x = 0. Keeps the half that has most of
 * the drawing: either the longest stretch between two axis crossings, or (if
 * the stroke never crosses) the whole stroke with its ends pinned to the axis,
 * so drawing just one half works.
 */
export function symmetrize(loop: Vec2[]): Vec2[] {
  const n = loop.length;
  if (n < 3) return loop;
  let sx = 0;
  for (const p of loop) sx += p[0];
  const side = sx >= 0 ? 1 : -1;
  const f = (p: Vec2) => p[0] * side;

  const crossings: number[] = [];
  for (let i = 0; i < n; i++) {
    if (f(loop[i]) > 0 !== f(loop[(i + 1) % n]) > 0) crossings.push(i);
  }
  const onAxis = (i: number): Vec2 => {
    const a = loop[i], b = loop[(i + 1) % n];
    const fa = f(a), fb = f(b);
    const t = fa === fb ? 0 : fa / (fa - fb);
    return [0, a[1] + (b[1] - a[1]) * t];
  };

  let chain: Vec2[] | null = null;
  if (crossings.length < 2) {
    const half = loop.filter((p) => f(p) > 0);
    if (half.length < 3) return loop;
    chain = [[0, half[0][1]], ...half, [0, half[half.length - 1][1]]];
  } else {
    let bestLen = -1;
    for (let k = 0; k < crossings.length; k++) {
      const i0 = crossings[k];
      const i1 = crossings[(k + 1) % crossings.length];
      if (f(loop[(i0 + 1) % n]) <= 0) continue; // this stretch is on the other side
      const run: Vec2[] = [onAxis(i0)];
      for (let j = (i0 + 1) % n; ; j = (j + 1) % n) {
        run.push(loop[j]);
        if (j === i1) break;
      }
      run.push(onAxis(i1));
      let len = 0;
      for (let j = 1; j < run.length; j++) len += Math.hypot(run[j][0] - run[j - 1][0], run[j][1] - run[j - 1][1]);
      if (len > bestLen) {
        bestLen = len;
        chain = run;
      }
    }
    if (!chain) return loop;
  }
  const mirrored = chain.slice(1, -1).reverse().map(([x, y]) => [-x, y] as Vec2);
  return [...chain, ...mirrored];
}

/**
 * Add `loops` to a shape (outer loops plus holes), or cut them out of it.
 * Everything is drawn into a fine grid and the result traced back into loops
 * (marching squares), which copes with any hand-drawn mess: self-crossings,
 * strokes that split the shape in two, cuts that leave a hole.
 */
export function combineLoops(outers: Vec2[][], holes: Vec2[][], loops: Vec2[][], cut: boolean): { outers: Vec2[][]; holes: Vec2[][] } {
  const all = cut ? outers : [...outers, ...loops];
  const bb = bounds(all.flat());
  const size = Math.max(bb.w, bb.h, 1e-3);
  const cell = size / 400;
  // a border of empty cells so every traced loop closes
  const x0 = bb.minX - 3 * cell, y0 = bb.minY - 3 * cell;
  const W = Math.ceil(bb.w / cell) + 7, H = Math.ceil(bb.h / cell) + 7;
  const mask = new Uint8Array(W * H);

  const fill = (loop: Vec2[], v: number) => {
    const xs: number[] = [];
    for (let j = 0; j < H; j++) {
      const y = y0 + (j + 0.5) * cell;
      xs.length = 0;
      for (let a = 0, b = loop.length - 1; a < loop.length; b = a++) {
        const [xa, ya] = loop[a], [xb, yb] = loop[b];
        if (ya > y !== yb > y) xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5));
        const i1 = Math.min(W - 1, Math.floor((xs[k + 1] - x0) / cell - 0.5));
        for (let i = i0; i <= i1; i++) mask[j * W + i] = v;
      }
    }
  };
  for (const l of outers) fill(l, 1);
  for (const l of holes) fill(l, 0);
  for (const l of loops) fill(l, cut ? 0 : 1);

  // Marching squares over the cell centres. Each square yields segments
  // between edge midpoints, directed so the filled side is on the left: outer
  // loops come out counter-clockwise, holes clockwise. Edge ids: horizontal
  // edge from sample (i, j) = 2 * (j * W + i), vertical = that + 1.
  const at = (i: number, j: number) => mask[j * W + i];
  const next = new Map<number, number>();
  const hE = (i: number, j: number) => 2 * (j * W + i);
  const vE = (i: number, j: number) => 2 * (j * W + i) + 1;
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const c = at(i, j) | (at(i + 1, j) << 1) | (at(i + 1, j + 1) << 2) | (at(i, j + 1) << 3);
      if (c === 0 || c === 15) continue;
      const b = hE(i, j), t = hE(i, j + 1), l = vE(i, j), r = vE(i + 1, j);
      const seg = (from: number, to: number) => next.set(from, to);
      switch (c) {
        case 1: seg(b, l); break;
        case 2: seg(r, b); break;
        case 3: seg(r, l); break;
        case 4: seg(t, r); break;
        case 5: seg(b, l); seg(t, r); break;
        case 6: seg(t, b); break;
        case 7: seg(t, l); break;
        case 8: seg(l, t); break;
        case 9: seg(b, t); break;
        case 10: seg(r, b); seg(l, t); break;
        case 11: seg(r, t); break;
        case 12: seg(l, r); break;
        case 13: seg(b, r); break;
        case 14: seg(l, b); break;
      }
    }
  }
  const point = (e: number): Vec2 => {
    const k = e >> 1, i = k % W, j = (k - i) / W;
    return e & 1 ? [x0 + (i + 0.5) * cell, y0 + (j + 1) * cell] : [x0 + (i + 1) * cell, y0 + (j + 0.5) * cell];
  };

  const out = { outers: [] as Vec2[][], holes: [] as Vec2[][] };
  const minArea = (cell * 4) ** 2;
  for (const start of [...next.keys()]) {
    if (!next.has(start)) continue;
    const loop: Vec2[] = [];
    let e = start;
    while (next.has(e)) {
      loop.push(point(e));
      const n = next.get(e)!;
      next.delete(e);
      e = n;
    }
    const area = signedArea(loop);
    if (Math.abs(area) < minArea || loop.length < 8) continue;
    // soften the grid's stair steps (Taubin: no shrinking), keeping detail
    let s = resampleClosed(loop, cell * 4);
    for (let p = 0; p < 3; p++) {
      for (const k of [0.5, -0.53]) {
        s = s.map((q, i) => {
          const a = s[(i - 1 + s.length) % s.length], c = s[(i + 1) % s.length];
          return [q[0] + k * ((a[0] + c[0]) / 2 - q[0]), q[1] + k * ((a[1] + c[1]) / 2 - q[1])] as Vec2;
        });
      }
    }
    s = s.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4] as Vec2);
    (area > 0 ? out.outers : out.holes).push(area > 0 ? s : s.reverse());
  }
  // biggest first: a body part keeps the main piece
  out.outers.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  return out;
}

/** Taubin smoothing of a closed loop: removes wobble without shrinking it. */
export function smoothLoop(loop: Vec2[], strength: number): Vec2[] {
  if (strength <= 0 || loop.length < 8) return loop;
  let per = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    per += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  let cur = resampleClosed(loop, per / 160);
  const passes = Math.round(strength * 40);
  const step = (pts: Vec2[], k: number) =>
    pts.map((p, i) => {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[(i + 1) % pts.length];
      return [p[0] + k * ((a[0] + b[0]) / 2 - p[0]), p[1] + k * ((a[1] + b[1]) / 2 - p[1])] as Vec2;
    });
  for (let i = 0; i < passes; i++) cur = step(step(cur, 0.5), -0.53);
  return cur.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4] as Vec2);
}

import * as THREE from 'three';
import { bvhFor, exactDistance, sharedNormals } from './distance';
import { applyLumps } from './inflate';

/**
 * Seamless skins: rebuild a group of merged parts as ONE continuous surface.
 *
 * The fast merge reshapes each part's own triangles at its joins, which can
 * leave hairline cracks where triangles straddle a join. Here we instead
 * sample the smooth union of every part's exact signed distance on a grid
 * (only near the surface) and extract a single mesh with surface nets, so
 * there is nothing to crack. It's slower, so it runs in small chunks when the
 * creature has been left alone for a moment, and is thrown away on any change.
 */

export interface SkinPart {
  /** the part's shape, in its own local space */
  geo: THREE.BufferGeometry;
  /** part local space -> skin space */
  toSkin: THREE.Matrix4;
  color: THREE.Color;
  /** fillet size where this part joins others */
  k: number;
}

export interface SkinOptions {
  /** grid spacing (world units): smaller = more detail, slower */
  h: number;
  /** width of the colour fade between differently coloured parts; 0 = one colour */
  colorBlend: number;
  lowPoly: boolean;
  /** clay lump strength to add back onto the finished skin (0 = none) */
  lumps?: number;
  /** polled between chunks: return true to abandon the build */
  shouldStop: () => boolean;
}

interface Prepared {
  geo: THREE.BufferGeometry;
  bvh: ReturnType<typeof bvhFor>;
  normals: THREE.BufferAttribute;
  fromSkin: THREE.Matrix4;
  box: THREE.Box3; // skin space, padded
  color: THREE.Color;
  k: number;
}

// Yield to the page between chunks via a message, not a timer: timers are
// clamped (and slowed to ~1/s in background tabs), messages aren't.
const channel = new MessageChannel();
const waiting: (() => void)[] = [];
channel.port1.onmessage = () => waiting.shift()?.();
const yieldFrame = () =>
  new Promise<void>((resolve) => {
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });

/** Build the skin geometry (in skin space), or null if abandoned. */
export async function buildSkin(parts: SkinPart[], opts: SkinOptions): Promise<THREE.BufferGeometry | null> {
  const h = opts.h;
  const kMax = Math.max(...parts.map((p) => p.k));
  // distances further than this don't matter for the surface
  const band = h * 4 * Math.sqrt(3) + kMax;

  const prepared: Prepared[] = parts.map((p) => {
    p.geo.computeBoundingBox();
    const box = p.geo.boundingBox!.clone().applyMatrix4(p.toSkin).expandByScalar(band);
    return {
      geo: p.geo,
      bvh: bvhFor(p.geo),
      normals: sharedNormals(p.geo),
      fromSkin: p.toSkin.clone().invert(),
      box,
      color: p.color,
      k: p.k,
    };
  });

  const q = new THREE.Vector3();
  const grad = new THREE.Vector3();
  const pt = new THREE.Vector3();

  /** Signed distance to one part; `exact` resolves far points too (for inside/outside). */
  const partDistance = (pp: Prepared, p: THREE.Vector3, exact: boolean): number => {
    if (!pp.box.containsPoint(p)) return Infinity;
    q.copy(p).applyMatrix4(pp.fromSkin);
    const d = exactDistance(pp.geo, pp.bvh, pp.normals, q, band, grad);
    if (Number.isFinite(d) || !exact) return d;
    // far from this part: all we need is which side of it we're on
    return insidePart(pp, q) ? -band : band;
  };

  // one ray: if the first surface it meets faces away from us, we're inside
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0.577, 0.577, 0.577));
  const fa = new THREE.Vector3(), fb = new THREE.Vector3(), fc = new THREE.Vector3(), fn = new THREE.Vector3();
  const insidePart = (pp: Prepared, local: THREE.Vector3): boolean => {
    ray.origin.copy(local);
    const hit = pp.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit?.face) return false;
    const pos = pp.geo.getAttribute('position') as THREE.BufferAttribute;
    fa.fromBufferAttribute(pos, hit.face.a);
    fb.fromBufferAttribute(pos, hit.face.b);
    fc.fromBufferAttribute(pos, hit.face.c);
    fn.subVectors(fb, fa).cross(fc.sub(fa));
    return fn.dot(ray.direction) > 0;
  };

  /** The blended field: polynomial smooth-min of every part's distance. NaN = far from everything. */
  const field = (p: THREE.Vector3, exact: boolean): number => {
    let f = Infinity;
    let any = false;
    for (const pp of prepared) {
      const d = partDistance(pp, p, exact);
      if (!Number.isFinite(d)) continue;
      any = true;
      if (!Number.isFinite(f)) {
        f = d;
        continue;
      }
      const k = pp.k;
      const t = Math.min(1, Math.max(0, 0.5 + (0.5 * (d - f)) / k));
      f = d * (1 - t) + f * t - k * t * (1 - t);
    }
    return any ? f : NaN;
  };

  // grid over everything, padded so the surface never touches the edge
  const bounds = new THREE.Box3();
  for (const pp of prepared) bounds.union(pp.box);
  const origin = bounds.min.clone();
  const size = bounds.getSize(new THREE.Vector3());
  const nx = Math.ceil(size.x / h) + 1, ny = Math.ceil(size.y / h) + 1, nz = Math.ceil(size.z / h) + 1;
  if (nx * ny * nz > 12e6) return null; // absurdly large: don't try
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const values = new Float32Array(nx * ny * nz).fill(NaN);

  let slice = performance.now();
  let tick = 0;
  const breathe = async (): Promise<boolean> => {
    if ((++tick & 63) !== 0 && performance.now() - slice < 8) return false;
    if (performance.now() - slice < 8) return false;
    await yieldFrame();
    slice = performance.now();
    return opts.shouldStop();
  };

  // 1. coarse pass: find the blocks the surface can pass through
  const C = 4;
  const cx = Math.ceil((nx - 1) / C) + 1, cy = Math.ceil((ny - 1) / C) + 1, cz = Math.ceil((nz - 1) / C) + 1;
  const coarse = new Float32Array(cx * cy * cz);
  const reach = C * h * Math.sqrt(3) * 1.05;
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        pt.set(origin.x + Math.min(i * C, nx - 1) * h, origin.y + Math.min(j * C, ny - 1) * h, origin.z + Math.min(k * C, nz - 1) * h);
        coarse[i + cx * (j + cy * k)] = field(pt, false);
        if (await breathe()) return null;
      }
    }
  }

  // 2. fine pass inside blocks near the surface. Per block, first work out
  // which parts matter: parts far from the block are dropped, and a block
  // buried deep inside some part is skipped outright (it's hidden anyway).
  const halfDiag = (C * h * Math.sqrt(3)) / 2;
  const center = new THREE.Vector3();
  const rel: Prepared[] = [];
  const relSide: number[] = [];
  for (let bk = 0; bk < cz - 1; bk++) {
    for (let bj = 0; bj < cy - 1; bj++) {
      for (let bi = 0; bi < cx - 1; bi++) {
        let near = false;
        for (let c = 0; c < 8 && !near; c++) {
          const v = coarse[bi + (c & 1) + cx * (bj + ((c >> 1) & 1) + cy * (bk + ((c >> 2) & 1)))];
          if (!Number.isNaN(v) && Math.abs(v) < reach) near = true;
        }
        if (!near) continue;

        center.set(origin.x + (bi + 0.5) * C * h, origin.y + (bj + 0.5) * C * h, origin.z + (bk + 0.5) * C * h);
        rel.length = 0;
        relSide.length = 0;
        let buried = false;
        for (const pp of prepared) {
          if (!pp.box.containsPoint(center) && pp.box.distanceToPoint(center) > halfDiag) continue;
          q.copy(center).applyMatrix4(pp.fromSkin);
                const d = exactDistance(pp.geo, pp.bvh, pp.normals, q, band + halfDiag, grad);
          if (Number.isFinite(d)) {
            rel.push(pp);
            relSide.push(d < 0 ? -1 : 1);
          } else {
                    if (insidePart(pp, q)) {
              buried = true;
              break;
            }
          }
        }

        for (let k = bk * C; k <= Math.min((bk + 1) * C, nz - 1); k++) {
          for (let j = bj * C; j <= Math.min((bj + 1) * C, ny - 1); j++) {
            for (let i = bi * C; i <= Math.min((bi + 1) * C, nx - 1); i++) {
              const idx = at(i, j, k);
              if (!Number.isNaN(values[idx])) continue;
              if (buried || !rel.length) {
                values[idx] = buried ? -band : band;
                continue;
              }
              pt.set(origin.x + i * h, origin.y + j * h, origin.z + k * h);
              // smooth union over just the parts near this block
              let f = Infinity;
              for (let r = 0; r < rel.length; r++) {
                const pp = rel[r];
                q.copy(pt).applyMatrix4(pp.fromSkin);
                            // only distances within the join size (plus a couple of cells) shape the surface
                const reachP = pp.k + 2.5 * h;
                let d = exactDistance(pp.geo, pp.bvh, pp.normals, q, reachP, grad);
                // beyond reach from this node: same side as the block centre
                if (!Number.isFinite(d)) d = relSide[r] * reachP;
                if (!Number.isFinite(f)) {
                  f = d;
                  continue;
                }
                const t = Math.min(1, Math.max(0, 0.5 + (0.5 * (d - f)) / pp.k));
                f = d * (1 - t) + f * t - pp.k * t * (1 - t);
              }
              values[idx] = f;
            }
          }
        }
        if (await breathe()) return null;
      }
    }
  }

  // 3. surface nets: one vertex per cell the surface crosses, at the mean of its edge crossings
  const cellIndex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cellAt = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const positions: number[] = [];
  const corner = new Float32Array(8);
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7], // x
    [0, 2], [1, 3], [4, 6], [5, 7], // y
    [0, 4], [1, 5], [2, 6], [3, 7], // z
  ];
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let inside = 0, known = true;
        for (let c = 0; c < 8; c++) {
          const v = values[at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          if (Number.isNaN(v)) {
            known = false;
            break;
          }
          corner[c] = v;
          if (v < 0) inside++;
        }
        if (!known || inside === 0 || inside === 8) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += (a & 1) + (((b & 1) - (a & 1)) * t);
          sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t);
          sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t);
          n++;
        }
        cellIndex[cellAt(i, j, k)] = positions.length / 3;
        positions.push(origin.x + (i + sx / n) * h, origin.y + (j + sy / n) * h, origin.z + (k + sz / n) * h);
      }
    }
    if (await breathe()) return null;
  }

  // one quad per grid edge the surface crosses, joining the four cells around it
  const index: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, c, b, a, d, c);
    else index.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const v0 = values[at(i, j, k)];
        if (Number.isNaN(v0)) continue;
        const neg = v0 < 0;
        const vx = values[at(i + 1, j, k)];
        if (!Number.isNaN(vx) && vx < 0 !== neg) {
          quad(cellIndex[cellAt(i, j - 1, k - 1)], cellIndex[cellAt(i, j, k - 1)], cellIndex[cellAt(i, j, k)], cellIndex[cellAt(i, j - 1, k)], !neg);
        }
        const vy = values[at(i, j + 1, k)];
        if (!Number.isNaN(vy) && vy < 0 !== neg) {
          quad(cellIndex[cellAt(i - 1, j, k - 1)], cellIndex[cellAt(i - 1, j, k)], cellIndex[cellAt(i, j, k)], cellIndex[cellAt(i, j, k - 1)], !neg);
        }
        const vz = values[at(i, j, k + 1)];
        if (!Number.isNaN(vz) && vz < 0 !== neg) {
          quad(cellIndex[cellAt(i - 1, j - 1, k)], cellIndex[cellAt(i, j - 1, k)], cellIndex[cellAt(i, j, k)], cellIndex[cellAt(i - 1, j, k)], !neg);
        }
      }
    }
    if (await breathe()) return null;
  }
  if (!index.length) return null;
  const kept = dropSpecks(index, positions.length / 3);
  if (!kept.length) return null;
  index.length = 0;
  for (const t of kept) index.push(t);

  // 4. gentle Taubin smoothing to soften the grid (without shrinking)
  const count = positions.length / 3;
  const nbrs: number[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    nbrs[a].push(b, c);
    nbrs[b].push(a, c);
    nbrs[c].push(a, b);
  }
  const pos = new Float32Array(positions);
  const tmp = new Float32Array(pos.length);
  const pass = (lambda: number) => {
    for (let v = 0; v < count; v++) {
      const ns = nbrs[v];
      if (!ns.length) {
        tmp.set(pos.subarray(v * 3, v * 3 + 3), v * 3);
        continue;
      }
      let ax = 0, ay = 0, az = 0;
      for (const n of ns) {
        ax += pos[n * 3];
        ay += pos[n * 3 + 1];
        az += pos[n * 3 + 2];
      }
      const m = 1 / ns.length;
      tmp[v * 3] = pos[v * 3] + lambda * (ax * m - pos[v * 3]);
      tmp[v * 3 + 1] = pos[v * 3 + 1] + lambda * (ay * m - pos[v * 3 + 1]);
      tmp[v * 3 + 2] = pos[v * 3 + 2] + lambda * (az * m - pos[v * 3 + 2]);
    }
    pos.set(tmp);
  };
  for (let it = 0; it < 3; it++) {
    pass(0.5);
    pass(-0.53);
  }

  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  if (opts.lumps) applyLumps(geo, opts.lumps);

  if (opts.lowPoly) {
    geo = geo.toNonIndexed();
    geo.computeVertexNormals();
  }
  if (await breathe()) return null;
  geo.userData.painted = paintSkin(geo, parts, opts.colorBlend, opts.lowPoly);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Remove tiny disconnected pieces (a few stray triangles where the field
 * was ambiguous), keeping every real piece of the surface.
 */
function dropSpecks(index: number[], vertexCount: number): number[] {
  const parent = new Int32Array(vertexCount).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let t = 0; t < index.length; t += 3) {
    const a = find(index[t]), b = find(index[t + 1]), c = find(index[t + 2]);
    parent[b] = a;
    parent[find(c)] = a;
  }
  const tris = new Map<number, number>();
  for (let t = 0; t < index.length; t += 3) {
    const r = find(index[t]);
    tris.set(r, (tris.get(r) ?? 0) + 1);
  }
  const largest = Math.max(...tris.values());
  const minTris = Math.max(24, largest * 0.01);
  const out: number[] = [];
  for (let t = 0; t < index.length; t += 3) {
    if ((tris.get(find(index[t])) ?? 0) >= minTris) out.push(index[t], index[t + 1], index[t + 2]);
  }
  return out;
}

/**
 * (Re)colour a skin: blended part colours near the seams (when blending and
 * the colours differ) and per-facet shading for low-poly. Returns whether
 * colours were baked in (the material should then be white). Cheap next to a
 * rebuild, so a colour-only change repaints the existing skin.
 */
export function paintSkin(geo: THREE.BufferGeometry, parts: SkinPart[], colorBlend: number, lowPoly: boolean): boolean {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const blend = colorBlend > 0 && parts.some((p) => !p.color.equals(parts[0].color));
  if (!blend && !lowPoly) {
    if (geo.getAttribute('color')) geo.deleteAttribute('color');
    return false;
  }
  const colors = new Float32Array(n * 3).fill(1);

  if (blend) {
    const kc = colorBlend;
    const prepared = parts.map((p) => ({
      p,
      bvh: bvhFor(p.geo),
      normals: sharedNormals(p.geo),
      fromSkin: p.toSkin.clone().invert(),
      box: p.geo.boundingBox!.clone().applyMatrix4(p.toSkin).expandByScalar(2 * kc),
    }));
    const pt = new THREE.Vector3(), q = new THREE.Vector3(), grad = new THREE.Vector3();
    const c = new THREE.Color();
    for (let v = 0; v < n; v++) {
      pt.fromBufferAttribute(pos, v);
      let wsum = 0;
      c.setRGB(0, 0, 0);
      let nearest = 0, nearestD = Infinity;
      for (let i = 0; i < prepared.length; i++) {
        const pp = prepared[i];
        if (!pp.box.containsPoint(pt)) continue;
        q.copy(pt).applyMatrix4(pp.fromSkin);
        const d = exactDistance(pp.p.geo, pp.bvh, pp.normals, q, 2 * kc, grad);
        if (!Number.isFinite(d)) continue;
        if (d < nearestD) {
          nearestD = d;
          nearest = i;
        }
        // 50/50 where two parts are equally close, each part's own colour away from the seam
        const w = 1 / (Math.max(d, 0) + 0.25 * kc) ** 2;
        c.r += pp.p.color.r * w;
        c.g += pp.p.color.g * w;
        c.b += pp.p.color.b * w;
        wsum += w;
      }
      if (wsum > 0) c.multiplyScalar(1 / wsum);
      else c.copy(prepared[nearest].p.color);
      colors[v * 3] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
  }

  if (lowPoly) {
    // per-facet shade variation, multiplied into any blended colour
    for (let f = 0; f < n; f += 3) {
      const k = 0.9 + ((((Math.sin(f * 12.9898) * 43758.5453) % 1) + 1) % 1) * 0.14;
      for (let j = 0; j < 9 && f * 3 + j < colors.length; j++) colors[f * 3 + j] *= k;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return blend;
}

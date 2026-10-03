import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
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
  /** low-poly: this part's facet size */
  facet?: number;
  /** part local space -> the creature's rest pose, where textures are laid out */
  toRest?: THREE.Matrix4;
}

export interface SkinOptions {
  /** grid spacing (world units): smaller = more detail, slower */
  h: number;
  /** width of the color fade between differently colored parts; 0 = one color */
  colorBlend: number;
  lowPoly: boolean;
  /** clay lump strength to add back onto the finished skin (0 = none) */
  lumps?: number;
  /** polled between chunks: return true to abandon the build */
  shouldStop: () => boolean;
}

interface Prepared {
  facet?: number;
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
      facet: p.facet,
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

  // The grid is sparse: it's cut into C^3-cell blocks and only blocks the
  // surface passes near are ever stored, so thin parts (a fine grid) on a big
  // creature cost surface area, not volume.
  const C = 4;
  const bx = Math.ceil((nx - 1) / C), by = Math.ceil((ny - 1) / C), bz = Math.ceil((nz - 1) / C);
  const cx = bx + 1, cy = by + 1, cz = bz + 1;
  if (cx * cy * cz > 6e6) return null; // absurdly large: don't try

  let slice = performance.now();
  let tick = 0;
  const breathe = async (): Promise<boolean> => {
    if ((++tick & 63) !== 0 && performance.now() - slice < 8) return false;
    if (performance.now() - slice < 8) return false;
    await yieldFrame();
    slice = performance.now();
    return opts.shouldStop();
  };

  // node (i, j, k) is stored in block (i/C, j/C, k/C); cells likewise
  const blockKey = (i: number, j: number, k: number) => ((i / C) | 0) + cx * (((j / C) | 0) + cy * ((k / C) | 0));
  const local = (i: number, j: number, k: number) => (i % C) + C * ((j % C) + C * (k % C));
  const nodes = new Map<number, Float32Array>();
  const getNode = (i: number, j: number, k: number): number => {
    const b = nodes.get(blockKey(i, j, k));
    return b ? b[local(i, j, k)] : NaN;
  };
  const setNode = (i: number, j: number, k: number, v: number) => {
    const key = blockKey(i, j, k);
    let b = nodes.get(key);
    if (!b) nodes.set(key, (b = new Float32Array(C * C * C).fill(NaN)));
    b[local(i, j, k)] = v;
  };
  const cells = new Map<number, Int32Array>();
  const getCell = (i: number, j: number, k: number): number => cells.get(blockKey(i, j, k))?.[local(i, j, k)] ?? -1;
  const setCell = (i: number, j: number, k: number, v: number) => {
    const key = blockKey(i, j, k);
    let b = cells.get(key);
    if (!b) cells.set(key, (b = new Int32Array(C * C * C).fill(-1)));
    b[local(i, j, k)] = v;
  };

  // The grid samples the shape grown by half a cell: a point thinner than a
  // cell (a horn's tip) would otherwise fall between the samples and be cut
  // off. Step 4b shrinks every vertex back onto the true surface, which pulls
  // the grown tip back in to a sharp point.
  const grown = 0.5 * h;

  // 1. coarse pass: find the blocks the surface can pass through
  const coarse = new Float32Array(cx * cy * cz);
  const reach = C * h * Math.sqrt(3) * 1.05;
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        pt.set(origin.x + Math.min(i * C, nx - 1) * h, origin.y + Math.min(j * C, ny - 1) * h, origin.z + Math.min(k * C, nz - 1) * h);
        coarse[i + cx * (j + cy * k)] = field(pt, false) - grown;
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
  /** the part is out of reach from every node in the block: its distance there is just ±reach */
  const relFar: boolean[] = [];
  const active: number[] = [];
  for (let bk = 0; bk < bz; bk++) {
    for (let bj = 0; bj < by; bj++) {
      for (let bi = 0; bi < bx; bi++) {
        let near = false;
        for (let c = 0; c < 8 && !near; c++) {
          const v = coarse[bi + (c & 1) + cx * (bj + ((c >> 1) & 1) + cy * (bk + ((c >> 2) & 1)))];
          if (!Number.isNaN(v) && Math.abs(v) < reach) near = true;
        }
        if (!near) continue;
        active.push(bi, bj, bk);

        center.set(origin.x + (bi + 0.5) * C * h, origin.y + (bj + 0.5) * C * h, origin.z + (bk + 0.5) * C * h);
        rel.length = 0;
        relSide.length = 0;
        relFar.length = 0;
        let buried = false;
        for (const pp of prepared) {
          if (!pp.box.containsPoint(center) && pp.box.distanceToPoint(center) > halfDiag) continue;
          q.copy(center).applyMatrix4(pp.fromSkin);
          const d = exactDistance(pp.geo, pp.bvh, pp.normals, q, band + halfDiag, grad);
          if (Number.isFinite(d)) {
            rel.push(pp);
            relSide.push(d < 0 ? -1 : 1);
            relFar.push(Math.abs(d) - halfDiag > pp.k + 2.5 * h);
          } else if (insidePart(pp, q)) {
            buried = true;
            break;
          }
        }

        for (let k = bk * C; k <= Math.min((bk + 1) * C, nz - 1); k++) {
          for (let j = bj * C; j <= Math.min((bj + 1) * C, ny - 1); j++) {
            for (let i = bi * C; i <= Math.min((bi + 1) * C, nx - 1); i++) {
              if (!Number.isNaN(getNode(i, j, k))) continue;
              if (buried || !rel.length) {
                setNode(i, j, k, buried ? -band : band);
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
                let d = relFar[r] ? Infinity : exactDistance(pp.geo, pp.bvh, pp.normals, q, reachP, grad);
                // beyond reach from this node: same side as the block centre
                if (!Number.isFinite(d)) d = relSide[r] * reachP;
                if (!Number.isFinite(f)) {
                  f = d;
                  continue;
                }
                const t = Math.min(1, Math.max(0, 0.5 + (0.5 * (d - f)) / pp.k));
                f = d * (1 - t) + f * t - pp.k * t * (1 - t);
              }
              setNode(i, j, k, f - grown);
            }
          }
        }
        if (await breathe()) return null;
      }
    }
  }

  // a block's (C+1)^3 corner nodes, copied out of the sparse store
  const S = C + 1;
  const scratch = new Float32Array(S * S * S);
  const loadBlock = (bi: number, bj: number, bk: number) => {
    for (let k = 0; k < S; k++) {
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          const gi = bi * C + i, gj = bj * C + j, gk = bk * C + k;
          scratch[i + S * (j + S * k)] = gi < nx && gj < ny && gk < nz ? getNode(gi, gj, gk) : NaN;
        }
      }
    }
  };
  const at = (li: number, lj: number, lk: number) => scratch[li + S * (lj + S * lk)];

  // 3. surface nets: one vertex per cell the surface crosses, at the mean of its edge crossings
  const positions: number[] = [];
  const corner = new Float32Array(8);
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7], // x
    [0, 2], [1, 3], [4, 6], [5, 7], // y
    [0, 4], [1, 5], [2, 6], [3, 7], // z
  ];
  for (let a = 0; a < active.length; a += 3) {
    const bi = active[a], bj = active[a + 1], bk = active[a + 2];
    loadBlock(bi, bj, bk);
    for (let lk = 0; lk < C; lk++) {
      for (let lj = 0; lj < C; lj++) {
        for (let li = 0; li < C; li++) {
          const i = bi * C + li, j = bj * C + lj, k = bk * C + lk;
          if (i >= nx - 1 || j >= ny - 1 || k >= nz - 1) continue;
          let inside = 0, known = true;
          for (let c = 0; c < 8; c++) {
            const v = at(li + (c & 1), lj + ((c >> 1) & 1), lk + ((c >> 2) & 1));
            if (Number.isNaN(v)) {
              known = false;
              break;
            }
            corner[c] = v;
            if (v < 0) inside++;
          }
          if (!known || inside === 0 || inside === 8) continue;
          let sx = 0, sy = 0, sz = 0, n = 0;
          for (const [ea, eb] of EDGES) {
            const va = corner[ea], vb = corner[eb];
            if (va < 0 === vb < 0) continue;
            const t = va / (va - vb);
            sx += (ea & 1) + (((eb & 1) - (ea & 1)) * t);
            sy += ((ea >> 1) & 1) + ((((eb >> 1) & 1) - ((ea >> 1) & 1)) * t);
            sz += ((ea >> 2) & 1) + ((((eb >> 2) & 1) - ((ea >> 2) & 1)) * t);
            n++;
          }
          setCell(i, j, k, positions.length / 3);
          positions.push(origin.x + (i + sx / n) * h, origin.y + (j + sy / n) * h, origin.z + (k + sz / n) * h);
        }
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
  for (let a = 0; a < active.length; a += 3) {
    const bi = active[a], bj = active[a + 1], bk = active[a + 2];
    loadBlock(bi, bj, bk);
    for (let lk = 0; lk < C; lk++) {
      for (let lj = 0; lj < C; lj++) {
        for (let li = 0; li < C; li++) {
          const i = bi * C + li, j = bj * C + lj, k = bk * C + lk;
          if (i < 1 || j < 1 || k < 1 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) continue;
          const v0 = at(li, lj, lk);
          if (Number.isNaN(v0)) continue;
          const neg = v0 < 0;
          const vx = at(li + 1, lj, lk);
          if (!Number.isNaN(vx) && vx < 0 !== neg) {
            quad(getCell(i, j - 1, k - 1), getCell(i, j, k - 1), getCell(i, j, k), getCell(i, j - 1, k), !neg);
          }
          const vy = at(li, lj + 1, lk);
          if (!Number.isNaN(vy) && vy < 0 !== neg) {
            quad(getCell(i - 1, j, k - 1), getCell(i - 1, j, k), getCell(i, j, k), getCell(i, j, k - 1), !neg);
          }
          const vz = at(li, lj, lk + 1);
          if (!Number.isNaN(vz) && vz < 0 !== neg) {
            quad(getCell(i - 1, j - 1, k), getCell(i, j - 1, k), getCell(i, j, k), getCell(i - 1, j, k), !neg);
          }
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

  // 4b. the grid can't follow anything finer than a cell (a horn's sharp tip
  // turns into a lumpy nub, and smoothing rounds it further), so pull every
  // vertex back onto the true blended surface: away from the joins that's
  // each part's own shape, sharp points and all.
  const lin = prepared.map((pp) => new THREE.Matrix3().setFromMatrix4(pp.fromSkin).transpose());
  const g = new THREE.Vector3(), gp = new THREE.Vector3();
  /** the blended field at `p`, its gradient into `out` (as `field`, with the smooth-min's gradient) */
  const fieldGrad = (p: THREE.Vector3, out: THREE.Vector3): number => {
    let f = Infinity;
    for (let i = 0; i < prepared.length; i++) {
      const pp = prepared[i];
      if (!pp.box.containsPoint(p)) continue;
      q.copy(p).applyMatrix4(pp.fromSkin);
      const d = exactDistance(pp.geo, pp.bvh, pp.normals, q, band, gp);
      if (!Number.isFinite(d)) continue;
      // a local-space gradient back into skin space
      gp.applyMatrix3(lin[i]);
      if (!Number.isFinite(f)) {
        f = d;
        out.copy(gp);
        continue;
      }
      const t = Math.min(1, Math.max(0, 0.5 + (0.5 * (d - f)) / pp.k));
      f = d * (1 - t) + f * t - pp.k * t * (1 - t);
      out.multiplyScalar(t).addScaledVector(gp, 1 - t);
    }
    return f;
  };
  /** move `p` onto the surface (f = 0) by a few Newton steps, never more than a couple of cells each */
  const settle = (p: THREE.Vector3) => {
    for (let it = 0; it < 3; it++) {
      const f = fieldGrad(p, g);
      const g2 = g.lengthSq();
      if (!Number.isFinite(f) || g2 < 1e-8 || Math.abs(f) < h * 1e-3) break;
      const step = Math.max(-2 * h, Math.min(2 * h, f / Math.sqrt(g2)));
      p.addScaledVector(g, -step / Math.sqrt(g2));
    }
  };
  for (let v = 0; v < count; v++) {
    settle(pt.fromArray(pos, v * 3));
    pt.toArray(pos, v * 3);
    if ((v & 1023) === 0 && (await breathe())) return null;
  }

  /** how thick the mesh is under each vertex: straight in along its normal to the far side */
  const thicknessOf = async (mesh: THREE.BufferGeometry): Promise<Float32Array | null> => {
    const bvh = new MeshBVH(mesh);
    const P = mesh.getAttribute('position') as THREE.BufferAttribute;
    const N = mesh.getAttribute('normal') as THREE.BufferAttribute;
    const out = new Float32Array(P.count);
    const inward = new THREE.Ray();
    for (let v = 0; v < P.count; v++) {
      inward.direction.fromBufferAttribute(N, v).negate();
      // start just inside so the ray doesn't hit the vertex's own triangles
      inward.origin.fromBufferAttribute(P, v).addScaledVector(inward.direction, h * 1e-3);
      const hit = bvh.raycastFirst(inward, THREE.DoubleSide);
      out[v] = hit ? hit.distance : Infinity;
      if ((v & 4095) === 0 && (await breathe())) return null;
    }
    return out;
  };

  // 4d. where the skin is thin for its grid (a horn's point, a claw) there are
  // only a few vertices round it, so it looks faceted and lumpy: split the
  // edges there and settle the new points on the surface, twice at most.
  // (Low-poly is re-faceted anyway.)
  let verts: ArrayLike<number> = pos;
  let tris = index;
  if (!opts.lowPoly) {
    const grow = Array.from(pos);
    // edge key: both ends, smaller first
    const key = (a: number, b: number) => (a < b ? a * 4194304 + b : b * 4194304 + a);
    for (let round = 0; round < 2; round++) {
      const g0 = new THREE.BufferGeometry();
      g0.setAttribute('position', new THREE.Float32BufferAttribute(grow, 3));
      g0.setIndex(tris);
      g0.computeVertexNormals();
      const thick = await thicknessOf(g0);
      g0.dispose();
      if (!thick) return null;
      const split = new Map<number, number>();
      const len = (a: number, b: number) => Math.hypot(grow[a * 3] - grow[b * 3], grow[a * 3 + 1] - grow[b * 3 + 1], grow[a * 3 + 2] - grow[b * 3 + 2]);
      // about ten edges round anything thin; never finer than a sixth of a cell
      for (let t = 0; t < tris.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
          if (len(a, b) > Math.max(0.3 * Math.min(thick[a], thick[b]), h / 6)) split.set(key(a, b), -1);
        }
      }
      if (!split.size) break;
      // a triangle with two edges split has its third split too, so it can go into four
      for (let grew = true; grew; ) {
        grew = false;
        for (let t = 0; t < tris.length; t += 3) {
          const ks = [key(tris[t], tris[t + 1]), key(tris[t + 1], tris[t + 2]), key(tris[t + 2], tris[t])];
          const n = ks.filter((k) => split.has(k)).length;
          if (n === 2) {
            for (const k of ks) split.set(k, -1);
            grew = true;
          }
        }
      }
      let made = 0;
      for (const k of split.keys()) {
        const a = Math.floor(k / 4194304), b = k % 4194304;
        pt.set((grow[a * 3] + grow[b * 3]) / 2, (grow[a * 3 + 1] + grow[b * 3 + 1]) / 2, (grow[a * 3 + 2] + grow[b * 3 + 2]) / 2);
        settle(pt);
        split.set(k, grow.length / 3);
        grow.push(pt.x, pt.y, pt.z);
        if ((++made & 1023) === 0 && (await breathe())) return null;
      }
      const next: number[] = [];
      for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t], b = tris[t + 1], c = tris[t + 2];
        const ab = split.get(key(a, b)) ?? -1, bc = split.get(key(b, c)) ?? -1, ca = split.get(key(c, a)) ?? -1;
        if (ab >= 0 && bc >= 0 && ca >= 0) next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
        else if (ab >= 0) next.push(a, ab, c, ab, b, c);
        else if (bc >= 0) next.push(b, bc, a, bc, c, a);
        else if (ca >= 0) next.push(c, ca, b, ca, a, b);
        else next.push(a, b, c);
      }
      tris = next;
    }
    verts = grow;
  }

  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.setIndex(tris);
  geo.computeVertexNormals();
  if (opts.lumps) {
    // lumps are as big all over, which a thin point can't take (they'd make
    // it bulge and kink): cap them at a fraction of how thick the skin is there
    const thick = await thicknessOf(geo);
    if (!thick) return null;
    // the very end of a point looks in along its whole length, so it goes by
    // its neighbours too (or it'd be lumped sideways into a little barb)
    const cap = thick.map((t) => 0.05 * t);
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const m = 0.05 * Math.min(thick[a], thick[b], thick[c]);
      if (m < cap[a]) cap[a] = m;
      if (m < cap[b]) cap[b] = m;
      if (m < cap[c]) cap[c] = m;
    }
    applyLumps(geo, opts.lumps, cap);
  }

  if (opts.lowPoly) {
    // each part's own facet size, where the skin passes through it (the finer one at joins)
    const fallback = Math.max(h * 3, ...prepared.map((pp) => pp.facet ?? 0));
    const sizeAt = (p: THREE.Vector3) => {
      let s = Infinity;
      for (const pp of prepared) if (pp.facet && pp.box.containsPoint(p)) s = Math.min(s, pp.facet);
      return Number.isFinite(s) ? s : fallback;
    };
    geo = facetize(geo, sizeAt);
    geo = geo.toNonIndexed();
    geo.computeVertexNormals();
  }
  if (await breathe()) return null;

  // 5. where each vertex sat in the rest pose, so textures are laid out there
  // (and bend with the pose) rather than being projected onto today's pose.
  // Near a joint the parts' answers are blended, like skinning in reverse.
  if (parts.every((p) => p.toRest)) {
    const P = geo.getAttribute('position') as THREE.BufferAttribute;
    const N = geo.getAttribute('normal') as THREE.BufferAttribute;
    const toRest = parts.map((p) => p.toRest!.clone().multiply(p.toSkin.clone().invert()));
    const turn = toRest.map((m) => new THREE.Matrix3().setFromMatrix4(m));
    const blendW = Math.max(kMax, 2 * h);
    const rp = new Float32Array(P.count * 3), rn = new Float32Array(P.count * 3);
    const ds = new Float32Array(prepared.length);
    const acc = new THREE.Vector3(), accN = new THREE.Vector3(), tmp = new THREE.Vector3(), nv = new THREE.Vector3();
    for (let v = 0; v < P.count; v++) {
      pt.fromBufferAttribute(P, v);
      nv.fromBufferAttribute(N, v);
      let dmin = Infinity, nearest = 0;
      for (let i = 0; i < prepared.length; i++) {
        const pp = prepared[i];
        ds[i] = Infinity;
        if (!pp.box.containsPoint(pt)) continue;
        q.copy(pt).applyMatrix4(pp.fromSkin);
        ds[i] = Math.abs(exactDistance(pp.geo, pp.bvh, pp.normals, q, band, grad));
        if (ds[i] < dmin) {
          dmin = ds[i];
          nearest = i;
        }
      }
      acc.set(0, 0, 0);
      accN.set(0, 0, 0);
      let wsum = 0;
      for (let i = 0; i < prepared.length; i++) {
        if (!Number.isFinite(ds[i])) continue;
        const w = Math.max(0, 1 - (ds[i] - dmin) / blendW) ** 2;
        if (w <= 0) continue;
        acc.addScaledVector(tmp.copy(pt).applyMatrix4(toRest[i]), w);
        accN.addScaledVector(tmp.copy(nv).applyMatrix3(turn[i]), w);
        wsum += w;
      }
      if (wsum <= 0) {
        acc.copy(pt).applyMatrix4(toRest[nearest]);
        accN.copy(nv).applyMatrix3(turn[nearest]);
        wsum = 1;
      }
      acc.divideScalar(wsum);
      accN.normalize();
      rp.set([acc.x, acc.y, acc.z], v * 3);
      rn.set([accN.x, accN.y, accN.z], v * 3);
      if ((v & 1023) === 0 && (await breathe())) return null;
    }
    geo.setAttribute('restPos', new THREE.BufferAttribute(rp, 3));
    geo.setAttribute('restNormal', new THREE.BufferAttribute(rn, 3));
  }
  geo.userData.painted = paintSkin(geo, parts, opts.colorBlend, opts.lowPoly);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Low-poly look for a smooth skin: merge the vertices in each cell of a grid
 * (cell = the local facet size) into one, and drop the triangles that
 * collapse. Vertices facing different ways never merge, so thin parts (a
 * wing's two sides) keep their thickness. The grid is turned off the axes so
 * the facets don't line up in rows.
 */
function facetize(src: THREE.BufferGeometry, sizeAt: (p: THREE.Vector3) => number): THREE.BufferGeometry {
  const pos = src.getAttribute('position') as THREE.BufferAttribute;
  const nor = src.getAttribute('normal') as THREE.BufferAttribute;
  const index = src.getIndex()!;
  const turn = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0.7, 0.4).normalize(), 0.61);
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  const clusters = new Map<string, number>();
  const sums: number[] = [];
  const counts: number[] = [];
  const remap = new Int32Array(pos.count);
  for (let v = 0; v < pos.count; v++) {
    p.fromBufferAttribute(pos, v);
    const s = sizeAt(p);
    q.copy(p).applyMatrix4(turn);
    const nx = nor.getX(v), ny = nor.getY(v), nz = nor.getZ(v);
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const facing = ax >= ay && ax >= az ? (nx > 0 ? 0 : 1) : ay >= az ? (ny > 0 ? 2 : 3) : nz > 0 ? 4 : 5;
    const key = `${s.toFixed(5)}|${Math.floor(q.x / s)}|${Math.floor(q.y / s)}|${Math.floor(q.z / s)}|${facing}`;
    let c = clusters.get(key);
    if (c === undefined) {
      c = counts.length;
      clusters.set(key, c);
      sums.push(0, 0, 0);
      counts.push(0);
    }
    sums[c * 3] += p.x;
    sums[c * 3 + 1] += p.y;
    sums[c * 3 + 2] += p.z;
    counts[c]++;
    remap[v] = c;
  }
  // Each cell's corner is its real surface vertex nearest the cell's average:
  // an average of points on a curved surface sits inside it, which would
  // shrink the creature a little everywhere.
  const out = new Float32Array(counts.length * 3);
  const best = new Float64Array(counts.length).fill(Infinity);
  for (let v = 0; v < pos.count; v++) {
    const c = remap[v];
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    const d = (x - sums[c * 3] / counts[c]) ** 2 + (y - sums[c * 3 + 1] / counts[c]) ** 2 + (z - sums[c * 3 + 2] / counts[c]) ** 2;
    if (d >= best[c]) continue;
    best[c] = d;
    out[c * 3] = x;
    out[c * 3 + 1] = y;
    out[c * 3 + 2] = z;
  }
  const tris: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = remap[index.getX(t)], b = remap[index.getX(t + 1)], c = remap[index.getX(t + 2)];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.setIndex(tris);
  return g;
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

interface FadeDistances {
  /** how far out they were measured */
  reach: number;
  /** vertex v's entries are start[v] .. start[v + 1] */
  start: Int32Array;
  part: Uint16Array;
  d: Float32Array;
}

/**
 * Each skin vertex's distance to every part near it, remembered on the skin
 * (measured a bit wider than needed, up to the fade slider's top), so moving
 * the color-fade slider only redoes the colors, not the distance queries.
 */
function fadeDistances(geo: THREE.BufferGeometry, parts: SkinPart[], need: number): FadeDistances {
  const cached = geo.userData.fade as FadeDistances | undefined;
  if (cached && cached.reach >= need) return cached;
  const reach = Math.max(need, Math.min(0.8, 2 * need));
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const prepared = parts.map((p) => ({
    p,
    bvh: bvhFor(p.geo),
    normals: sharedNormals(p.geo),
    fromSkin: p.toSkin.clone().invert(),
    box: p.geo.boundingBox!.clone().applyMatrix4(p.toSkin).expandByScalar(reach),
  }));
  const start = new Int32Array(pos.count + 1);
  const part: number[] = [];
  const dist: number[] = [];
  const pt = new THREE.Vector3(), q = new THREE.Vector3(), grad = new THREE.Vector3();
  for (let v = 0; v < pos.count; v++) {
    start[v] = part.length;
    pt.fromBufferAttribute(pos, v);
    for (let i = 0; i < prepared.length; i++) {
      const pp = prepared[i];
      if (!pp.box.containsPoint(pt)) continue;
      q.copy(pt).applyMatrix4(pp.fromSkin);
      const d = exactDistance(pp.p.geo, pp.bvh, pp.normals, q, reach, grad);
      if (!Number.isFinite(d)) continue;
      part.push(i);
      dist.push(d);
    }
  }
  start[pos.count] = part.length;
  const out = { reach, start, part: Uint16Array.from(part), d: Float32Array.from(dist) };
  geo.userData.fade = out;
  return out;
}

/**
 * (Re)color a skin: blended part colors near the seams (when blending and
 * the colors differ) and per-facet shading for low-poly. Returns whether
 * colors were baked in (the material should then be white). Cheap next to a
 * rebuild, so a color-only change repaints the existing skin.
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
    const fade = fadeDistances(geo, parts, 2 * kc);
    const c = new THREE.Color();
    for (let v = 0; v < n; v++) {
      let wsum = 0;
      c.setRGB(0, 0, 0);
      let nearest = 0, nearestD = Infinity;
      for (let e = fade.start[v]; e < fade.start[v + 1]; e++) {
        const d = fade.d[e];
        if (d >= 2 * kc) continue;
        const pc = parts[fade.part[e]].color;
        if (d < nearestD) {
          nearestD = d;
          nearest = fade.part[e];
        }
        // 50/50 where two parts are equally close, each part's own color away from the seam
        const w = 1 / (Math.max(d, 0) + 0.25 * kc) ** 2;
        c.r += pc.r * w;
        c.g += pc.g * w;
        c.b += pc.b * w;
        wsum += w;
      }
      if (wsum > 0) c.multiplyScalar(1 / wsum);
      else c.copy(parts[nearest].color);
      colors[v * 3] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
  }

  if (lowPoly) {
    // per-facet shade variation, multiplied into any blended color
    for (let f = 0; f < n; f += 3) {
      const k = 0.9 + ((((Math.sin(f * 12.9898) * 43758.5453) % 1) + 1) % 1) * 0.14;
      for (let j = 0; j < 9 && f * 3 + j < colors.length; j++) colors[f * 3 + j] *= k;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return blend;
}

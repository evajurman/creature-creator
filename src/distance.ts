import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

// Exact signed distances to a part's real surface, shared by the fast merge
// (reshaping each part at its joins) and the seamless skin rebuild.

/**
 * Low-poly meshes are non-indexed: each triangle has its own copy of a corner
 * with its own flat normal. Anything that moves vertices along their normal
 * would push those copies apart and tear the seams, so average the normals of
 * every copy sitting at the same position. Indexed meshes already share them.
 */
export function sharedNormals(geo: THREE.BufferGeometry): THREE.BufferAttribute {
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

const bvhCache = new WeakMap<THREE.BufferGeometry, MeshBVH>();
/** A bounding-volume hierarchy over a part's surface, built once per geometry. */
export function bvhFor(geo: THREE.BufferGeometry): MeshBVH {
  let bvh = bvhCache.get(geo);
  if (!bvh) {
    // indirect: leave the geometry's own triangle order untouched
    bvh = new MeshBVH(geo, { indirect: true });
    bvhCache.set(geo, bvh);
  }
  return bvh;
}

const hitInfo = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const triA = new THREE.Vector3(), triB = new THREE.Vector3(), triC = new THREE.Vector3();
const bary = new THREE.Vector3(), nrm = new THREE.Vector3(), away = new THREE.Vector3();

/**
 * Signed distance from local point `q` to a part's actual surface (negative
 * inside), with the outward direction written into `grad`. Returns Infinity
 * when the surface is further than `maxD` (nothing to blend there).
 */
export function exactDistance(
  geo: THREE.BufferGeometry,
  bvh: MeshBVH,
  normals: THREE.BufferAttribute,
  q: THREE.Vector3,
  maxD: number,
  grad: THREE.Vector3,
): number {
  const hit = bvh.closestPointToPoint(q, hitInfo, 0, maxD);
  if (!hit) return Infinity;
  const tri = hit.faceIndex; // already the real triangle, even in indirect mode
  const index = geo.index;
  const i0 = index ? index.getX(tri * 3) : tri * 3;
  const i1 = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
  const i2 = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  triA.fromBufferAttribute(pos, i0);
  triB.fromBufferAttribute(pos, i1);
  triC.fromBufferAttribute(pos, i2);
  // the smooth (interpolated) normal at the closest point decides inside vs outside
  THREE.Triangle.getBarycoord(hit.point, triA, triB, triC, bary);
  nrm
    .set(0, 0, 0)
    .addScaledVector(triA.fromBufferAttribute(normals, i0), bary.x)
    .addScaledVector(triB.fromBufferAttribute(normals, i1), bary.y)
    .addScaledVector(triC.fromBufferAttribute(normals, i2), bary.z)
    .normalize();
  away.subVectors(q, hit.point);
  const dist = away.length();
  const sign = away.dot(nrm) >= 0 ? 1 : -1;
  if (dist > 1e-6) grad.copy(away).divideScalar(dist).multiplyScalar(sign);
  else grad.copy(nrm);
  return sign * dist;
}

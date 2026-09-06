/**
 * Kwetu engine — f64 vector/quaternion math and the framed-vector type.
 *
 * Owned by COORDINATE_SYSTEM.md (frames, precision, time). This module is the
 * leaf of the engine math core: it imports nothing, so every other engine
 * module can depend on it without cycles.
 *
 * Precision law (COORDINATE_SYSTEM.md Law P-1): canonical state, frame
 * conversions and free-flight integration use f64. Every number in this module
 * is a JS number (IEEE-754 binary64); none of this code may ever touch
 * Float32Array (Law P-1, G-04). The f32 boundaries are the ones explicitly
 * named in Law P-2 (render downcast) and Law P-1 (bounded Rapier contact
 * solver) — see `precision.ts` for the downcast helpers used there.
 *
 * Unit law (Laws U-1/U-2/U-3): metres, seconds, radians; every field carries
 * its unit in its name. Frame law (§13 rule 3): a bare `{x,y,z}` crossing a
 * module boundary without a frame is a defect — vectors that cross a frame
 * boundary travel as `Framed`.
 */

/** A 3-vector in f64. Bare arithmetic type — never cross a frame boundary with it. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A unit quaternion (w-first storage, body-to-parent convention documented at use sites). */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * A vector that carries its frame identifier (COORDINATE_SYSTEM.md §13 rule 3).
 * `F` is the frame name string from `frames.ts`; keeping it a type parameter
 * makes passing the wrong frame to a conversion a compile error.
 */
export interface Framed<F extends string> {
  readonly frame: F;
  readonly xyz: Vec3;
}

/** Tags `v` with frame `frame`. The only way to manufacture a `Framed` at a boundary. */
export function framed<F extends string>(frame: F, xyz: Vec3): Framed<F> {
  return { frame, xyz };
}

/** Removes the frame tag — only inside the module that owns the conversion. */
export function unframed<F extends string>(v: Framed<F>): Vec3 {
  return v.xyz;
}

// --- f64 vector arithmetic ----------------------------------------------------

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function addV(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subV(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scaleV(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function norm3(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/** Euclidean distance between two points. */
export function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Angle between two (non-zero) vectors, via atan2(|a×b|, a·b) — no acos clamping noise. */
export function angleBetweenRadians(a: Vec3, b: Vec3): number {
  return Math.atan2(norm3(cross3(a, b)), dot3(a, b));
}

/** Active rotation about +z by angle `angleRad` (right-hand rule), f64. */
export function rotateZ(v: Vec3, angleRad: number): Vec3 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

// --- f64 quaternion arithmetic -------------------------------------------------

/** Hamilton product q ⊗ r: applies r first, then q (v' = q ⊗ r ⊗ v* ⊗ ...). */
export function quatMul(q: Quat, r: Quat): Quat {
  return {
    x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
    y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
    z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
    w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
  };
}

/** Conjugate of a unit quaternion (its inverse). */
export function quatConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Rotates `v` by unit quaternion q (v' = q v q⁻¹), f64. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const qv: Vec3 = { x: q.x, y: q.y, z: q.z };
  const t1 = cross3(qv, v);
  const t2 = cross3(qv, { x: t1.x * 2, y: t1.y * 2, z: t1.z * 2 });
  return {
    x: v.x + t2.x + q.w * t1.x * 2,
    y: v.y + t2.y + q.w * t1.y * 2,
    z: v.z + t2.z + q.w * t1.z * 2,
  };
}

/** Unit quaternion for an active rotation about +z by `angleRad`. */
export function quatZ(angleRad: number): Quat {
  return { x: 0, y: 0, z: Math.sin(angleRad / 2), w: Math.cos(angleRad / 2) };
}

/** Unit quaternion for an active rotation about +y by `angleRad`. */
export function quatY(angleRad: number): Quat {
  return { x: 0, y: Math.sin(angleRad / 2), z: 0, w: Math.cos(angleRad / 2) };
}

/** Quaternion norm (1 for a unit quaternion). */
export function quatNorm(q: Quat): number {
  return Math.hypot(q.x, q.y, q.z, q.w);
}

/** Component-wise |q − r| norm — the residual metric used by the rebase tests. */
export function quatDifference(q: Quat, r: Quat): number {
  return Math.hypot(q.x - r.x, q.y - r.y, q.z - r.z, q.w - r.w);
}

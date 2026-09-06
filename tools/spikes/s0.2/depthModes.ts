// S0.2 probe — depth strategies under test.
//
// Four modes, all through three 0.185.1's own machinery (no forked shaders):
//   log       — WebGLRenderer({ logarithmicDepthBuffer: true }): the current
//               CLAUDE.md invariant. Fragment-shader gl_FragDepth write
//               (logdepthbuf chunk), which disables early-z rejection.
//   revz      — WebGLRenderer({ reversedDepthBuffer: true }) + camera flagged
//               reversed: three 0.185's native reversed-Z on the DEFAULT
//               framebuffer (depth bit depth is the context's — typically a
//               24-bit fixed-point D24, i.e. reversed FIXED-point here).
//   revz-f32  — same reversed-Z machinery, but the scene renders into an
//               offscreen WebGLRenderTarget whose depth attachment is a
//               FloatType DepthTexture (DEPTH_COMPONENT32F — verified in
//               three's WebGLTextures.getInternalDepthFormat), then a
//               fullscreen display pass blits color to the canvas. Costs one
//               extra draw call and loses MSAA (samples: 0).
//   std       — control row: default renderer/projection (LEQUAL, clear 1).
//               Expected to fail the mid/far depth pairs; proves the test can
//               detect failure.
//
// How three 0.185 implements reversed-Z (read from source, src/renderers/):
// requires EXT_clip_control; on render it sets clipControlEXT(LOWER_LEFT,
// ZERO_TO_ONE), flips the camera projection via makePerspective(...,
// reversedDepth) (near maps to depth 1, far to depth 0), flips every
// material's depth comparison (WebGLState ReversedDepthFuncs: LEQUAL -> GEQUAL),
// and flips the depth clear value (clear "1" -> gl.clearDepth(0)). Frustum
// plane extraction is swapped for reversed cameras (Frustum.setFromProjectionMatrix
// with camera.reversedDepth). Materials keep their DEFAULT depthFunc — the
// state machine flips it; setting GEQUAL manually would double-flip.
//
// Probe-only carve-out (CLAUDE.md): throwaway code under tools/spikes/.

import {
  DepthFormat,
  DepthTexture,
  FloatType,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  Color,
  Scene,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
} from 'three';

export type DepthModeId = 'log' | 'revz' | 'revz-f32' | 'std';

export const DEPTH_MODE_IDS: readonly DepthModeId[] = ['log', 'revz', 'revz-f32', 'std'];

export interface DepthModeSpec {
  id: DepthModeId;
  label: string;
  rendererOptions: {
    logarithmicDepthBuffer: boolean;
    reversedDepthBuffer: boolean;
  };
  /** flag the camera reversed (three flips projection + depth state) */
  cameraReversed: boolean;
  /** render into the f32-depth offscreen target and blit, instead of direct */
  renderTargetF32: boolean;
  /** one-line mechanism note for the report */
  mechanism: string;
}

export const DEPTH_MODES: Record<DepthModeId, DepthModeSpec> = {
  log: {
    id: 'log',
    label: 'logarithmicDepthBuffer (three built-in)',
    rendererOptions: { logarithmicDepthBuffer: true, reversedDepthBuffer: false },
    cameraReversed: false,
    renderTargetF32: false,
    mechanism:
      'logdepthbuf shader chunk writes gl_FragDepth = log2(1+w)*FC/2 per fragment ' +
      '(FC = 2/log2(far+1)); disables early-z; standard LEQUAL compare, clear 1.',
  },
  revz: {
    id: 'revz',
    label: 'reversed-Z, default framebuffer (three 0.185 native)',
    rendererOptions: { logarithmicDepthBuffer: false, reversedDepthBuffer: true },
    cameraReversed: true,
    renderTargetF32: false,
    mechanism:
      'EXT_clip_control (LOWER_LEFT, ZERO_TO_ONE) + makePerspective(reversedDepth) ' +
      '(near -> depth 1, far -> depth 0) + material compares flipped LEQUAL->GEQUAL ' +
      "+ depth clear flipped to 0, all by three's WebGLState. Default framebuffer " +
      'depth attachment: implementation-chosen, typically 24-bit fixed (D24/D24S8).',
  },
  'revz-f32': {
    id: 'revz-f32',
    label: 'reversed-Z + float32 depth attachment (three 0.185 native)',
    rendererOptions: { logarithmicDepthBuffer: false, reversedDepthBuffer: true },
    cameraReversed: true,
    renderTargetF32: true,
    mechanism:
      'Same reversed-Z machinery as revz, but the scene renders into a 1280x720 ' +
      'WebGLRenderTarget whose depth attachment is a FloatType DepthTexture ' +
      '(DEPTH_COMPONENT32F per three WebGLTextures.getInternalDepthFormat); a ' +
      'fullscreen display pass then blits color to the canvas (+1 draw call, no MSAA).',
  },
  std: {
    id: 'std',
    label: 'standard-Z control (three defaults)',
    rendererOptions: { logarithmicDepthBuffer: false, reversedDepthBuffer: false },
    cameraReversed: false,
    renderTargetF32: false,
    mechanism: 'Standard perspective, LEQUAL compare, clear 1 — control row, expected to fail mid/far pairs.',
  },
};

/**
 * Flag a camera for reversed depth exactly the way three's own renderer does
 * (WebGLRenderer sets camera._reversedDepth = true then updateProjectionMatrix;
 * the public surface is a read-only `reversedDepth` getter, so the field is
 * set through a typed cast).
 */
export function configureCameraDepth(camera: { updateProjectionMatrix(): void }, id: DepthModeId): void {
  if (!DEPTH_MODES[id].cameraReversed) return;
  (camera as unknown as { _reversedDepth: boolean })._reversedDepth = true;
  camera.updateProjectionMatrix();
}

/**
 * Offscreen target with a true float32 depth attachment for revz-f32.
 * DepthTexture(format=DepthFormat, type=FloatType) makes three allocate
 * DEPTH_COMPONENT32F (WebGLTextures.getInternalDepthFormat).
 */
export function createF32DepthTarget(width: number, height: number): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(width, height, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    samples: 0, // no MSAA on the f32-depth path (documented caveat)
  });
  const depth = new DepthTexture(width, height);
  depth.format = DepthFormat;
  depth.type = FloatType;
  rt.depthTexture = depth;
  return rt;
}

/** Fullscreen blit pass used only by revz-f32 to show the offscreen color. */
export function createDisplayPass(texture: WebGLRenderTarget['texture']): {
  scene: Scene;
  camera: OrthographicCamera;
  mesh: Mesh;
} {
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new MeshBasicMaterial({ map: texture, depthTest: false, depthWrite: false });
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, camera, mesh };
}

// ---------------------------------------------------------------------------
// Depth-quality fixture: three screen-overlapping parallel-quad pairs at very
// different ranges. The FRONT quad is drawn FIRST and the BACK quad LAST
// (renderOrder), so a correct depth compare is REQUIRED for the front surface
// to win — painter's order cannot fake a pass. The back quad is tilted by
// 0.8*gap/d radians so the front/back depth separation sweeps ~[0.2, 1.8]x
// the nominal gap across the sample box: a depth scheme whose precision is
// coarser than the gap loses a measurable fraction of pixels to the back
// quad regardless of where quantization boundaries land.
// ---------------------------------------------------------------------------

export interface DepthPairSpec {
  /** nominal range of the front quad (m) */
  d: number;
  /** nominal front/back separation (m) */
  gap: number;
}

export const DEPTH_PAIRS: readonly DepthPairSpec[] = [
  { d: 8, gap: 0.001 },
  { d: 5_000, gap: 0.05 },
  { d: 500_000, gap: 2 },
];

export const DEPTH_FOV_RAD = 1.0471975512; // 60 deg — same as the flight camera
export const DEPTH_NEAR_M = 0.1; // shared with the flight camera
export const DEPTH_FAR_M = 1.5e7; // shared with the flight camera

export const DEPTH_COLOR_FRONT = [255, 60, 60] as const;
export const DEPTH_COLOR_BACK = [60, 255, 60] as const;
export const SKY_COLOR = [11, 16, 38] as const;

/** Quad sizes and the derived-sample-box fractions (see buildDepthTestScene). */
export const DEPTH_LAYOUT = {
  frontHalfNdc: 0.22,
  backHalfNdc: 0.3,
  /** vertical NDC offsets stacking the three pairs (separation > 2x quad reach) */
  yOffsetsNdc: [0.6, 0, -0.6],
  /** inner box half-extent as a fraction of the projected front quad */
  innerFrac: 0.4,
  /** annulus inset from each edge of the front..back ring, as ring-width fraction */
  annulusMarginFrac: 0.15,
  /** annulus half-height as a fraction of the back quad's left-corner y-span */
  annulusYSpanFrac: 0.4,
} as const;

export interface DepthSampleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DepthPairSample {
  d: number;
  gap: number;
  inner: DepthSampleRect;
  annulus: DepthSampleRect;
  /** projected pixel rects (GL bottom-left origin) of the front / back quads */
  frontRect: DepthSampleRect;
  backRect: DepthSampleRect;
  frontRgb: readonly number[];
  backRgb: readonly number[];
}

export interface DepthTestScene {
  scene: Scene;
  /** pixel-space readback rectangles for a width x height canvas */
  samples: DepthPairSample[];
}

/**
 * Build the depth-quality fixture for a viewport of width x height px.
 * The scene contains ONLY the six quads; the caller supplies a camera at the
 * origin looking down -Z with the flight near/far (it must already have
 * updateMatrixWorld() applied — projection of the sample rects needs it).
 *
 * Layout (v2, measured fix 2026-09-06): v1 placed each pair on its own yawed
 * ray and derived sample rects from ASSUMED NDC extents — but a plane
 * perpendicular to an off-axis ray projects asymmetrically (the 8 m pair's
 * front quad covered x_ndc ~[0.27, 1.21] instead of [0.32, 0.92]), so the
 * annulus boxes landed INSIDE the front quads and every mode "failed" the
 * ring check. v2 stacks the three pairs on near-axis rays separated
 * vertically (y_ndc +0.6 / 0 / -0.6) and derives every sample rect from the
 * PROJECTED quad corners, so correctness no longer depends on hand-computed
 * extents: the inner box is 40% of the projected front quad (always inside
 * it), the annulus lies strictly between the projected back and front left
 * edges (always on the back quad, never on the front one).
 */
export function buildDepthTestScene(camera: PerspectiveCamera, width: number, height: number): DepthTestScene {
  const scene = new Scene();
  const tanHalf = Math.tan(DEPTH_FOV_RAD / 2);
  const ndcToPxX = (ndc: number): number => ((ndc + 1) / 2) * width;
  const ndcToPxY = (ndc: number): number => ((ndc + 1) / 2) * height; // GL bottom-left origin

  const samples: DepthPairSample[] = [];
  const fwd = new Vector3();
  const corner = new Vector3();

  for (let i = 0; i < DEPTH_PAIRS.length; i++) {
    const pair = DEPTH_PAIRS[i] as DepthPairSpec;
    // Near-axis ray, vertically stacked so pairs never reach each other's
    // sample boxes (max quad reach ~0.35 NDC from its center, separation 0.6).
    const yOff = DEPTH_LAYOUT.yOffsetsNdc[i] as number;
    fwd.set(0, yOff * tanHalf, -1).normalize();

    const mkQuad = (
      halfNdc: number,
      distance: number,
      rgb: readonly [number, number, number],
      renderOrder: number,
      tiltRad: number,
    ): Mesh => {
      const worldHalfW = halfNdc * distance * tanHalf * (width / height);
      const worldHalfH = halfNdc * distance * tanHalf;
      const mat = new MeshBasicMaterial({ depthWrite: true });
      mat.color = new Color().setRGB(
        rgb[0] / 255,
        rgb[1] / 255,
        rgb[2] / 255,
        SRGBColorSpace,
      );
      const mesh = new Mesh(new PlaneGeometry(worldHalfW * 2, worldHalfH * 2), mat);
      mesh.position.copy(fwd).multiplyScalar(distance);
      // Plane +z faces the camera at the origin.
      mesh.lookAt(0, 0, 0);
      // Yaw about the mesh's local up (~world up here): shifts the back
      // quad's depth monotonically across the sample box.
      if (tiltRad !== 0) mesh.rotateY(tiltRad);
      mesh.renderOrder = renderOrder;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    };

    const front = mkQuad(DEPTH_LAYOUT.frontHalfNdc, pair.d, DEPTH_COLOR_FRONT, 1, 0);
    const tilt = 0.8 * (pair.gap / pair.d);
    const back = mkQuad(DEPTH_LAYOUT.backHalfNdc, pair.d + pair.gap, DEPTH_COLOR_BACK, 2, tilt);

    // Projected pixel rects of both quads (GL bottom-left origin).
    scene.updateMatrixWorld(true);
    const projRect = (mesh: Mesh): DepthSampleRect & { leftYs: [number, number] } => {
      const geom = mesh.geometry as PlaneGeometry;
      const halfW = geom.parameters.width / 2;
      const halfH = geom.parameters.height / 2;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const leftPts: number[] = [];
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        corner.set(sx * halfW, sy * halfH, 0).applyMatrix4(mesh.matrixWorld).project(camera);
        const px = ndcToPxX(corner.x);
        const py = ndcToPxY(corner.y);
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (sx === -1) leftPts.push(py);
      }
      const ys = leftPts as [number, number];
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, leftYs: ys };
    };
    const fr = projRect(front);
    const br = projRect(back);

    // Inner box: 40% of the projected front quad, centered on it.
    const innerHalfW = fr.w * DEPTH_LAYOUT.innerFrac * 0.5;
    const innerHalfH = fr.h * DEPTH_LAYOUT.innerFrac * 0.5;
    const inner: DepthSampleRect = {
      x: Math.round(fr.x + fr.w / 2 - innerHalfW),
      y: Math.round(fr.y + fr.h / 2 - innerHalfH),
      w: Math.round(innerHalfW * 2),
      h: Math.round(innerHalfH * 2),
    };
    // Annulus: strictly between the projected back and front LEFT edges; its
    // vertical span fits inside the back quad's left-corner y-range (a
    // projected rectangle is a trapezoid — coverage narrows toward its edge).
    const ringW = fr.x - br.x; // front.left - back.left > 0 (back is wider)
    const axFrom = br.x + DEPTH_LAYOUT.annulusMarginFrac * ringW;
    const axTo = fr.x - DEPTH_LAYOUT.annulusMarginFrac * ringW;
    const cy = br.y + br.h / 2;
    const annulusHalfY =
      Math.min(Math.abs((br.leftYs[0] as number) - cy), Math.abs((br.leftYs[1] as number) - cy)) *
      DEPTH_LAYOUT.annulusYSpanFrac;
    const annulus: DepthSampleRect = {
      x: Math.round(axFrom),
      y: Math.round(cy - annulusHalfY),
      w: Math.round(axTo - axFrom),
      h: Math.round(annulusHalfY * 2),
    };
    samples.push({
      d: pair.d,
      gap: pair.gap,
      inner,
      annulus,
      frontRect: { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.w), h: Math.round(fr.h) },
      backRect: { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.w), h: Math.round(br.h) },
      frontRgb: DEPTH_COLOR_FRONT,
      backRgb: DEPTH_COLOR_BACK,
    });
  }

  return { scene, samples };
}

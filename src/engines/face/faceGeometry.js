/**
 * Head pose, eye-in-head gaze, and eye openness from MediaPipe Face Landmarker output. Pure
 * functions, no browser APIs.
 *
 * Sign convention (from the person's point of view, so "right" is the direction of the right
 * edge of the screen they are facing):
 * - yaw > 0: turned or looking to the person's right (in an unmirrored camera image, toward the
 *   image's left);
 * - pitch > 0: up;
 * - roll > 0: head tilted toward the person's right shoulder.
 *
 * Angles are degrees.
 */

const DEG = 180 / Math.PI;

/**
 * Face Mesh V2 landmark indices (478 with iris). Right and left are the person's.
 * EAR points p1..p6: outer corner, upper lid ×2, inner corner, lower lid ×2.
 */
export const LANDMARKS = Object.freeze({
  rightEye: Object.freeze({ outer: 33, inner: 133, ear: [33, 160, 158, 133, 153, 144] }),
  leftEye: Object.freeze({ outer: 263, inner: 362, ear: [263, 387, 385, 362, 380, 373] }),
  /** Centres of the two iris rings (468–472 and 473–477). */
  irisCenters: Object.freeze([468, 473]),
  count: 478,
});

/**
 * Eye model for turning iris positions into a gaze direction, in eye widths W (corner to
 * corner, about 30 mm). The iris centre lies R = `IRIS_RADIUS_RATIO`·W from the eyeball centre
 * (about 11 mm); the midpoint of the eye corners lies d = `CORNER_DEPTH_RATIO`·W in front of it.
 * Seen by the camera (orthographic approximation), with the head turned by θ and the eye by φ
 * within the head, the iris lies at R·sin(φ + θ) − d·sin θ from the corner midpoint, and the
 * eye appears W·cos θ wide. So the gaze direction relative to the camera is
 *   φ + θ = asin((offset · cos θ + d · sin θ) / R)   (offset in apparent eye widths).
 * d was chosen on a public-domain portrait with the head turned 32–39° and the eyes on the
 * viewer, and on its mirror image: the estimated gaze came out within 7° (yaw) and 10° (pitch)
 * of the camera, against 33–39° for the head alone. The constants are approximations; the
 * per-person calibration measures the screen in the same units.
 */
export const EYE_MODEL = Object.freeze({ IRIS_RADIUS_RATIO: 0.37, CORNER_DEPTH_RATIO: 0.15 });

/**
 * @typedef {Object} HeadPose
 * @property {number} yawDeg
 * @property {number} pitchDeg
 * @property {number} rollDeg
 * @property {number | null} distanceCm distance of the face from the camera in MediaPipe's
 *   metric space (assumes MediaPipe's default camera field of view; approximate)
 * @property {'column-major' | 'row-major'} layout layout the matrix data was read with
 */

/**
 * Head pose from MediaPipe's 4×4 facial transformation matrix (canonical face model → camera
 * space; X right in the image, Y up, Z toward the camera). The face's forward direction is the
 * rotated +Z axis; yaw and pitch are its direction, roll is the tilt of the rotated +Y axis.
 *
 * MediaPipe's MatrixData is column-major by default. The layout is still detected from where
 * the translation is (the last column, |z| tens of centimetres, against a 0 0 0 1 bottom row),
 * so a change of layout cannot silently flip the angles.
 *
 * @param {ArrayLike<number>} data 16 values
 * @returns {HeadPose | null} null for a malformed matrix
 */
export function headPoseFromMatrix(data) {
  if (!data || data.length !== 16) return null;
  for (let index = 0; index < 16; index += 1) if (!Number.isFinite(data[index])) return null;
  const columnTranslation = Math.abs(data[12]) + Math.abs(data[13]) + Math.abs(data[14]);
  const rowTranslation = Math.abs(data[3]) + Math.abs(data[7]) + Math.abs(data[11]);
  const columnMajor = columnTranslation >= rowTranslation;
  /** @param {number} row @param {number} column */
  const at = (row, column) => (columnMajor ? data[column * 4 + row] : data[row * 4 + column]);
  const forward = normalize([at(0, 2), at(1, 2), at(2, 2)]);
  const up = normalize([at(0, 1), at(1, 1), at(2, 1)]);
  if (!forward || !up) return null;
  const translation = [at(0, 3), at(1, 3), at(2, 3)];
  const distance = Math.hypot(...translation);
  return {
    // Facing the person's right means facing the image's left (−X).
    yawDeg: Math.atan2(-forward[0], forward[2]) * DEG,
    pitchDeg: Math.atan2(forward[1], Math.hypot(forward[0], forward[2])) * DEG,
    // Tilting toward the right shoulder moves the top of the head toward the image's left.
    rollDeg: Math.atan2(-up[0], up[1]) * DEG,
    distanceCm: distance > 0 ? distance : null,
    layout: columnMajor ? "column-major" : "row-major",
  };
}

/**
 * @typedef {Object} EyeMeasure one eye, in image pixels
 * @property {number} widthPx corner-to-corner distance
 * @property {number} ear eye aspect ratio (lid distance / width), lower when closing
 * @property {number | null} irisX iris centre offset from the corner midpoint along the eye line,
 *   in eye widths; > 0 toward the image's right. null without iris landmarks
 * @property {number | null} irisY offset perpendicular to the eye line, > 0 toward the image's
 *   bottom
 *
 * @typedef {Object} EyeMeasures
 * @property {EyeMeasure} right the person's right eye (image left in an unmirrored image)
 * @property {EyeMeasure} left
 * @property {number} interocularPx distance between the two eye centres
 */

/**
 * Eye measurements from 478 landmarks (x, y normalized to the image, z relative depth).
 *
 * @param {ArrayLike<number>} landmarks x, y, z per landmark
 * @param {number} width image width in pixels
 * @param {number} height image height in pixels
 * @returns {EyeMeasures | null} null when the eye landmarks are missing
 */
export function eyeMeasures(landmarks, width, height) {
  const count = Math.floor(landmarks.length / 3);
  if (count <= Math.max(LANDMARKS.rightEye.outer, LANDMARKS.leftEye.outer)) return null;
  /** @param {number} index @returns {[number, number]} */
  const point = (index) => [landmarks[index * 3] * width, landmarks[index * 3 + 1] * height];
  const right = eyeGeometry(point, LANDMARKS.rightEye);
  const left = eyeGeometry(point, LANDMARKS.leftEye);
  // The eye line from the person's right eye to the left eye points toward the image's right
  // for an upright face; perpendicular (x, y) → (−y, x) points toward the image's bottom.
  const axis = normalize2([left.center[0] - right.center[0], left.center[1] - right.center[1]]);
  const interocularPx = Math.hypot(
    left.center[0] - right.center[0],
    left.center[1] - right.center[1],
  );
  const hasIris = count >= LANDMARKS.count && axis !== null;
  /** @type {Array<[number, number]>} */
  const irises = hasIris ? LANDMARKS.irisCenters.map(point) : [];
  /**
   * @param {{ center: [number, number], widthPx: number, ear: number }} eye
   * @returns {EyeMeasure}
   */
  const measure = (eye) => {
    if (!hasIris || !axis || eye.widthPx <= 0) {
      return { widthPx: eye.widthPx, ear: eye.ear, irisX: null, irisY: null };
    }
    // The ring nearer to this eye's centre belongs to it (the index order is not relied on).
    const iris = irises.reduce((best, candidate) =>
      distance2(candidate, eye.center) < distance2(best, eye.center) ? candidate : best,
    );
    const dx = iris[0] - eye.center[0];
    const dy = iris[1] - eye.center[1];
    return {
      widthPx: eye.widthPx,
      ear: eye.ear,
      irisX: (dx * axis[0] + dy * axis[1]) / eye.widthPx,
      irisY: (-dx * axis[1] + dy * axis[0]) / eye.widthPx,
    };
  };
  return { right: measure(right), left: measure(left), interocularPx };
}

/**
 * @typedef {Object} GazeAngles
 * @property {number} yawDeg gaze direction relative to the camera (head and eyes together)
 * @property {number} pitchDeg
 * @property {number} eyeYawDeg the eyes' part: gaze minus head pose
 * @property {number} eyePitchDeg
 * @property {number} irisX width-weighted iris offsets the angles come from
 * @property {number} irisY
 */

/**
 * Gaze direction from the iris offsets of both eyes and the head pose (see EYE_MODEL). Each eye
 * is weighted by its apparent width, so the eye turned away from the camera counts less. Eyes
 * without iris offsets or listed in `skip` are left out.
 *
 * @param {EyeMeasures} eyes
 * @param {{ yawDeg: number, pitchDeg: number }} head
 * @param {{ skip?: Array<'left' | 'right'> }} [options]
 * @returns {GazeAngles | null}
 */
export function gazeAngles(eyes, head, { skip = [] } = {}) {
  let weight = 0;
  let irisX = 0;
  let irisY = 0;
  for (const side of /** @type {const} */ (["right", "left"])) {
    const eye = eyes[side];
    if (skip.includes(side) || eye.irisX === null || eye.irisY === null || eye.widthPx <= 0) {
      continue;
    }
    weight += eye.widthPx;
    irisX += eye.irisX * eye.widthPx;
    irisY += eye.irisY * eye.widthPx;
  }
  if (weight === 0) return null;
  irisX /= weight;
  irisY /= weight;
  const { IRIS_RADIUS_RATIO: radius, CORNER_DEPTH_RATIO: depth } = EYE_MODEL;
  // Image-plane directions: the head facing the image's right is −yaw; facing down is −pitch.
  const headRight = -head.yawDeg / DEG;
  const headDown = -head.pitchDeg / DEG;
  // The eye width is measured horizontally, so the yaw foreshortens it for both offsets.
  const widthScale = Math.cos(headRight);
  const gazeRight = asinClamped((irisX * widthScale + depth * Math.sin(headRight)) / radius);
  const gazeDown = asinClamped((irisY * widthScale + depth * Math.sin(headDown)) / radius);
  const yawDeg = -gazeRight * DEG;
  const pitchDeg = -gazeDown * DEG;
  return {
    yawDeg,
    pitchDeg,
    eyeYawDeg: yawDeg - head.yawDeg,
    eyePitchDeg: pitchDeg - head.pitchDeg,
    irisX,
    irisY,
  };
}

/**
 * Score of one blendshape category, or null.
 *
 * @param {{ names: string[], scores: ArrayLike<number> } | undefined} blendshapes
 * @param {string} name
 */
export function blendshapeScore(blendshapes, name) {
  if (!blendshapes) return null;
  const index = blendshapes.names.indexOf(name);
  return index === -1 ? null : blendshapes.scores[index];
}

/**
 * @param {(index: number) => [number, number]} point
 * @param {{ outer: number, inner: number, ear: number[] }} indices
 */
function eyeGeometry(point, indices) {
  const outer = point(indices.outer);
  const inner = point(indices.inner);
  const [p1, p2, p3, p4, p5, p6] = indices.ear.map(point);
  const widthPx = Math.hypot(outer[0] - inner[0], outer[1] - inner[1]);
  const lid = Math.sqrt(distance2(p2, p6)) + Math.sqrt(distance2(p3, p5));
  const span = Math.sqrt(distance2(p1, p4));
  return {
    center: /** @type {[number, number]} */ ([
      (outer[0] + inner[0]) / 2,
      (outer[1] + inner[1]) / 2,
    ]),
    widthPx,
    ear: span > 0 ? lid / (2 * span) : 0,
  };
}

/** @param {number[]} vector */
function normalize(vector) {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map((value) => value / length) : null;
}

/** @param {[number, number]} vector @returns {[number, number] | null} */
function normalize2(vector) {
  const length = Math.hypot(vector[0], vector[1]);
  return length > 0 ? [vector[0] / length, vector[1] / length] : null;
}

/** @param {[number, number]} a @param {[number, number]} b */
function distance2(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

/** @param {number} value */
function asinClamped(value) {
  return Math.asin(Math.min(1, Math.max(-1, value)));
}

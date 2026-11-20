import type { Point, Size } from '../types';

/**
 * ---------------------------------------------------------------------------
 * CALIBRATION STORE
 * ---------------------------------------------------------------------------
 * Persists the last calibration in the browser so a returning player does not
 * have to re-tap four reference wires every session - but ONLY when the new
 * photo genuinely matches the one it was measured on.
 *
 * Calibration is expressed in SOURCE-IMAGE pixel coordinates, so it is only
 * meaningful for a frame of the exact same geometry (same camera, same
 * resolution, same crop/framing, same phone position). `assessReuse` encodes
 * those rules; the UI still shows an alignment check before trusting a result.
 *
 * Everything here stays on device: `localStorage` only, no network.
 */

export interface CalibrationCamera {
  deviceId: string | null;
  label: string | null;
}

export interface StoredCalibration {
  version: 1;
  /** Four reference points, in source-image pixel coordinates. */
  refPoints: Point[];
  /** Size of the source image the points were measured on. */
  imageSize: Size;
  /** Camera the calibration came from, when known. */
  camera: CalibrationCamera | null;
  /** Epoch milliseconds. */
  savedAt: number;
}

export const CALIBRATION_STORAGE_KEY = 'darts-scorer.calibration.v1';

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Access itself can throw when storage is disabled by policy.
    return null;
  }
}

/** Persist the calibration. Never throws - storage is best-effort. */
export function saveCalibration(value: StoredCalibration): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Quota or private-mode failures must not break the app.
  }
}

/** Remove the stored calibration. Never throws. */
export function clearCalibration(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(CALIBRATION_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPoint(value: unknown): value is Point {
  return (
    typeof value === 'object' &&
    value !== null &&
    isFiniteNumber((value as Point).x) &&
    isFiniteNumber((value as Point).y)
  );
}

function readCamera(value: unknown): CalibrationCamera | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { deviceId?: unknown; label?: unknown };
  return {
    deviceId: typeof candidate.deviceId === 'string' ? candidate.deviceId : null,
    label: typeof candidate.label === 'string' ? candidate.label : null,
  };
}

/** Read and validate the stored calibration, or null when absent/invalid. */
export function loadCalibration(): StoredCalibration | null {
  const store = storage();
  if (!store) return null;

  let raw: string | null;
  try {
    raw = store.getItem(CALIBRATION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as Partial<StoredCalibration>;

  if (value.version !== 1) return null;
  if (!Array.isArray(value.refPoints) || !value.refPoints.every(isPoint)) return null;
  const size = value.imageSize as Size | undefined;
  if (
    typeof size !== 'object' ||
    size === null ||
    !(size.width > 0) ||
    !(size.height > 0) ||
    !isFiniteNumber(size.width) ||
    !isFiniteNumber(size.height)
  ) {
    return null;
  }
  if (!isFiniteNumber(value.savedAt)) return null;

  return {
    version: 1,
    refPoints: value.refPoints.map((p) => ({ x: p.x, y: p.y })),
    imageSize: { width: size.width, height: size.height },
    camera: value.camera == null ? null : readCamera(value.camera),
    savedAt: value.savedAt,
  };
}

export interface ReuseAssessment {
  /** True when there is no hard blocker. */
  reusable: boolean;
  /** Hard blockers that make reuse unsafe (e.g. a differently shaped photo). */
  blockers: string[];
  /** Soft caveats the user should check with the alignment overlay. */
  notes: string[];
}

/**
 * Decide whether a stored calibration can be reused for a new frame.
 *
 * Pure: no storage, no DOM, no side effects. `tolerance` is the relative
 * aspect-ratio tolerance (default 0.02 = 2%).
 */
export function assessReuse(
  stored: StoredCalibration,
  frame: Size,
  camera: CalibrationCamera | null,
  tolerance = 0.02,
): ReuseAssessment {
  const blockers: string[] = [];
  const notes: string[] = [];

  const storedAspect = stored.imageSize.width / stored.imageSize.height;
  const frameAspect = frame.width / frame.height;
  if (
    !Number.isFinite(storedAspect) ||
    !Number.isFinite(frameAspect) ||
    Math.abs(frameAspect - storedAspect) / storedAspect > tolerance
  ) {
    blockers.push("The photo's shape is different from the calibrated one.");
  }

  const storedDevice = stored.camera?.deviceId ?? null;
  const currentDevice = camera?.deviceId ?? null;
  if (storedDevice && currentDevice && storedDevice !== currentDevice) {
    blockers.push('This is a different camera.');
  }

  if (stored.imageSize.width !== frame.width || stored.imageSize.height !== frame.height) {
    notes.push('The photo resolution changed since calibration.');
  }
  if (!storedDevice || !currentDevice) {
    notes.push('The camera could not be identified; check the alignment before reuse.');
  }

  return { reusable: blockers.length === 0, blockers, notes };
}

/**
 * Map the stored reference points onto a frame of a different size. Only the
 * scale differs, which is exactly the case `assessReuse` allows past the aspect
 * check - a resolution change with identical framing.
 */
export function rescaleRefPoints(stored: StoredCalibration, frame: Size): Point[] {
  const sx = stored.imageSize.width > 0 ? frame.width / stored.imageSize.width : 1;
  const sy = stored.imageSize.height > 0 ? frame.height / stored.imageSize.height : 1;
  return stored.refPoints.map((p) => ({ x: p.x * sx, y: p.y * sy }));
}

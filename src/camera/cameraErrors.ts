/**
 * Cameras return a small set of DOMException names; everything else is a
 * surprise. Mapping them to human-readable, actionable messages in one pure
 * function keeps the composable and the UI simple and makes the mapping
 * unit-testable without a DOM.
 *
 * Reference: MediaDevices.getUserMedia error names.
 * https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
 */

export type CameraErrorCode =
  | 'insecure-origin'
  | 'unsupported-api'
  | 'permission-denied'
  | 'no-camera'
  | 'camera-busy'
  | 'overconstrained'
  | 'capture-failed'
  | 'unknown';

export interface CameraErrorInfo {
  code: CameraErrorCode;
  title: string;
  detail: string;
  /** Whether offering the photo-upload fallback makes sense here. Always true in practice. */
  suggestUpload: boolean;
}

interface NamedError {
  name?: string;
  message?: string;
}

function readName(err: unknown): string | null {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as NamedError).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return null;
}

export function describeCameraError(err: unknown): CameraErrorInfo {
  const name = readName(err);
  const rawMessage =
    err && typeof err === 'object' && typeof (err as NamedError).message === 'string'
      ? (err as NamedError).message
      : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        code: 'permission-denied',
        title: 'Camera permission denied',
        detail:
          'The browser blocked camera access. Allow camera permission for this site (check the padlock / site settings in the address bar and the browser’s per-site permissions), then try again.',
        suggestUpload: true,
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        code: 'no-camera',
        title: 'No camera found',
        detail: 'No video input device is available to this browser. Use a photo instead.',
        suggestUpload: true,
      };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        code: 'camera-busy',
        title: 'Camera is unavailable',
        detail:
          'The camera exists but could not be started. Another app or browser tab is probably using it. Close it and try again.',
        suggestUpload: true,
      };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        code: 'overconstrained',
        title: 'Camera does not support the requested settings',
        detail:
          'No camera matched the requested rear-facing configuration. Try another camera if one is listed, or use a photo instead.',
        suggestUpload: true,
      };
    case 'SecurityError':
      return {
        code: 'insecure-origin',
        title: 'Blocked for security reasons',
        detail:
          'Browsers only expose the camera over HTTPS or on localhost. Plain HTTP on a laptop LAN address will not work - see the phone testing notes below.',
        suggestUpload: true,
      };
    case 'AbortError':
      return {
        code: 'capture-failed',
        title: 'Camera start was aborted',
        detail: 'The camera start was interrupted. Try opening the camera again.',
        suggestUpload: true,
      };
    default:
      return {
        code: 'unknown',
        title: 'Could not open the camera',
        detail: rawMessage
          ? `The browser reported: ${rawMessage}`
          : 'An unexpected error occurred while starting the camera.',
        suggestUpload: true,
      };
  }
}

/**
 * Things to check before even calling getUserMedia, so the user gets a clear
 * reason instead of a vague failure.
 */
export function preflightCameraError(options: {
  isSecureContext: boolean;
  hasMediaDevices: boolean;
}): CameraErrorInfo | null {
  if (!options.isSecureContext) {
    return {
      code: 'insecure-origin',
      title: 'Camera needs HTTPS',
      detail:
        'This page is not a secure context, so the browser will not expose any camera. Camera access requires https:// or http://localhost. Opening the dev server by your laptop’s LAN IP over plain HTTP will not work.',
      suggestUpload: true,
    };
  }
  if (!options.hasMediaDevices) {
    return {
      code: 'unsupported-api',
      title: 'Camera API not available',
      detail:
        'This browser does not expose navigator.mediaDevices.getUserMedia. Use a photo instead, or try Safari, Chrome or Firefox over HTTPS.',
      suggestUpload: true,
    };
  }
  return null;
}

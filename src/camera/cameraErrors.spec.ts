import { describe, expect, it } from 'vitest';
import { describeCameraError, preflightCameraError } from './cameraErrors';

describe('describeCameraError', () => {
  const cases: Array<[string, string]> = [
    ['NotAllowedError', 'permission-denied'],
    ['PermissionDeniedError', 'permission-denied'],
    ['NotFoundError', 'no-camera'],
    ['DevicesNotFoundError', 'no-camera'],
    ['NotReadableError', 'camera-busy'],
    ['TrackStartError', 'camera-busy'],
    ['OverconstrainedError', 'overconstrained'],
    ['ConstraintNotSatisfiedError', 'overconstrained'],
    ['SecurityError', 'insecure-origin'],
    ['AbortError', 'capture-failed'],
  ];

  it.each(cases)('maps %s to %s', (name, code) => {
    const info = describeCameraError({ name });
    expect(info.code).toBe(code);
    expect(info.title.length).toBeGreaterThan(0);
    expect(info.detail.length).toBeGreaterThan(0);
    expect(info.suggestUpload).toBe(true);
  });

  it('falls back to a catch-all that surfaces the browser message', () => {
    const info = describeCameraError({ name: 'WeirdError', message: 'something odd happened' });
    expect(info.code).toBe('unknown');
    expect(info.detail).toContain('something odd happened');
  });

  it('handles non-error input without throwing', () => {
    expect(describeCameraError(null).code).toBe('unknown');
    expect(describeCameraError(undefined).code).toBe('unknown');
    expect(describeCameraError('boom').code).toBe('unknown');
    expect(describeCameraError({}).code).toBe('unknown');
  });

  it('tells the user HTTPS is required when blocked for security reasons', () => {
    expect(describeCameraError({ name: 'SecurityError' }).detail).toContain('HTTPS');
  });
});

describe('preflightCameraError', () => {
  it('passes when the context is secure and the API exists', () => {
    expect(preflightCameraError({ isSecureContext: true, hasMediaDevices: true })).toBeNull();
  });

  it('explains that a non-secure origin cannot use the camera', () => {
    const info = preflightCameraError({ isSecureContext: false, hasMediaDevices: true });
    expect(info?.code).toBe('insecure-origin');
    expect(info?.detail).toContain('https://');
    expect(info?.detail).toContain('localhost');
  });

  it('reports a missing mediaDevices API', () => {
    const info = preflightCameraError({ isSecureContext: true, hasMediaDevices: false });
    expect(info?.code).toBe('unsupported-api');
  });
});

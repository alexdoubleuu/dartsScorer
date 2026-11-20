import type { Size } from '../types';

/** Identity of the camera a frame came from, when the browser exposes it. */
export interface FrameCamera {
  deviceId: string | null;
  label: string | null;
}

/**
 * A frozen frame - the single image that everything downstream works on.
 *
 * `url` is an object URL owned by this module: call `releaseFrame` when the
 * frame is replaced or unmounted.
 *
 * `camera` is recorded so a stored calibration can be tied to the device it was
 * measured on: the same phone with a different lens is a different geometry.
 */
export interface Frame {
  url: string;
  width: number;
  height: number;
  origin: 'camera' | 'upload';
  camera?: FrameCamera | null;
}

export const MAX_UPLOAD_DIMENSION = 2400;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be decoded.'));
    img.src = url;
  });
}

/**
 * Decode a picked photo into a Frame.
 *
 * The file is drawn through a canvas so that:
 *  - the stored width/height always match the pixels we actually display, and
 *  - oversized phone photos are downscaled to something a phone can handle.
 *
 * `createImageBitmap` is asked for `imageOrientation: 'from-image'` so EXIF
 * rotation is baked into the pixels rather than being applied only at paint
 * time, which would desynchronise `naturalWidth` from what is drawn.
 */
export async function frameFromFile(file: File): Promise<Frame> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = null;
  }

  if (!bitmap) {
    return frameFromImageElement(file);
  }

  const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Could not get a 2D canvas context to process the photo.');
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return { ...(await canvasToFrame(canvas)), origin: 'upload' };
}

/** Fallback path for browsers without a usable createImageBitmap. */
async function frameFromImageElement(file: File): Promise<Frame> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get a 2D canvas context to process the photo.');
    ctx.drawImage(img, 0, 0, width, height);
    return { ...(await canvasToFrame(canvas)), origin: 'upload' };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function canvasToFrame(canvas: HTMLCanvasElement): Promise<Size & { url: string }> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92),
  );
  if (!blob) throw new Error('Could not encode the captured frame.');
  return {
    url: URL.createObjectURL(blob),
    width: canvas.width,
    height: canvas.height,
  };
}

export function releaseFrame(frame: Frame | null | undefined): void {
  if (frame) URL.revokeObjectURL(frame.url);
}

/** Draw the current video frame into a frozen Frame. */
export async function frameFromVideo(
  video: HTMLVideoElement,
  camera: FrameCamera | null = null,
): Promise<Frame> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new Error('The camera has not produced a frame yet. Wait for the preview, then capture.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D canvas context to capture the frame.');
  ctx.drawImage(video, 0, 0, width, height);
  return { ...(await canvasToFrame(canvas)), origin: 'camera', camera };
}

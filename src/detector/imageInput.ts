import type { Size } from '../types';

/**
 * ---------------------------------------------------------------------------
 * IMAGE INPUT
 * ---------------------------------------------------------------------------
 * Turns a frozen `Frame` (an object URL owned by `camera/frame.ts`) into the
 * raw `ImageData` the detector consumes.
 *
 * The detector deliberately takes pixels rather than a URL so that the
 * coordinate system it reports points in is unambiguous: it is the same
 * pixel grid the calibration reference points are stored in.
 */

/** Read a frame's pixels at its own resolution, in source-image coordinates. */
export async function imageDataFromUrl(url: string, size: Size): Promise<ImageData> {
  const decoded = await decodeImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    decoded.release();
    throw new Error('Could not get a 2D canvas context to read the photo.');
  }
  try {
    context.drawImage(decoded.source, 0, 0, size.width, size.height);
  } finally {
    decoded.release();
  }
  return context.getImageData(0, 0, size.width, size.height);
}

interface DecodedImage {
  source: CanvasImageSource;
  release: () => void;
}

/** Prefer `createImageBitmap`, but fall back to an `<img>` where it is missing. */
async function decodeImage(url: string): Promise<DecodedImage> {
  try {
    const blob = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { source: bitmap, release: () => bitmap.close() };
  } catch {
    const image = new Image();
    image.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The photo could not be decoded for detection.'));
      image.src = url;
    });
    return { source: image, release: () => undefined };
  }
}

import { Injectable } from '@angular/core';

// Vercel rejects function request bodies above 4.5 MB with a 413; keep headroom for the multipart
// framing around the files.
const UPLOAD_BUDGET_BYTES = 4 * 1024 * 1024;

// Tried in order until the whole batch fits the budget. The first step keeps Chinese characters
// legible for the vision model; the later ones trade detail for size.
const STEPS = [
  { maxDimension: 2048, quality: 0.85 },
  { maxDimension: 1600, quality: 0.75 },
  { maxDimension: 1280, quality: 0.7 },
  { maxDimension: 1024, quality: 0.6 },
];

type Step = typeof STEPS[number];

/** The images cannot be shrunk under the upload limit; the user has to send fewer of them. */
export class UploadTooLargeError extends Error {
}

@Injectable({providedIn: 'root'})
export class ImageCompressionService {

  // Downscales and re-encodes the images as JPEG so the whole upload fits under the platform's
  // request-size limit. Smaller images also make the LLM call faster.
  async compressForUpload(files: File[]): Promise<File[]> {
    if (files.length === 0) {
      return files;
    }
    const bitmaps = await Promise.all(files.map(file => this.decode(file)));
    try {
      for (const step of STEPS) {
        const encoded = await Promise.all(files.map((file, i) => this.encode(file, bitmaps[i], step)));
        if (encoded.reduce((total, file) => total + file.size, 0) <= UPLOAD_BUDGET_BYTES) {
          return encoded;
        }
      }
    } finally {
      bitmaps.forEach(bitmap => bitmap?.close());
    }
    throw new UploadTooLargeError('Tổng dung lượng ảnh quá lớn.');
  }

  private async decode(file: File): Promise<ImageBitmap | null> {
    try {
      return await createImageBitmap(file, {imageOrientation: 'from-image'});
    } catch {
      // A format this browser cannot decode (e.g. HEIC outside Safari) is uploaded unchanged.
      return null;
    }
  }

  private async encode(file: File, bitmap: ImageBitmap | null, step: Step): Promise<File> {
    if (!bitmap) {
      return file;
    }
    const scale = Math.min(1, step.maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      return file;
    }
    // JPEG has no alpha channel: paint transparent areas (PNG screenshots) white instead of black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', step.quality));
    // Re-encoding an image that is already small and compressed can make it bigger; keep it then.
    if (!blob || (scale === 1 && blob.size >= file.size)) {
      return file;
    }
    const name = file.name.replace(/\.[^.]*$/, '') + '.jpg';
    return new File([blob], name, {type: 'image/jpeg', lastModified: file.lastModified});
  }
}

import { TestBed } from '@angular/core/testing';
import { ImageCompressionService, UploadTooLargeError } from './image-compression.service';

// Random pixels barely compress, so these images stay large after every re-encoding step.
async function noiseImage(width: number, height: number, name = 'photo.png'): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  const pixels = context.createImageData(width, height);
  for (let i = 0; i < pixels.data.length; i++) {
    pixels.data[i] = (i + 1) % 4 === 0 ? 255 : Math.floor(Math.random() * 256);
  }
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/png'));
  return new File([blob], name, {type: 'image/png'});
}

describe('ImageCompressionService', () => {
  let service: ImageCompressionService;

  beforeEach(() => {
    service = TestBed.inject(ImageCompressionService);
  });

  it('downscales large images to JPEG within the upload budget', async () => {
    const files = [await noiseImage(3000, 2000, 'a.png'), await noiseImage(3000, 2000, 'b.png')];
    expect(files[0].size + files[1].size).toBeGreaterThan(4 * 1024 * 1024);

    const result = await service.compressForUpload(files);

    expect(result.length).toBe(2);
    expect(result.map(f => f.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(result.every(f => f.type === 'image/jpeg')).toBeTrue();
    expect(result[0].size + result[1].size).toBeLessThanOrEqual(4 * 1024 * 1024);
    const bitmap = await createImageBitmap(result[0]);
    expect(Math.max(bitmap.width, bitmap.height)).toBeLessThanOrEqual(2048);
  });

  it('keeps a small image that re-encoding would not shrink', async () => {
    const tiny = new File([await (await noiseImage(8, 8)).arrayBuffer()], 'tiny.png', {type: 'image/png'});
    const [result] = await service.compressForUpload([tiny]);
    expect(result).toBe(tiny);
  });

  it('uploads an undecodable file unchanged', async () => {
    const heic = new File([new Uint8Array(100)], 'photo.heic', {type: 'image/heic'});
    const [result] = await service.compressForUpload([heic]);
    expect(result).toBe(heic);
  });

  it('rejects a batch that cannot fit even at the smallest size', async () => {
    const files = await Promise.all(Array.from({length: 12}, (_, i) => noiseImage(1500, 1500, `${i}.png`)));
    await expectAsync(service.compressForUpload(files)).toBeRejectedWithError(UploadTooLargeError);
  });
});

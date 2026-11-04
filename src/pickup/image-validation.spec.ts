import { detectImageMime } from './image-validation';

describe('detectImageMime', () => {
  it('recognizes a valid PNG structure and rejects a spoofed MIME signature', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=',
      'base64',
    );

    expect(detectImageMime(png)).toBe('image/png');
    expect(detectImageMime(Buffer.from('not-an-image'))).toBeUndefined();
  });

  it('rejects PNG dimensions that could cause excessive image processing', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAA////AQABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=',
      'base64',
    );

    expect(detectImageMime(png)).toBeUndefined();
  });
});

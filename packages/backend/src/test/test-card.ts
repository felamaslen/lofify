import sharp from 'sharp';

/** Deterministic 800×600 test card — four coloured quadrants, so crops and resizes are unmistakable in image snapshots. */
export async function testCard(): Promise<Buffer> {
  const width = 800;
  const height = 600;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const left = x < width / 2;
      const top = y < height / 2;
      const [r, g, b] = top
        ? left
          ? [200, 30, 30]
          : [30, 160, 60]
        : left
          ? [30, 60, 200]
          : [230, 200, 40];
      raw[i] = r!;
      raw[i + 1] = g!;
      raw[i + 2] = b!;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

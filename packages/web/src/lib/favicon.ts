/**
 * Dynamic favicon: the playing track's cover full-bleed, with the app icon composited as a badge in the lower-right corner. Passing null restores the original icon. Artwork loads with `crossOrigin: anonymous` (the API serves CORS headers), so the canvas stays untainted and exportable.
 */

const SIZE = 64;
/** Corner rounding of the whole favicon, proportional to the app icon's own (6/32). */
const RADIUS = 12;
const BADGE = 40;

/** Badge image. The favicon link points at the SVG, but Safari rasterises dimensionless SVGs (viewBox only) as 0×0 on canvas, so the PNG app icon is drawn instead — its baked-in rounded dark background makes it read as a badge with no extra chrome. */
const APP_ICON = '/icon-192.png';

let base: { href: string; type: string } | null = null;
let applied: string | null = null;
/** Latest-wins guard: a slow artwork load must not stomp a newer track's favicon. */
let token = 0;

function faviconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

export async function setFaviconBadge(artworkUrl: string | null): Promise<void> {
  const link = faviconLink();
  if (!link) return;
  base ??= { href: link.href, type: link.type };
  if (applied === artworkUrl) return;
  applied = artworkUrl;
  const current = ++token;

  if (!artworkUrl) {
    link.href = base.href;
    link.type = base.type;
    return;
  }

  try {
    const [icon, art] = await Promise.all([loadImage(APP_ICON), loadImage(artworkUrl)]);
    if (current !== token) return;

    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Cover art fills the favicon, rounded like the app icon.
    ctx.beginPath();
    ctx.roundRect(0, 0, SIZE, SIZE, RADIUS);
    ctx.save();
    ctx.clip();
    ctx.drawImage(art, 0, 0, SIZE, SIZE);
    ctx.restore();

    // The app icon badges the lower-right corner so the tab still reads as Lofify; its baked-in rounded dark background needs no extra outline.
    const origin = SIZE - BADGE;
    ctx.drawImage(icon, origin, origin, BADGE, BADGE);

    link.href = canvas.toDataURL('image/png');
    link.type = 'image/png';
  } catch {
    // A failed load (offline, decode error) keeps whatever icon is showing; the next track retries.
    if (current === token) applied = null;
  }
}

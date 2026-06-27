import { publicUrl } from '../env.js';
import { Artwork } from '../graphql/artwork.js';
import { Image } from '../graphql/media.js';
import { artwork as resolveArtwork } from '../graphql/track.js';
import { track as lookupTrack } from '../graphql/track-queries.js';

/** Escape a string for safe interpolation into a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The shared-link landing's tab title and link-preview description for a track: "Artist — Album", falling back to the app name when both tags are blank. */
function describe(track: { artist: string | null; album: string | null }): string {
  const parts = [track.artist, track.album].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' — ') : 'Listen on Lofify';
}

/**
 * Build the app-shell HTML for a shared track link (`/share/<id>`) with Open Graph and Twitter Card metadata injected, so the link unfurls with the track's title, artist/album and cover in chat apps and crawlers that never run the SPA's JS.
 *
 * Returns `null` when the id matches no track, so the caller can fall through to the unmodified shell (the SPA then shows its own "not found" landing).
 */
export async function buildShareTrackHtml(shell: string, trackId: string): Promise<string | null> {
  const track = await lookupTrack(trackId);
  if (!track) return null;

  const title = track.title ?? 'Untitled track';
  const description = describe(track);
  const art = await resolveArtwork(track);
  const media = art instanceof Artwork ? art.media() : null;
  const image = media instanceof Image ? media.preview('SQUARE_500').src : null;
  const pageUrl = publicUrl(`/share/${encodeURIComponent(trackId)}`);

  const tags = [
    '<meta property="og:type" content="music.song" />',
    '<meta property="og:site_name" content="Lofify" />',
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:url" content="${escapeAttr(pageUrl)}" />`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${escapeAttr(title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(description)}" />`,
  ];
  if (image) {
    const escaped = escapeAttr(image);
    tags.push(
      `<meta property="og:image" content="${escaped}" />`,
      '<meta property="og:image:width" content="500" />',
      '<meta property="og:image:height" content="500" />',
      `<meta name="twitter:image" content="${escaped}" />`,
    );
  }

  const indented = tags.join('\n    ');
  return shell
    .replace(/<title>.*?<\/title>/, `<title>${escapeAttr(title)}</title>`)
    .replace('</head>', `    ${indented}\n  </head>`);
}

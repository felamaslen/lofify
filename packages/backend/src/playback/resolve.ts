/**
 * Resolve a client's `TrackFormat` request into the concrete `EncodeTarget` the cache will produce. Shared by `Track.url` (which bakes the result into the signed playback URL) and the `trackManifest` subscription (which must describe the very same bytes) — so the function is pure over `(track, request)` and both callers pass identical input.
 *
 * Below `MAX` the rule is unchanged: transcode to the requested lossy codec — unless the request sets `autoPassthrough` and the source is a lossy file the client can play verbatim, in which case it's copied through at its original quality instead (Smart's no-double-lossy upgrade). At `MAX` the server picks the best representation of the source the client can play from its preference-ordered MIME lists, preferring a passthrough copy (source codec already matches a supported format) over a transcode. Passthrough vs re-encode is decided downstream by the cache from `sourceCodec === target.codec`.
 */

import { Quality, type TrackFormat } from '../graphql/playback-format.js';
import { encodeBitrateKbps, type EncodeFormat, type EncodeTarget } from './encoder.js';

/** The bits of a track that drive format resolution. `sourceCodec` is the abbreviated on-disk codec (`'vorbis'`, `'opus'`, `'mp3'`, `'flac'`, …) — i.e. `Track.sourceFormat`. */
export type ResolveSource = {
  isLossless: boolean;
  sourceCodec: string;
};

/** Thrown when a `TrackFormat` can't be satisfied (e.g. empty `lossyFormats`, or no entry the server can transcode to). Surfaces to the client as a GraphQL error from `Track.url` / `trackManifest`. */
export class ResolveError extends Error {}

/** Codecs the lossy path can *transcode* to. Vorbis is excluded — we only ever copy into it. */
const TRANSCODABLE = new Set(['opus', 'mp3']);

/** Map a client MIME type to the `EncodeFormat` that produces it, or `null` if the server can't emit it. `audio/mpeg` carries no `codecs` parameter, so it's treated as `mp3`; everything else is keyed on the `codecs="…"` value. */
function formatForMime(raw: string): EncodeFormat | null {
  const parts = raw.split(';').map((s) => s.trim());
  const base = parts[0]?.toLowerCase();
  if (!base) return null;
  let codec: string | undefined;
  if (base === 'audio/mpeg') {
    codec = 'mp3';
  } else {
    const param = parts.slice(1).find((p) => p.toLowerCase().startsWith('codecs'));
    codec = /codecs\s*=\s*"?([^";]+)"?/i
      .exec(param ?? '')?.[1]
      ?.trim()
      .toLowerCase();
  }
  if (!codec) return null;
  switch (`${base} ${codec}`) {
    case 'audio/mp4 flac':
      return { container: 'mp4', codec: 'flac' };
    case 'audio/mp4 opus':
      return { container: 'mp4', codec: 'opus' };
    case 'audio/webm opus':
      return { container: 'webm', codec: 'opus' };
    case 'audio/webm vorbis':
      return { container: 'webm', codec: 'vorbis' };
    case 'audio/mpeg mp3':
      return { container: 'mp3', codec: 'mp3' };
    default:
      return null;
  }
}

/** Producible `EncodeFormat`s for the given MIME list, in client preference order, dropping anything the server can't emit. */
function producible(mimes: readonly string[] | null | undefined): EncodeFormat[] {
  return (mimes ?? []).map(formatForMime).filter((f): f is EncodeFormat => f !== null);
}

export function resolveTarget(source: ResolveSource, req: TrackFormat): EncodeTarget {
  const lossy = producible(req.lossyFormats);
  if (lossy.length === 0) {
    throw new ResolveError('at least one supported lossy format is required');
  }
  const firstTranscodable = lossy.find((f) => TRANSCODABLE.has(f.codec));

  if (req.quality !== Quality.MAX) {
    // Smart's no-double-lossy upgrade: a lossy source whose codec the client can play verbatim is
    // copied through at full quality rather than re-compressed to this tier. (A sub-MAX transcode is
    // always lossy, so the "would otherwise be lossy" half of the condition is implicit here.) Lossless
    // sources, and lossy sources the client can't play, fall through and transcode to the requested tier.
    if (req.autoPassthrough && !source.isLossless) {
      const copy = lossy.find((f) => f.codec === source.sourceCodec);
      if (copy) return { format: copy, quality: Quality.MAX };
    }
    // Below MAX we always transcode, into the client's first preference we can actually encode to.
    if (!firstTranscodable) throw new ResolveError('no producible lossy format to transcode to');
    return { format: firstTranscodable, quality: req.quality };
  }

  if (source.isLossless) {
    const lossless = producible(req.losslessFormats)[0];
    if (lossless) return { format: lossless, quality: Quality.MAX };
    if (!firstTranscodable)
      throw new ResolveError('no producible lossy format for lossless source');
    return { format: firstTranscodable, quality: Quality.MAX };
  }

  // Lossy source: copy into the first supported format whose codec matches, else transcode.
  const copy = lossy.find((f) => f.codec === source.sourceCodec);
  if (copy) return { format: copy, quality: Quality.MAX };
  if (!firstTranscodable) throw new ResolveError('no producible lossy format for source');
  return { format: firstTranscodable, quality: Quality.MAX };
}

/** The lossy tiers the client's adaptive controller climbs between, ascending. `MAX` is excluded — it's the `ORIGINAL` request, where the codec may differ. */
const ADAPTIVE_LADDER: readonly Quality[] = [
  Quality.MIN,
  Quality.LOW,
  Quality.MEDIUM,
  Quality.HIGH,
];

/** Expected transcode bitrate (kbps) of each adaptive ladder tier for a request, using the lossy codec sub-`MAX` qualities would transcode to (the first producible transcodable entry). Empty when the request carries no lossy codec the server can transcode to. */
export function tierBitratesKbps(
  req: TrackFormat,
): Array<{ quality: Quality; bitrateKbps: number }> {
  const firstTranscodable = producible(req.lossyFormats).find((f) => TRANSCODABLE.has(f.codec));
  if (!firstTranscodable) return [];
  return ADAPTIVE_LADDER.flatMap((quality) => {
    const bitrateKbps = encodeBitrateKbps({ format: firstTranscodable, quality });
    return bitrateKbps === null ? [] : [{ quality, bitrateKbps }];
  });
}

/** Whether a target is delivered by copying the source as-is (no re-encode). Only at MAX, where delivering the source verbatim is the intent and the resolved codec matches the source; below MAX the point is to re-encode at a lower bitrate, even when the codec happens to match. */
export function isPassthrough(target: EncodeTarget, sourceCodec: string): boolean {
  return target.quality === Quality.MAX && target.format.codec === sourceCodec.toLowerCase();
}

/** Output codecs that carry lossy compression. FLAC is the only lossless format the server emits, so everything else it produces is lossy. */
const LOSSY_OUTPUT_CODECS = new Set<EncodeFormat['codec']>(['opus', 'vorbis', 'mp3']);

/** Whether the delivery stacks a second generation of lossy compression: a lossy source re-encoded to a lossy output. A lossless source, a lossless (FLAC) output, or a verbatim passthrough copy each add no further loss, so all are false. */
export function isMultiLossy(
  source: ResolveSource,
  target: EncodeTarget,
  passthrough: boolean,
): boolean {
  if (source.isLossless || passthrough) return false;
  return LOSSY_OUTPUT_CODECS.has(target.format.codec);
}

const CODEC_LABEL: Record<EncodeFormat['codec'], string> = {
  opus: 'Opus',
  flac: 'FLAC',
  vorbis: 'Vorbis',
  mp3: 'MP3',
};

/** Short, human-readable description of how a track is being delivered, for the format tooltip. `isPassthrough` means the source is copied without re-encoding. */
export function deliveryDescription(target: EncodeTarget, isPassthrough: boolean): string {
  const label = CODEC_LABEL[target.format.codec];
  if (isPassthrough) return `Original ${label}, copied without re-encoding`;
  if (target.format.codec === 'flac') return 'Re-encoded to lossless FLAC';
  const bitrate = encodeBitrateKbps(target);
  return bitrate ? `Transcoded to ${label} at ${bitrate} kbps` : `Transcoded to ${label}`;
}

export function contentTypeFor(target: EncodeTarget): string {
  switch (target.format.container) {
    case 'mp4':
      switch (target.format.codec) {
        case 'opus':
          return 'audio/mp4; codecs="opus"';
        case 'flac':
          return 'audio/mp4; codecs="flac"';
      }
      break;
    case 'webm':
      switch (target.format.codec) {
        case 'opus':
          return 'audio/webm; codecs="opus"';
        case 'vorbis':
          return 'audio/webm; codecs="vorbis"';
      }
      break;
    case 'mp3':
      return 'audio/mpeg';
  }
}

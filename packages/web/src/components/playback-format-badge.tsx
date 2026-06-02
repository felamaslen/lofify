import { AlertTriangle, Copy, Gem, Wifi, WifiHigh, WifiLow, WifiZero } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

import { type Delivery, type Quality, usePlayer } from '../state/player.tsx';
import { Hint } from './ui/hint.tsx';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

type BadgeShape = {
  Icon: IconComponent;
  label: string;
  tone: 'accent' | 'warn' | 'muted';
  tooltip: string;
};

// Lucide's wifi family has four levels (full → zero). The four lossy tiers map one-to-one onto them, descending: high → full, medium, low, min → the bare dot.
const LOSSY_TIER_ICON: Record<Exclude<Quality, 'MAX'>, IconComponent> = {
  HIGH: Wifi,
  MEDIUM: WifiHigh,
  LOW: WifiLow,
  MIN: WifiZero,
};

/** Short codec label from the delivery MIME type. */
function codecLabel(mimeType: string): string {
  if (mimeType.includes('flac')) return 'FLAC';
  if (mimeType.includes('opus')) return 'Opus';
  if (mimeType.includes('vorbis')) return 'Vorbis';
  return 'MP3';
}

function badgeFor(quality: Quality, delivery: Delivery): BadgeShape {
  const label = codecLabel(delivery.mimeType);
  const tooltip = delivery.description;
  // FLAC is always lossless; a passthrough copy is the original bytes — both are "no quality loss".
  if (label === 'FLAC') return { Icon: Gem, label, tone: 'accent', tooltip };
  if (delivery.isPassthrough) return { Icon: Copy, label, tone: 'accent', tooltip };
  // A transcode. At MAX that means a lossy source delivered lossy (or FLAC unavailable) — flag it; below MAX it's an expected tier.
  if (quality === 'MAX') return { Icon: Wifi, label, tone: 'warn', tooltip };
  return { Icon: LOSSY_TIER_ICON[quality], label, tone: 'muted', tooltip };
}

const TONE_CLASS: Record<BadgeShape['tone'], string> = {
  accent: 'text-primary',
  warn: 'text-amber-500',
  muted: 'text-muted-foreground',
};

const MULTI_LOSSY_WARNING =
  'Lossy source re-encoded to a lossy format — a second round of compression on top of the original, so quality is reduced further.';

export function PlaybackFormatBadge() {
  const { current, requestedTier, playingQuality, delivery } = usePlayer();
  if (!current || !delivery) return null;
  // Show the tier actually under the playhead; fall back to the requested tier until the first chunk
  // reports back. Fade while they disagree — i.e. an on-the-fly switch whose buffer hasn't drained.
  const effective = playingQuality ?? requestedTier;
  const lagging = playingQuality !== null && playingQuality !== requestedTier;
  const { Icon, label, tone, tooltip } = badgeFor(effective, delivery);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {delivery.isMultiLossy && (
        <Hint content={MULTI_LOSSY_WARNING}>
          <button
            type="button"
            aria-label={MULTI_LOSSY_WARNING}
            className="inline-flex text-amber-500"
          >
            <AlertTriangle className="size-3.5" aria-hidden />
          </button>
        </Hint>
      )}
      <Hint content={tooltip}>
        <button
          type="button"
          aria-label={tooltip}
          className={`inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase leading-none tracking-wide ${TONE_CLASS[tone]} ${lagging ? 'opacity-50' : ''}`}
        >
          <Icon className="size-3" aria-hidden />
          <span>{label}</span>
        </button>
      </Hint>
    </span>
  );
}

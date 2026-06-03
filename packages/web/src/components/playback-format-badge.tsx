import {
  AlertTriangle,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Copy,
  Disc3,
  Gauge,
  Gem,
  Wand2,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

import { type Delivery, type Quality, type QualityMode, usePlayer } from '../state/player.tsx';
import { Hint } from './ui/hint.tsx';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

// The active quality policy, shown as a leading icon so the badge says both *what* is playing and
// *why* (the mode that chose it).
const MODE_INDICATOR: Record<QualityMode, { Icon: IconComponent; tooltip: string }> = {
  ADAPTIVE: { Icon: Gauge, tooltip: 'Adaptive — bitrate follows your connection speed.' },
  SMART: {
    Icon: Wand2,
    tooltip: 'Smart — lossy sources play untouched; lossless sources adapt to your connection.',
  },
  ORIGINAL: { Icon: Disc3, tooltip: 'Original — the best representation of the source.' },
};

type BadgeShape = {
  Icon: IconComponent;
  label: string;
  tone: 'accent' | 'warn' | 'muted';
  tooltip: string;
};

// A chevron ladder centred on the midpoint: the two lower tiers point down (doubled at the bottom), the two upper tiers point up (doubled at the top), so the tier reads as a position on a scale.
const LOSSY_TIER_ICON: Record<Exclude<Quality, 'MAX'>, IconComponent> = {
  MIN: ChevronsDown,
  LOW: ChevronDown,
  MEDIUM: ChevronUp,
  HIGH: ChevronsUp,
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
  // A transcode. At MAX that means a lossy source delivered lossy (or FLAC unavailable) — the top of the lossy scale, flagged amber; below MAX it's an expected tier.
  if (quality === 'MAX') return { Icon: ChevronsUp, label, tone: 'warn', tooltip };
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
  const { current, qualityMode, requestedTier, playingQuality, delivery } = usePlayer();
  if (!current || !delivery) return null;
  const mode = MODE_INDICATOR[qualityMode];
  // Show the tier actually under the playhead; fall back to the requested tier until the first chunk
  // reports back. Fade while they disagree — i.e. an on-the-fly switch whose buffer hasn't drained.
  // Not for a passthrough copy: there the server overrides the requested ladder tier with `MAX`, so
  // the two never converge — that's the resting state, not a switch in progress.
  const effective = playingQuality ?? requestedTier;
  const lagging =
    playingQuality !== null && playingQuality !== requestedTier && !delivery.isPassthrough;
  const { Icon, label, tone, tooltip } = badgeFor(effective, delivery);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span className="relative inline-flex">
        <Hint content={mode.tooltip}>
          <button
            type="button"
            aria-label={mode.tooltip}
            className="inline-flex text-muted-foreground"
          >
            <mode.Icon className="size-3.5" aria-hidden />
          </button>
        </Hint>
        {delivery.isMultiLossy && (
          <Hint content={MULTI_LOSSY_WARNING}>
            {/* A small overlay in the icon's corner, like a notification badge, with an opaque
                backing so it stays legible over the policy icon's strokes. */}
            <button
              type="button"
              aria-label={MULTI_LOSSY_WARNING}
              className="absolute -bottom-1 -right-1 inline-flex rounded-full bg-card p-px text-amber-500"
            >
              <AlertTriangle className="size-2" aria-hidden />
            </button>
          </Hint>
        )}
      </span>
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

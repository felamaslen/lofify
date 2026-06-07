import {
  AlertTriangle,
  Check,
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
import { useState } from 'react';

import { cn } from '../lib/utils.ts';
import { type Delivery, type Quality, type QualityMode, usePlayer } from '../state/player.tsx';
import { Hint } from './ui/hint.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

// The active quality policy, shown as a leading icon so the badge says both *what* is playing and
// *why* (the mode that chose it). Clicking the icon opens the quick switcher, whose rows reuse the
// same icon + blurb.
const MODE_INDICATOR: Record<QualityMode, { Icon: IconComponent; label: string; blurb: string }> = {
  ADAPTIVE: { Icon: Gauge, label: 'Adaptive', blurb: 'Bitrate follows your connection speed.' },
  SMART: {
    Icon: Wand2,
    blurb: 'Lossy sources play untouched; lossless sources adapt to your connection.',
    label: 'Smart',
  },
  ORIGINAL: { Icon: Disc3, label: 'Original', blurb: 'The best representation of the source.' },
};

const MODE_ORDER: readonly QualityMode[] = ['ADAPTIVE', 'SMART', 'ORIGINAL'];

/** The policy icon as a popover trigger: one click/tap away from switching quality mode, without a trip to the settings dialog. The active row carries a tick; selecting closes the popover immediately (a mode change may reload the track, so there's nothing left to do in it). */
function ModeQuickSwitch({ qualityMode }: { qualityMode: QualityMode }) {
  const { setQualityMode } = usePlayer();
  const [open, setOpen] = useState(false);
  const mode = MODE_INDICATOR[qualityMode];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Quality mode: ${mode.label}. Change quality mode`}
          className="inline-flex rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <mode.Icon className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 p-1">
        {MODE_ORDER.map((value) => {
          const { Icon, label, blurb } = MODE_INDICATOR[value];
          const active = value === qualityMode;
          return (
            <button
              key={value}
              type="button"
              onClick={() => {
                setQualityMode(value);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors hover:bg-accent',
                active && 'bg-accent/50',
              )}
            >
              <Icon
                className={cn(
                  'mt-px size-3.5 shrink-0',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
                aria-hidden
              />
              <span className="grid gap-0.5">
                <span className="inline-flex items-center gap-1 text-xs font-medium leading-none">
                  {label}
                  {active && <Check className="size-3 text-primary" aria-hidden />}
                </span>
                <span className="text-[11px] leading-snug text-muted-foreground">{blurb}</span>
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

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
  if (mimeType.includes('mp4a')) return 'AAC';
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
        <ModeQuickSwitch qualityMode={qualityMode} />
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

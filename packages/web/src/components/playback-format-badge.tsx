import { Gem, Wifi, WifiHigh, WifiLow } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

import { type ActualFormat, type Quality, usePlayer } from '../state/player.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

type BadgeShape = {
  Icon: IconComponent;
  label: string;
  tone: 'accent' | 'warn' | 'muted';
  tooltip: string;
};

const FORMAT_LABEL: Record<NonNullable<ActualFormat>, string> = {
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
};

// Lucide's wifi family has four levels (full → zero). With three lossy tiers we map high/medium/low onto the upper three so "low" still shows a visible arc rather than the bare dot.
const LOSSY_TIER_ICON: Record<Exclude<Quality, 'max'>, IconComponent> = {
  high: Wifi,
  medium: WifiHigh,
  low: WifiLow,
};

function badgeFor(quality: Quality, actual: ActualFormat): BadgeShape | null {
  if (!actual) return null;
  if (quality === 'max') {
    if (actual === 'flac') {
      return { Icon: Gem, label: 'FLAC', tone: 'accent', tooltip: 'Lossless · FLAC' };
    }
    return {
      Icon: Wifi,
      label: FORMAT_LABEL[actual],
      tone: 'warn',
      tooltip: `Lossless requested, but the source is lossy — delivered as ${FORMAT_LABEL[actual]}.`,
    };
  }
  return {
    Icon: LOSSY_TIER_ICON[quality],
    label: FORMAT_LABEL[actual],
    tone: 'muted',
    tooltip: `${quality[0]?.toUpperCase()}${quality.slice(1)} · ${FORMAT_LABEL[actual]}`,
  };
}

const TONE_CLASS: Record<BadgeShape['tone'], string> = {
  accent: 'text-primary',
  warn: 'text-amber-500',
  muted: 'text-muted-foreground',
};

export function PlaybackFormatBadge() {
  const { current, quality, actualFormat } = usePlayer();
  const shape = current ? badgeFor(quality, actualFormat) : null;
  if (!shape) return null;
  const { Icon, label, tone, tooltip } = shape;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase leading-none tracking-wide ${TONE_CLASS[tone]}`}
            aria-label={tooltip}
          >
            <Icon className="size-3" aria-hidden />
            <span>{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

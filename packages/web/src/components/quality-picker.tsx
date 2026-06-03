import { useState } from 'react';

import { capabilities } from '../lib/capabilities.ts';
import { cn } from '../lib/utils.ts';
import { type QualityMode, usePlayer } from '../state/player.tsx';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx';

const ADAPTIVE_TOOLTIP =
  'Automatically adjusts the bitrate to your connection speed, switching on the fly without interrupting playback.';
const SMART_TOOLTIP =
  'Adapts to your connection like Adaptive, but plays lossy tracks at their original quality when your browser can — so they’re never compressed a second time.';
const ORIGINAL_TOOLTIP_FLAC_OK =
  'The best representation of the source — lossless when supported, otherwise a copy. Assumes a connection that can keep up.';
const ORIGINAL_TOOLTIP_NO_FLAC =
  'The highest lossy preset in the selected format. This browser can’t decode FLAC-in-MP4 via MSE, so lossless sources are also delivered lossy.';

export function QualityPicker() {
  const { qualityMode, setQualityMode } = usePlayer();
  // The description below the toggle always shows a blurb: the hovered/focused choice while the
  // pointer or keyboard is on one, otherwise the selected mode's.
  const [active, setActive] = useState<QualityMode | null>(null);
  const shown = active ?? qualityMode;
  const originalTooltip = capabilities.flacInMp4
    ? ORIGINAL_TOOLTIP_FLAC_OK
    : ORIGINAL_TOOLTIP_NO_FLAC;
  const choices: { value: QualityMode; label: string; tooltip: string }[] = [
    { value: 'ADAPTIVE', label: 'Adaptive', tooltip: ADAPTIVE_TOOLTIP },
    { value: 'SMART', label: 'Smart', tooltip: SMART_TOOLTIP },
    { value: 'ORIGINAL', label: 'Original', tooltip: originalTooltip },
  ];
  return (
    <div className="grid gap-2">
      <ToggleGroup
        type="single"
        value={qualityMode}
        onValueChange={(v) => v && setQualityMode(v as QualityMode)}
        aria-label="Quality"
      >
        {choices.map((c) => (
          <ToggleGroupItem
            key={c.value}
            value={c.value}
            onMouseEnter={() => setActive(c.value)}
            onMouseLeave={() => setActive((a) => (a === c.value ? null : a))}
            onFocus={() => setActive(c.value)}
            onBlur={() => setActive((a) => (a === c.value ? null : a))}
          >
            {c.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {/* Every blurb is stacked in the same grid cell, so the row is always as tall as the longest
          one and fading between them never shifts the surrounding layout. */}
      <div className="grid" aria-live="polite">
        {choices.map((c) => (
          <p
            key={c.value}
            className={cn(
              'col-start-1 row-start-1 text-xs leading-snug text-muted-foreground transition-opacity duration-150',
              shown === c.value ? 'opacity-100' : 'opacity-0',
            )}
            aria-hidden={shown !== c.value}
          >
            {c.tooltip}
          </p>
        ))}
      </div>
    </div>
  );
}

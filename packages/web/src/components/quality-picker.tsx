import { capabilities } from '../lib/capabilities.ts';
import { type QualityMode, usePlayer } from '../state/player.tsx';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

const ADAPTIVE_TOOLTIP =
  'Automatically adjusts the bitrate to your connection speed, switching on the fly without interrupting playback.';
const ORIGINAL_TOOLTIP_FLAC_OK =
  'The best representation of the source — lossless when supported, otherwise a copy. Assumes a connection that can keep up.';
const ORIGINAL_TOOLTIP_NO_FLAC =
  'The highest lossy preset in the selected format. This browser can’t decode FLAC-in-MP4 via MSE, so lossless sources are also delivered lossy.';

export function QualityPicker() {
  const { qualityMode, setQualityMode } = usePlayer();
  const originalTooltip = capabilities.flacInMp4
    ? ORIGINAL_TOOLTIP_FLAC_OK
    : ORIGINAL_TOOLTIP_NO_FLAC;
  const choices: { value: QualityMode; label: string; tooltip: string }[] = [
    { value: 'ADAPTIVE', label: 'Adaptive', tooltip: ADAPTIVE_TOOLTIP },
    { value: 'ORIGINAL', label: 'Original', tooltip: originalTooltip },
  ];
  return (
    <TooltipProvider delayDuration={150}>
      <ToggleGroup
        type="single"
        value={qualityMode}
        onValueChange={(v) => v && setQualityMode(v as QualityMode)}
        aria-label="Quality"
      >
        {choices.map((c) => (
          <Tooltip key={c.value}>
            <TooltipTrigger asChild>
              {/* Wrap rather than merge onto the item: the trigger sets its own data-state, which would clobber the toggle's and kill the selected highlight. */}
              <span className="inline-flex">
                <ToggleGroupItem value={c.value}>{c.label}</ToggleGroupItem>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{c.tooltip}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
    </TooltipProvider>
  );
}

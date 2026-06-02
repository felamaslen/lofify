import type { LossyPreference } from '../lib/capabilities.ts';
import { usePlayer } from '../state/player.tsx';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

const CHOICES: { value: LossyPreference; label: string; unsupportedReason: string }[] = [
  { value: 'OPUS', label: 'Opus', unsupportedReason: 'Your browser cannot play Opus via MSE.' },
  { value: 'MP3', label: 'MP3', unsupportedReason: 'Your browser cannot play MP3 via MSE.' },
];

export function FormatPicker() {
  const { lossyPreference, setLossyPreference, lossyPreferenceAvailability } = usePlayer();
  return (
    <TooltipProvider delayDuration={150}>
      <ToggleGroup
        type="single"
        value={lossyPreference}
        onValueChange={(v) => v && setLossyPreference(v as LossyPreference)}
        aria-label="Preferred format"
      >
        {CHOICES.map((c) => {
          const disabled = !lossyPreferenceAvailability[c.value];
          if (!disabled)
            return (
              <ToggleGroupItem key={c.value} value={c.value}>
                {c.label}
              </ToggleGroupItem>
            );
          return (
            <Tooltip key={c.value}>
              <TooltipTrigger asChild>
                {/* A disabled item receives no pointer events, so wrap it to keep the hover target alive. */}
                <span className="inline-flex">
                  <ToggleGroupItem value={c.value} disabled>
                    {c.label}
                  </ToggleGroupItem>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{c.unsupportedReason}</TooltipContent>
            </Tooltip>
          );
        })}
      </ToggleGroup>
    </TooltipProvider>
  );
}

import type { LossyPreference } from '../lib/capabilities.ts';
import { usePlayer } from '../state/player.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

const CHOICES: { value: LossyPreference; label: string; unsupportedReason: string }[] = [
  {
    value: 'OPUS',
    label: 'Prefer Opus',
    unsupportedReason: 'Your browser cannot play Opus via MSE.',
  },
  {
    value: 'MP3',
    label: 'Prefer MP3',
    unsupportedReason: 'Your browser cannot play MP3 via MSE.',
  },
];

export function FormatPicker() {
  const { lossyPreference, setLossyPreference, lossyPreferenceAvailability } = usePlayer();
  return (
    <TooltipProvider delayDuration={150}>
      <Select
        value={lossyPreference}
        onValueChange={(v) => setLossyPreference(v as LossyPreference)}
      >
        <SelectTrigger className="w-[130px]">
          <SelectValue placeholder="Codec" />
        </SelectTrigger>
        <SelectContent>
          {CHOICES.map((c) => {
            const disabled = !lossyPreferenceAvailability[c.value];
            const item = (
              <SelectItem key={c.value} value={c.value} disabled={disabled}>
                {c.label}
              </SelectItem>
            );
            return disabled ? (
              <Tooltip key={c.value}>
                <TooltipTrigger asChild>
                  <div>{item}</div>
                </TooltipTrigger>
                <TooltipContent side="left">{c.unsupportedReason}</TooltipContent>
              </Tooltip>
            ) : (
              item
            );
          })}
        </SelectContent>
      </Select>
    </TooltipProvider>
  );
}

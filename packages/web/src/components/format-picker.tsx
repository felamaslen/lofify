import { type FormatLossy, usePlayer } from '../state/player.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

const CHOICES: { value: FormatLossy; label: string; unsupportedReason: string }[] = [
  {
    value: 'OPUS',
    label: 'Opus',
    unsupportedReason: 'Your browser cannot play Opus in fMP4 via MSE.',
  },
  {
    value: 'MP3',
    label: 'MP3',
    unsupportedReason: 'Your browser cannot play MP3 via MSE.',
  },
];

export function FormatPicker() {
  const { formatLossy, setFormatLossy, formatLossyAvailability } = usePlayer();
  return (
    <TooltipProvider delayDuration={150}>
      <Select value={formatLossy} onValueChange={(v) => setFormatLossy(v as FormatLossy)}>
        <SelectTrigger className="w-[130px]">
          <SelectValue placeholder="Format" />
        </SelectTrigger>
        <SelectContent>
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            Codec used for lossy delivery (also the fallback when Max is set on a non-lossless
            source).
          </div>
          {CHOICES.map((c) => {
            const disabled = !formatLossyAvailability[c.value];
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

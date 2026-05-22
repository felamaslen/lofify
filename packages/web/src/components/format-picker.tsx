import { type Format, usePlayer } from '../state/player.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

const CHOICES: { value: Format; label: string; unsupportedReason: string }[] = [
  {
    value: 'mp4',
    label: 'Opus (mp4)',
    unsupportedReason: 'Your browser cannot play Opus in fMP4 via MSE.',
  },
  {
    value: 'mp3',
    label: 'MP3',
    unsupportedReason: 'Your browser cannot play MP3 via MSE.',
  },
];

export function FormatPicker() {
  const { format, setFormat, formatAvailability } = usePlayer();
  return (
    <TooltipProvider delayDuration={150}>
      <Select value={format} onValueChange={(v) => setFormat(v as Format)}>
        <SelectTrigger className="w-[150px]">
          <SelectValue placeholder="Format" />
        </SelectTrigger>
        <SelectContent>
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            FLAC is used when Max quality is selected and the source is lossless.
          </div>
          {CHOICES.map((c) => {
            const disabled = !formatAvailability[c.value];
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

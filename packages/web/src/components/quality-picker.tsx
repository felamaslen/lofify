import { type Quality, usePlayer } from '../state/player.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

const CHOICES: { value: Quality; label: string }[] = [
  { value: 'max', label: 'Max (lossless)' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export function QualityPicker() {
  const { quality, setQuality, maxQualityAvailable } = usePlayer();
  return (
    <TooltipProvider delayDuration={150}>
      <Select value={quality} onValueChange={(v) => setQuality(v as Quality)}>
        <SelectTrigger className="w-[170px]">
          <SelectValue placeholder="Quality" />
        </SelectTrigger>
        <SelectContent>
          {CHOICES.map((c) => {
            const disabled = c.value === 'max' && !maxQualityAvailable;
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
                <TooltipContent side="left">
                  Your browser cannot decode FLAC, so the lossless passthrough path is unavailable.
                </TooltipContent>
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

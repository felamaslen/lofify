import { capabilities } from '../lib/capabilities.ts';
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
  { value: 'MAX', label: 'Max' },
  { value: 'HIGH', label: 'High' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'LOW', label: 'Low' },
  { value: 'MIN', label: 'Min' },
];

const MAX_TOOLTIP_FLAC_OK =
  'Lossless when the source supports it; otherwise the highest lossy preset in the selected format.';
const MAX_TOOLTIP_NO_FLAC =
  'Highest lossy preset in the selected format. This browser can’t decode FLAC-in-MP4 via MSE, so lossless sources are also delivered lossy.';

export function QualityPicker() {
  const { quality, setQuality } = usePlayer();
  const maxTooltip = capabilities.flacInMp4 ? MAX_TOOLTIP_FLAC_OK : MAX_TOOLTIP_NO_FLAC;
  return (
    <TooltipProvider delayDuration={150}>
      <Select value={quality} onValueChange={(v) => setQuality(v as Quality)}>
        <SelectTrigger className="w-[150px]">
          <SelectValue placeholder="Quality" />
        </SelectTrigger>
        <SelectContent>
          {CHOICES.map((c) =>
            c.value === 'MAX' ? (
              <Tooltip key={c.value}>
                <TooltipTrigger asChild>
                  <SelectItem value={c.value}>{c.label}</SelectItem>
                </TooltipTrigger>
                <TooltipContent side="left">{maxTooltip}</TooltipContent>
              </Tooltip>
            ) : (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
    </TooltipProvider>
  );
}

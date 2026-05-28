import { capabilities } from '../lib/capabilities.ts';
import { type QualityMode, usePlayer } from '../state/player.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

const CHOICES: { value: QualityMode; label: string }[] = [
  { value: 'ADAPTIVE', label: 'Adaptive' },
  { value: 'ORIGINAL', label: 'Original' },
];

// In a PWA we only buffer Adaptive: a single SourceBuffer is locked to one codec, and Original is
// per-track (lossless FLAC, MP3 copy, etc.), so consecutive tracks can need different decoders.
// Without the codec guarantee we can't pre-stitch the next track into the current buffer, which is
// what keeps playback going when the OS throttles JS in the background. See TODO in lib/mse.ts.
const STANDALONE_CHOICES = CHOICES.filter((c) => c.value !== 'ORIGINAL');

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
  const tooltipFor = (v: QualityMode) => (v === 'ADAPTIVE' ? ADAPTIVE_TOOLTIP : originalTooltip);
  const choices = capabilities.standalone ? STANDALONE_CHOICES : CHOICES;
  return (
    <TooltipProvider delayDuration={150}>
      <Select value={qualityMode} onValueChange={(v) => setQualityMode(v as QualityMode)}>
        <SelectTrigger className="w-[150px]">
          <SelectValue placeholder="Quality" />
        </SelectTrigger>
        <SelectContent>
          {choices.map((c) => (
            <Tooltip key={c.value}>
              <TooltipTrigger asChild>
                <SelectItem value={c.value}>{c.label}</SelectItem>
              </TooltipTrigger>
              <TooltipContent side="left">{tooltipFor(c.value)}</TooltipContent>
            </Tooltip>
          ))}
        </SelectContent>
      </Select>
    </TooltipProvider>
  );
}

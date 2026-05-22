import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.tsx';
import { usePlayer, type Format } from '../state/player.tsx';

const CHOICES: { value: Format; label: string }[] = [
  { value: 'AUTO_HI', label: 'Auto (hi)' },
  { value: 'AUTO_LO', label: 'Auto (lo)' },
  { value: 'FLAC', label: 'FLAC' },
  { value: 'WEBM', label: 'WebM' },
];

export function FormatPicker() {
  const { format, setFormat } = usePlayer();
  return (
    <Select value={format} onValueChange={(v) => setFormat(v as Format)}>
      <SelectTrigger className="w-[140px]">
        <SelectValue placeholder="Quality" />
      </SelectTrigger>
      <SelectContent>
        {CHOICES.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

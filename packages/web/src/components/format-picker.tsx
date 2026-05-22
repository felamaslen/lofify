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
    <label className="format-picker">
      Format:&nbsp;
      <select
        value={format}
        onChange={(e) => setFormat(e.target.value as Format)}
      >
        {CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}

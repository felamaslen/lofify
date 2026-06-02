import { type LucideIcon, Monitor, Moon, Sun } from 'lucide-react';

import { type Theme, useTheme } from '../state/theme.tsx';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';

const CHOICES: { value: Theme; label: string; Icon: LucideIcon }[] = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  return (
    <TooltipProvider delayDuration={150}>
      <ToggleGroup
        type="single"
        value={theme}
        onValueChange={(v) => v && setTheme(v as Theme)}
        aria-label="Theme"
      >
        {CHOICES.map(({ value, label, Icon }) => (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              {/* Wrap rather than merge onto the item: the trigger sets its own data-state, which would clobber the toggle's and kill the selected highlight. */}
              <span className="inline-flex">
                <ToggleGroupItem value={value} aria-label={label}>
                  <Icon className="h-4 w-4" />
                </ToggleGroupItem>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{label}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
    </TooltipProvider>
  );
}

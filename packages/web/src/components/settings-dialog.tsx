import { Settings } from 'lucide-react';

import { usePlayer } from '../state/player.tsx';
import { useShowDuplicates } from '../state/show-duplicates.tsx';
import { FormatPicker } from './format-picker.tsx';
import { QualityPicker } from './quality-picker.tsx';
import { RescanButton } from './rescan-button.tsx';
import { Button } from './ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog.tsx';

export function SettingsDialog() {
  const { qualityMode } = usePlayer();
  const { showDuplicates, setShowDuplicates } = useShowDuplicates();
  const formatBlurb =
    qualityMode === 'ORIGINAL'
      ? 'Used only when a source has to be transcoded — a lossy source with no matching copy. Lossless and matching sources are copied without re-encoding.'
      : 'Everything is transcoded to this codec, at a bitrate chosen automatically from your connection speed.';
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Settings">
          <Settings />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Library and playback preferences.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <section className="grid gap-2">
            <span className="text-sm font-medium">Library</span>
            <RescanButton />
            <label className="flex cursor-pointer select-none items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showDuplicates}
                onChange={(e) => setShowDuplicates(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              Show duplicate tracks
            </label>
            <span className="text-xs text-muted-foreground">
              When off, only the highest-quality copy of each duplicated recording is listed.
            </span>
          </section>
          <section className="grid gap-2">
            <span className="text-sm font-medium">Quality</span>
            <QualityPicker />
          </section>
          <section className="grid gap-2">
            <div className="grid gap-1">
              <span className="text-sm font-medium">Preferred format</span>
              <span className="text-xs text-muted-foreground">{formatBlurb}</span>
            </div>
            <FormatPicker />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

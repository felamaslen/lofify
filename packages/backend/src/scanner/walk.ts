import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../logger.js';
import { AUDIO_EXTENSION_RE } from './audio-extensions.js';

/** A discovered audio file: its absolute path with the on-disk bytes preserved verbatim, and its last-modified time in epoch milliseconds. */
export type FoundFile = { path: string; mtimeMs: number };

/** Recursively walk `root`, yielding every audio file beneath it. Reads directories directly rather than through a glob matcher, so a name's bytes survive untouched — a glob walker rewrites paths containing characters it treats as special (e.g. a literal backslash on POSIX), producing paths that no longer exist on disk. Dot-entries are skipped, matching the previous walk and steering clear of snapshot/trash directories. Symlinks are resolved so a linked file or directory is still followed. Unreadable directories and files that vanish mid-walk are skipped rather than aborting the scan. */
export async function* walkAudioFiles(
  root: string,
  signal: AbortSignal,
): AsyncGenerator<FoundFile> {
  let dir;
  try {
    dir = await opendir(root);
  } catch (err) {
    logger.warn(
      `scanner: cannot read directory ${root}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  for await (const dirent of dir) {
    if (signal.aborted) return;
    if (dirent.name.startsWith('.')) continue;
    const full = path.join(root, dirent.name);

    let isDirectory = dirent.isDirectory();
    let isFile = dirent.isFile();
    if (dirent.isSymbolicLink()) {
      // d_type describes the link itself; resolve the target to decide whether to follow it.
      try {
        const target = await stat(full);
        isDirectory = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue;
      }
    }

    if (isDirectory) {
      yield* walkAudioFiles(full, signal);
    } else if (isFile && AUDIO_EXTENSION_RE.test(dirent.name)) {
      try {
        const st = await stat(full);
        yield { path: full, mtimeMs: st.mtimeMs };
      } catch {
        // Vanished between the directory read and the stat; skip it.
      }
    }
  }
}

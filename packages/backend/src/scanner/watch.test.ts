import { copyFile, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { watchLibrary } from './watch.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

type Watcher = ReturnType<typeof watchLibrary>;

async function waitForReady(watcher: Watcher): Promise<void> {
  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
}

async function getRowOrNull(file: string) {
  const rows = await db.select().from(tracks).where(eq(tracks.file, file));
  return rows[0] ?? null;
}

async function getRow(file: string) {
  const row = await getRowOrNull(file);
  if (!row) throw new Error(`no Tracks row for ${file}`);
  return row;
}

describe('watchLibrary', () => {
  let root: string;
  let watcher: Watcher;

  beforeEach(async () => {
    await db.delete(tracks);
    root = await mkdtemp(path.join(tmpdir(), 'lofify-watch-test-'));
    watcher = watchLibrary(root);
    await waitForReady(watcher);
  });

  afterEach(async () => {
    await watcher.close();
    await rm(root, { recursive: true, force: true });
    await db.delete(tracks);
  });

  it('writes a Tracks row for an mp3 with full id3 metadata', async () => {
    const file = path.join(root, 'song.mp3');
    await copyFile(path.join(fixturesDir, 'sample.mp3'), file);

    await vi.waitFor(() =>
      expect(getRow(file)).resolves.toMatchObject({
        file,
        title: 'Test Song',
        artist: 'Test Artist',
        album: 'Test Album',
        trackNumber: 3,
        discNumber: 1,
        year: '2024',
        format: 'mpeg',
        codec: 'mpeg 2 layer 3',
        isLossless: false,
        sampleRate: 22050,
      }),
    );

    const row = await getRow(file);
    expect(row.bitRate).toBeGreaterThan(0);
    expect(row.durationSeconds).toBeGreaterThan(0);
    expect(row.sizeBytes).toBeGreaterThan(0);
  });

  it('writes an ogg vorbis row as lossy', async () => {
    const file = path.join(root, 'tune.ogg');
    await copyFile(path.join(fixturesDir, 'sample.ogg'), file);

    await vi.waitFor(() =>
      expect(getRow(file)).resolves.toMatchObject({
        file,
        title: 'Ogg Tune',
        artist: 'Ogg Artist',
        album: 'Ogg Album',
        trackNumber: 2,
        year: '2023',
        format: 'ogg',
        codec: 'vorbis i',
        isLossless: false,
      }),
    );
  });

  it('writes a flac row as lossless', async () => {
    const file = path.join(root, 'song.flac');
    await copyFile(path.join(fixturesDir, 'sample.flac'), file);

    await vi.waitFor(() =>
      expect(getRow(file)).resolves.toMatchObject({
        file,
        title: 'Lossless',
        artist: 'Flac Artist',
        album: 'Flac Album',
        year: '2022',
        format: 'flac',
        codec: 'flac',
        isLossless: true,
      }),
    );
  });

  it('updates the existing row when the file changes', async () => {
    const file = path.join(root, 'song.mp3');
    await copyFile(path.join(fixturesDir, 'sample.mp3'), file);
    await vi.waitFor(() => expect(getRow(file)).resolves.toMatchObject({ title: 'Test Song' }));
    const first = await getRow(file);

    await copyFile(path.join(fixturesDir, 'sample-updated.mp3'), file);
    await vi.waitFor(() => expect(getRow(file)).resolves.toMatchObject({ title: 'Updated' }));

    const second = await getRow(file);
    expect(second.id).toBe(first.id);
    expect(second.artist).toBe('Updated Artist');
    expect(second.trackNumber).toBe(7);

    const rows = await db.select().from(tracks).where(eq(tracks.file, file));
    expect(rows).toHaveLength(1);
  });

  it('deletes the row when the file is unlinked', async () => {
    const file = path.join(root, 'gone.flac');
    await copyFile(path.join(fixturesDir, 'sample.flac'), file);
    await vi.waitFor(() => expect(getRowOrNull(file)).resolves.not.toBeNull());

    await unlink(file);
    await vi.waitFor(() => expect(getRowOrNull(file)).resolves.toBeNull());
  });

  it('ignores non-audio files', async () => {
    const file = path.join(root, 'notes.txt');
    await writeFile(file, 'hello');
    await new Promise((r) => setTimeout(r, 300));
    await expect(getRowOrNull(file)).resolves.toBeNull();

    await unlink(file);
    await new Promise((r) => setTimeout(r, 300));
    const all = await db.select().from(tracks);
    expect(all).toHaveLength(0);
  });
});

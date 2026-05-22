import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../app.js';
import { db } from '../db/client.js';
import { tracks } from '../db/schema/index.js';
import { _resetTranscodeCache, type Entry } from '../playback/transcode.js';
import { graphql, type ResultOf } from '../test/gql.js';
import { gqlRequest } from '../test/inject.js';

const runFfmpegMock = vi.hoisted(() => vi.fn());
vi.mock('../playback/ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../playback/ffmpeg.js')>();
  return { ...actual, runFfmpeg: runFfmpegMock };
});

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scanner/__fixtures__',
);
const SAMPLE_FLAC = path.join(fixturesDir, 'sample.flac');

beforeEach(async () => {
  await db.delete(tracks);
  _resetTranscodeCache();
  runFfmpegMock.mockReset();
});

const TranscodeProgressSubscription = graphql(`
  subscription TranscodeProgress($trackId: ID!, $format: Format, $quality: Int) {
    transcodeProgress(trackId: $trackId, format: $format, quality: $quality) {
      secondsTranscoded
      bytesTranscoded
      isDone
    }
  }
`);

type Frame = NonNullable<ResultOf<typeof TranscodeProgressSubscription>>['transcodeProgress'];

async function seedTrack(): Promise<string> {
  const st = await stat(SAMPLE_FLAC);
  const [row] = await db
    .insert(tracks)
    .values({
      title: 'sample',
      trackNumber: 1,
      discNumber: 1,
      artist: 'A',
      album: 'B',
      year: null,
      format: 'flac',
      codec: 'flac',
      bitRate: null,
      sampleRate: 44_100,
      isLossless: true,
      file: SAMPLE_FLAC,
      sizeBytes: st.size,
      durationSeconds: 1,
    })
    .returning({ id: tracks.id });
  return row!.id;
}

function fakeTranscode(): {
  emit: (seconds: number, bytes: number) => void;
  finish: () => void;
  waitForStart: () => Promise<void>;
} {
  let entry: Entry | null = null;
  let resolveDone: (() => void) | null = null;
  let onStart: (() => void) | null = null;
  runFfmpegMock.mockImplementation((e: Entry) => {
    entry = e;
    onStart?.();
    return new Promise<void>((res) => {
      resolveDone = res;
    });
  });
  return {
    emit: (seconds, bytes) => {
      if (!entry) throw new Error('no transcode in flight');
      entry.transcodedSeconds = seconds;
      entry.bytes = bytes;
      entry.emitter.emit('progress');
    },
    finish: () => {
      if (!entry) throw new Error('no transcode in flight');
      entry.done = true;
      resolveDone?.();
      entry.emitter.emit('done');
    },
    waitForStart: () =>
      new Promise<void>((resolve) => {
        if (entry) resolve();
        else onStart = resolve;
      }),
  };
}

test('Subscription.transcodeProgress emits an initial frame, throttles, and ends on done', async () => {
  const id = await seedTrack();
  const fake = fakeTranscode();

  const iterator = gqlRequest(app)
    .subscribe(TranscodeProgressSubscription)
    .variables({ trackId: id, format: 'WEBM', quality: null });

  const frames: Frame[] = [];
  const collect = (async () => {
    for await (const event of iterator) {
      if (event.data?.transcodeProgress) frames.push(event.data.transcodeProgress);
    }
  })();

  await fake.waitForStart();
  fake.emit(2.5, 40_000);
  // Give the subscription a moment to debounce/emit, then finish so the stream
  // closes and the for-await loop exits.
  await new Promise((r) => setTimeout(r, 1100));
  fake.emit(7, 112_000);
  fake.finish();
  await collect;

  expect(frames.length).toBeGreaterThanOrEqual(2);
  expect(frames[0]).toMatchObject({ secondsTranscoded: 0, bytesTranscoded: 0, isDone: false });
  const last = frames.at(-1)!;
  expect(last.isDone).toBe(true);
  expect(last.secondsTranscoded).toBe(7);
  expect(last.bytesTranscoded).toBe(112_000);
}, 10_000);

test('Subscription.transcodeProgress throttles updates to at most once per second', async () => {
  const id = await seedTrack();
  const fake = fakeTranscode();

  const iterator = gqlRequest(app)
    .subscribe(TranscodeProgressSubscription)
    .variables({ trackId: id, format: 'WEBM', quality: null });

  const frameTimes: number[] = [];
  const collect = (async () => {
    for await (const event of iterator) {
      if (event.data?.transcodeProgress) frameTimes.push(Date.now());
    }
  })();

  await fake.waitForStart();
  // Fire a burst of progress events well under the 1s throttle window. The
  // subscription should still emit at most one frame per second.
  for (let i = 1; i <= 10; i++) {
    fake.emit(i * 0.1, i * 1_000);
    await new Promise((r) => setTimeout(r, 30));
  }
  fake.finish();
  await collect;

  // Initial frame + (one per throttle window) + final frame. With ~300ms of
  // burst activity we expect ≤ 3 frames total.
  expect(frameTimes.length).toBeLessThanOrEqual(3);
  for (let i = 1; i < frameTimes.length; i++) {
    const delta = frameTimes[i]! - frameTimes[i - 1]!;
    // Allow ~50ms slack for scheduler jitter; the throttle is 1000ms.
    expect(delta).toBeGreaterThanOrEqual(950);
  }
}, 10_000);

test('Subscription.transcodeProgress returns a single done frame for passthrough playback', async () => {
  const id = await seedTrack();

  const iterator = gqlRequest(app)
    .subscribe(TranscodeProgressSubscription)
    .variables({ trackId: id, format: 'FLAC', quality: null });

  const frames: Frame[] = [];
  for await (const event of iterator) {
    if (event.data?.transcodeProgress) frames.push(event.data.transcodeProgress);
  }

  // FLAC source + FLAC requested + no quality → passthrough, no transcode
  // process, subscription closes immediately after the synthetic done frame.
  expect(runFfmpegMock).not.toHaveBeenCalled();
  expect(frames).toEqual([{ secondsTranscoded: 0, bytesTranscoded: 0, isDone: true }]);
});


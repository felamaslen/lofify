/**
 * MSE-backed playback pipeline.
 *
 * A `Player` owns the audio element's source for the lifetime of a single track. Seeking inside an already-buffered region is a native `currentTime` assignment; seeking outside aborts the in-flight fetch and issues a fresh `Range` request against the same URL (no new ffmpeg job — the server serves out of its existing cache entry), then appends into the same `SourceBuffer` with `timestampOffset` set so the audio element's timeline still matches the track's real time.
 *
 * For codecs MSE can't decode (FLAC passthrough, OGG/Vorbis) `createPlayer` falls back to a plain `audio.src = url`; seeks then behave like the browser's default.
 */

/** Bias byte estimates a touch low so VBR variation undershoots rather than overshoots — undershoot just downloads a few extra bytes, overshoot strands the audio element in unbuffered territory. */
const SEEK_SAFETY_FACTOR = 0.95;

export interface Player {
  /**
   * Seek to `time` seconds on the track's timeline. Native if buffered; otherwise re-fetches from a byte offset derived from `bytesPerSecond`.
   *
   * The caller supplies `bytesPerSecond` (from the server's `transcodeProgress` subscription — `bytesTranscoded / secondsTranscoded`). Passing 0 falls back to a native seek without re-fetching, useful when the caller has no estimate yet.
   */
  seekTo(time: number, bytesPerSecond: number): Promise<void>;
  /** Tear down: aborts in-flight fetch, ends the MediaSource, revokes the blob URL. */
  dispose(): void;
}

class DirectPlayer implements Player {
  constructor(private audio: HTMLAudioElement) {}
  async seekTo(time: number): Promise<void> {
    this.audio.currentTime = time;
  }
  dispose(): void {
    // nothing to clean up — caller owns audio.src
  }
}



class MsePlayer implements Player {
  private currentAbort: AbortController | null = null;
  private appendQueue: Uint8Array[] = [];
  private streamDone = false;
  private endedSignalled = false;
  private disposed = false;

  constructor(
    private audio: HTMLAudioElement,
    private url: string,
    private mediaSource: MediaSource,
    private sourceBuffer: SourceBuffer,
    private blobUrl: string,
  ) {
    sourceBuffer.addEventListener('updateend', () => {
      this.drain();
      this.tryEndOfStream();
    });
  }

  /** Consume an already-started fetch response as the initial byte stream. Takes ownership of the abort controller so subsequent seeks can cancel it. */
  consumeInitialResponse(body: ReadableStream<Uint8Array>, abort: AbortController): void {
    this.currentAbort = abort;
    void this.pumpBody(body, abort.signal);
  }

  async seekTo(time: number, bytesPerSecond: number): Promise<void> {
    if (this.disposed) return;
    const buffered = this.audio.buffered;
    for (let i = 0; i < buffered.length; i++) {
      if (time >= buffered.start(i) && time <= buffered.end(i)) {
        this.audio.currentTime = time;
        return;
      }
    }

    this.currentAbort?.abort();
    this.appendQueue.length = 0;
    await this.waitForIdle();
    if (this.disposed) return;

    const byteOffset =
      bytesPerSecond > 0 ? Math.max(0, Math.floor(time * bytesPerSecond * SEEK_SAFETY_FACTOR)) : 0;
    try {
      this.sourceBuffer.timestampOffset = time;
    } catch {
      // SB may be in a bad state if disposed concurrently
      return;
    }
    this.streamDone = false;
    this.endedSignalled = false;
    this.audio.currentTime = time;

    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    void this.fetchAndPump(byteOffset, ctrl.signal);
  }

  dispose(): void {
    this.disposed = true;
    this.currentAbort?.abort();
    if (this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // already ended
      }
    }
    URL.revokeObjectURL(this.blobUrl);
  }

  private waitForIdle(): Promise<void> {
    if (!this.sourceBuffer.updating) return Promise.resolve();
    return new Promise((resolve) => {
      const onEnd = (): void => {
        this.sourceBuffer.removeEventListener('updateend', onEnd);
        resolve();
      };
      this.sourceBuffer.addEventListener('updateend', onEnd);
    });
  }

  private async fetchAndPump(byteOffset: number, signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = {};
    if (byteOffset > 0) headers.Range = `bytes=${byteOffset}-`;
    let response: Response;
    try {
      response = await fetch(this.url, { headers, signal });
    } catch {
      return;
    }
    if (!response.ok || !response.body) {
      response.body?.cancel().catch(() => undefined);
      return;
    }
    await this.pumpBody(response.body, signal);
  }

  private async pumpBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const onAbort = (): void => {
      reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal.aborted) {
        let result;
        try {
          result = await reader.read();
        } catch {
          return;
        }
        if (result.done) {
          this.streamDone = true;
          this.tryEndOfStream();
          return;
        }
        this.appendQueue.push(result.value);
        this.drain();
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private drain(): void {
    if (this.disposed) return;
    if (this.sourceBuffer.updating || this.appendQueue.length === 0) return;
    try {
      const chunk = this.appendQueue.shift()!;
      this.sourceBuffer.appendBuffer(chunk.slice().buffer);
    } catch {
      // QuotaExceeded or invalid state — a production player would evict here
    }
  }

  private tryEndOfStream(): void {
    if (
      this.streamDone &&
      !this.endedSignalled &&
      !this.sourceBuffer.updating &&
      this.appendQueue.length === 0 &&
      this.mediaSource.readyState === 'open'
    ) {
      this.endedSignalled = true;
      try {
        this.mediaSource.endOfStream();
      } catch {
        // already ended or closing
      }
    }
  }
}

export async function createPlayer(audio: HTMLAudioElement, url: string): Promise<Player> {
  const probeAbort = new AbortController();
  let response: Response;
  try {
    response = await fetch(url, { signal: probeAbort.signal });
  } catch {
    audio.src = url;
    return new DirectPlayer(audio);
  }
  if (!response.ok || !response.body) {
    response.body?.cancel().catch(() => undefined);
    audio.src = url;
    return new DirectPlayer(audio);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(contentType)) {
    response.body.cancel().catch(() => undefined);
    audio.src = url;
    return new DirectPlayer(audio);
  }

  const mediaSource = new MediaSource();
  const blobUrl = URL.createObjectURL(mediaSource);
  audio.src = blobUrl;
  await new Promise<void>((resolve) => {
    mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
  });
  const sourceBuffer = mediaSource.addSourceBuffer(contentType);

  const player = new MsePlayer(audio, url, mediaSource, sourceBuffer, blobUrl);
  player.consumeInitialResponse(response.body, probeAbort);
  return player;
}

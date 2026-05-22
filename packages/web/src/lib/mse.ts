/**
 * Attach an audio source to `audio`, preferring MSE for streamable codecs.
 *
 * MSE driving solves the in-progress-transcode playback bug: with a plain `<audio src>`, when a 206 response with `Content-Range: bytes N-M/*` completes Chrome fires `'ended'` even though more bytes are coming. Here we own the byte pump — we append chunks to a `SourceBuffer` as they arrive and only call `mediaSource.endOfStream()` when the fetch actually finishes. `'ended'` then fires when playback genuinely reaches end-of-media.
 *
 * Falls back to setting `audio.src = url` for unsupported codecs (FLAC passthrough, OGG/Vorbis), where the bug doesn't apply or applies less commonly.
 *
 * @param audio - the audio element to attach the source to
 * @param url - the playback URL to fetch
 * @param signal - abort signal; aborting tears down the fetch, the SourceBuffer, and the MediaSource
 */
export async function attachAudioSource(
  audio: HTMLAudioElement,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch {
    if (signal.aborted) return;
    audio.src = url;
    return;
  }
  if (!response.ok || !response.body) {
    response.body?.cancel().catch(() => undefined);
    audio.src = url;
    return;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(contentType)) {
    response.body.cancel().catch(() => undefined);
    audio.src = url;
    return;
  }
  await pumpIntoMediaSource(audio, response.body, contentType, signal);
}

async function pumpIntoMediaSource(
  audio: HTMLAudioElement,
  body: ReadableStream<Uint8Array>,
  mimeType: string,
  signal: AbortSignal,
): Promise<void> {
  const mediaSource = new MediaSource();
  audio.src = URL.createObjectURL(mediaSource);

  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const cleanup = (): void => {
      mediaSource.removeEventListener('sourceopen', onOpen);
      signal.removeEventListener('abort', onAbort);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error('aborted'));
    };
    mediaSource.addEventListener('sourceopen', onOpen);
    signal.addEventListener('abort', onAbort);
  });

  const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
  const reader = body.getReader();
  const queue: Uint8Array[] = [];
  let streamDone = false;
  let endedSignalled = false;

  const tryEndOfStream = (): void => {
    if (
      streamDone &&
      !endedSignalled &&
      !sourceBuffer.updating &&
      queue.length === 0 &&
      mediaSource.readyState === 'open'
    ) {
      endedSignalled = true;
      try {
        mediaSource.endOfStream();
      } catch {
        // already ended or closing
      }
    }
  };

  const drain = (): void => {
    if (signal.aborted || sourceBuffer.updating || queue.length === 0) return;
    try {
      const chunk = queue.shift()!;
      sourceBuffer.appendBuffer(chunk.slice().buffer);
    } catch {
      // QuotaExceeded etc. — silently drop; a real player would evict here
    }
  };

  sourceBuffer.addEventListener('updateend', () => {
    drain();
    tryEndOfStream();
  });

  signal.addEventListener(
    'abort',
    () => {
      reader.cancel().catch(() => undefined);
      if (mediaSource.readyState === 'open') {
        try {
          mediaSource.endOfStream();
        } catch {
          // ignore
        }
      }
    },
    { once: true },
  );

  void (async () => {
    while (!signal.aborted) {
      let result;
      try {
        result = await reader.read();
      } catch {
        return;
      }
      if (result.done) {
        streamDone = true;
        tryEndOfStream();
        return;
      }
      queue.push(result.value);
      drain();
    }
  })();
}

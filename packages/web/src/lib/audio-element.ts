// The single detached <audio> element the player drives, owned at module
// scope rather than by a React component. Keeping it here means a
// `PlayerProvider` remount reuses the same element instead of creating a
// fresh one, so playback survives re-renders. The `import.meta.hot` glue
// carries the live element (and its attached MediaSource) across Vite HMR
// updates of this module, so editing UI doesn't interrupt playback.

let element: HTMLAudioElement | null = import.meta.hot?.data.audioElement ?? null;

/** The shared playback `<audio>` element, created lazily on first use. Returns null in non-browser environments. */
export function getAudioElement(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!element) {
    element = new Audio();
    element.preload = 'metadata';
  }
  return element;
}

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose((data) => {
    data.audioElement = element;
  });
}

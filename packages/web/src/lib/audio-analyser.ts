// Web Audio tap on the shared playback <audio> element, feeding the
// visualiser's spectrum. Created lazily the first time the visualiser is
// opened — until then there is no AudioContext at all.
//
// The tap is a *parallel* `captureStream()` of the element, analysed through a
// MediaStream source. The element keeps playing straight to the output: we
// never call `createMediaElementSource` (which reroutes the element's whole
// output through the context — the cause of the audible hiccup on open) and
// never connect to a destination that carries audio. So opening the visualiser
// doesn't interrupt playback, and playback never depends on the context's
// state (a suspended context just freezes the visualiser, not the sound).
//
// The analyser is connected through a muted gain into the destination only so
// the graph is pulled in browsers that won't process a node with no path to
// the destination; that path outputs silence.
//
// `captureStream` is Chromium/Firefox only (Safari lacks it), so the visualiser
// is desktop-Chromium/Firefox; the button is feature-gated on
// `isVisualiserSupported`. State lives at module scope and rides Vite HMR like
// the element itself.

import { getAudioElement } from './audio-element.ts';

type Tap = {
  context: AudioContext;
  analyser: AnalyserNode;
  capture: () => MediaStream;
  source: MediaStreamAudioSourceNode | null;
  boundTrack: MediaStreamTrack | null;
};

type WindowWithWebkit = Window & { webkitAudioContext?: typeof AudioContext };
type MediaElementWithCapture = HTMLMediaElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

function audioContextCtor(): typeof AudioContext | undefined {
  return window.AudioContext ?? (window as WindowWithWebkit).webkitAudioContext;
}

function captureFn(audio: HTMLMediaElement): (() => MediaStream) | undefined {
  const el = audio as MediaElementWithCapture;
  const fn = el.captureStream ?? el.mozCaptureStream;
  return fn ? fn.bind(el) : undefined;
}

let tap: Tap | null = import.meta.hot?.data.analyserTap ?? null;

/**
 * (Re)bind the analyser to the element's current live audio track. The capture stream's track ends whenever the player reassigns `audio.src` — a codec switch or a fresh track load — which leaves the old `MediaStreamAudioSourceNode` dead and the visualiser silent. Rebinding from a fresh capture picks up the new track.
 *
 * No-op when the live track is already bound, or while no track is present yet (a later media event rebinds).
 */
function bindStream(t: Tap): void {
  const stream = t.capture();
  const track = stream.getAudioTracks()[0] ?? null;
  if (!track) return;
  if (t.source && track === t.boundTrack && track.readyState === 'live') return;
  t.source?.disconnect();
  const source = t.context.createMediaStreamSource(stream);
  source.connect(t.analyser);
  t.source = source;
  t.boundTrack = track;
}

/** Whether the browser can drive the visualiser — a Web Audio context plus `captureStream` on media elements (Chromium/Firefox; not Safari). Pure capability probe; creates nothing. */
export function isVisualiserSupported(): boolean {
  if (typeof window === 'undefined' || !audioContextCtor()) return false;
  if (typeof HTMLMediaElement === 'undefined') return false;
  const proto = HTMLMediaElement.prototype;
  return 'captureStream' in proto || 'mozCaptureStream' in proto;
}

/** The shared `AnalyserNode`, tapping the playback element's audio on first call and rebinding to its current track on every call, then resuming the context — call it from a user gesture so the resume is allowed. Returns `null` when the visualiser isn't supported. */
export function getAnalyser(): AnalyserNode | null {
  if (typeof window === 'undefined') return null;
  if (!tap) {
    const audio = getAudioElement();
    const Ctor = audioContextCtor();
    const capture = audio ? captureFn(audio) : undefined;
    if (!audio || !Ctor || !capture) return null;
    const context = new Ctor();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;
    const mute = context.createGain();
    mute.gain.value = 0;
    analyser.connect(mute);
    mute.connect(context.destination);
    tap = { context, analyser, capture, source: null, boundTrack: null };
    // Follow the song: the player reassigns `audio.src` on a track change, so
    // rebind when the element loads/resumes new media (even while the
    // visualiser is closed, so a later reopen finds the live track bound).
    const rebind = () => {
      if (tap) bindStream(tap);
    };
    audio.addEventListener('loadeddata', rebind);
    audio.addEventListener('playing', rebind);
  }
  bindStream(tap);
  void tap.context.resume();
  return tap.analyser;
}

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose((data) => {
    data.analyserTap = tap;
  });
}

import { useEffect, useRef } from 'react';

import { getAnalyser } from '../lib/audio-analyser.ts';

const TWO_PI = Math.PI * 2;

/** A bass onset's expanding ring: `life` fades 1→0 as it grows outward. */
type Ring = { radius: number; life: number; hue: number };

/** A treble-flung spark drifting outward from the rim, fading as it goes. */
type Spark = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  hue: number;
  size: number;
};

// Eight log-spaced analysis bands (bass → brilliance), each driving a distinct
// angular harmonic of the blob's rim: low bands make a few big slow lobes, high
// bands many fine ripples. So the *shape* — not just the size — reflects the
// spectral balance, and different timbres read as structurally different forms.
const BANDS = 8;
// Low, mostly-consecutive lobe counts so the rim stays rounded, with `1/k`
// weighting so the lowest bands dominate the form (big gentle swells) and the
// highs add only a whisper of detail.
const HARMONICS = [2, 3, 4, 5, 6, 7, 8, 9];
const RAW_WEIGHTS = HARMONICS.map((k) => 1 / k);
const WEIGHT_SUM = RAW_WEIGHTS.reduce((a, b) => a + b, 0);
const WEIGHTS = RAW_WEIGHTS.map((w) => w / WEIGHT_SUM);

// Colour. Each band paints its own additive shell (bass inner, treble outer),
// so coexisting timbres show as coexisting colours. On top of that the whole
// palette is *rotated by the overall timbre* (brightness): bands span
// `HUE_SPREAD` degrees from a rotating base, so a dark track and a bright track
// land on entirely different colour schemes.
const HUE_SPREAD = 230;

const POINTS = 140;

// Debounce window for the timbre descriptors (flatness, flux): they're computed
// per-frame and spiky, so without smoothing a split-second transient — a cymbal
// hit, a stray peak — whips the roughness/swirl and then reverts. Low-passing
// with this ~0.6s time constant means only a *sustained* change registers.
const TAU_TIMBRE = 0.6;
// The overall-timbre palette rotation eases slowly: a track's colour scheme
// should feel like a stable identity, drifting only across sections.
const TAU_PALETTE = 1.0;

/**
 * Full-bleed "aurora" visualiser of the playing track, reading the shared Web Audio analyser each frame and mapping timbral features to composable, simultaneously-visible layers — so different music looks different and layered music looks layered.
 *
 * A soft glowing blob punches with each bass kick; its rim is a sum of low angular harmonics driven by eight log-spaced frequency bands, so it stays rounded while coexisting timbres swell it together. Each band paints its own additive colour shell (bass inner, treble outer), and the whole palette is rotated by the overall timbre (brightness) so different tracks land on different colour schemes while present bands still show their own hues. Spectral flatness roughens the rim only for noisy material; spectral flux sets the swirl speed; treble flings sparks off the rim; and a bass onset fires an expanding ring. Replaces the track list while active.
 */
export function Visualiser() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const analyser = getAnalyser();
    if (!canvas || !ctx || !analyser) return;

    const n = analyser.frequencyBinCount;
    const freq = new Uint8Array(n);
    const prevFreq = new Float32Array(n);

    // Log-spaced band edges in bin indices, skipping the DC bin.
    const minBin = 1;
    const maxBin = Math.min(700, n - 1);
    const edges: number[] = [];
    for (let i = 0; i <= BANDS; i++) {
      edges.push(Math.round(minBin * (maxBin / minBin) ** (i / BANDS)));
    }

    const px = new Float32Array(POINTS);
    const py = new Float32Array(POINTS);
    const bandAmp = new Float32Array(BANDS); // fast, drives the shape
    const bandPhase = new Float32Array(BANDS);
    const rings: Ring[] = [];
    const sparks: Spark[] = [];

    let dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let bassAvg = 0; // slow envelope, the onset detector's baseline
    let flatnessS = 0; // debounced rim roughness
    let fluxS = 0; // debounced swirl rate
    let brightnessS = 0; // slow overall-timbre signal, rotates the palette
    let pulse = 0; // bass envelope: fast attack, slow release → punches on each kick
    let flash = 0; // central beat flash, 0..1
    let spin = 0; // accumulated whole-blob rotation
    let lastBeat = 0;
    let lastTime = 0;
    let raf = 0;

    const draw = (time: number) => {
      raf = requestAnimationFrame(draw);
      const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0.016;
      lastTime = time;

      analyser.getByteFrequencyData(freq);
      const ampEase = Math.min(dt * 7, 1);

      // Per-band energy, eased — drives the rim shape. `bassRaw` is the
      // *unsmoothed* low end, so the pulse below can punch.
      let bassRaw = 0;
      for (let i = 0; i < BANDS; i++) {
        const from = edges[i]!;
        const to = edges[i + 1]!;
        let sum = 0;
        for (let b = from; b < to; b++) sum += freq[b] ?? 0;
        const raw = sum / (Math.max(1, to - from) * 255);
        if (i < 2) bassRaw += raw / 2;
        bandAmp[i] = bandAmp[i]! + (raw - bandAmp[i]!) * ampEase;
      }
      const treble = (bandAmp[BANDS - 1]! + bandAmp[BANDS - 2]!) / 2;

      // Flux (rising-edge change) → swirl; flatness (geometric/arithmetic mean)
      // → rim roughness. Both whole-spectrum motion/texture, not a category.
      let flux = 0;
      let logSum = 0;
      let linSum = 0;
      let num = 0;
      let den = 0;
      const span = Math.min(400, n);
      for (let i = 1; i < span; i++) {
        const m = freq[i] ?? 0;
        const d = m - prevFreq[i]!;
        if (d > 0) flux += d;
        prevFreq[i] = m;
        const norm = m / 255 + 1e-5;
        logSum += Math.log(norm);
        linSum += norm;
        num += i * m;
        den += m;
      }
      const fluxRaw = flux / (span * 255);
      const flatnessRaw = linSum > 0 ? Math.exp(logSum / (span - 1)) / (linSum / (span - 1)) : 0;
      const brightness = den > 0 ? num / den / span : 0;

      const timbreK = 1 - Math.exp(-dt / TAU_TIMBRE);
      fluxS += (fluxRaw - fluxS) * timbreK;
      flatnessS += (flatnessRaw - flatnessS) * timbreK;
      brightnessS += (brightness - brightnessS) * (1 - Math.exp(-dt / TAU_PALETTE));

      // Rotate the whole colour palette by the overall brightness; each band's
      // hue sits at a fixed offset from this rotating base.
      const paletteBase = Math.min(1, brightnessS * 3) * 300;
      const bandHueAt = (i: number) => (paletteBase + (i / (BANDS - 1)) * HUE_SPREAD) % 360;

      // Envelope follower: snap up on a rising kick (~12ms), ease back down
      // (~220ms), so every bass pulse punches the blob and it settles between.
      const attackK = 1 - Math.exp(-dt / 0.012);
      const releaseK = 1 - Math.exp(-dt / 0.22);
      pulse += (bassRaw - pulse) * (bassRaw > pulse ? attackK : releaseK);

      if (bassRaw > bassAvg * 1.4 && bassRaw > 0.28 && time - lastBeat > 220) {
        lastBeat = time;
        flash = 1;
        rings.push({ radius: 0, life: 1, hue: bandHueAt(0) });
      }
      bassAvg += (bassRaw - bassAvg) * 0.06;
      flash = Math.max(0, flash - dt / 0.25);

      // Advance the per-band phases (alternating directions → swirl) and the
      // whole-blob spin, both faster when the spectrum is busy.
      for (let i = 0; i < BANDS; i++) {
        bandPhase[i] = bandPhase[i]! + dt * (i % 2 ? 1 : -1) * (0.4 + i * 0.12) * (0.6 + fluxS * 6);
      }
      spin += dt * (0.05 + fluxS * 5 + treble * 0.5);

      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const minSide = Math.min(w, h);
      ctx.clearRect(0, 0, w, h);

      const idle = (Math.sin(time / 1500) + 1) * 0.04;
      const baseR = minSide * 0.14 + (pulse + idle) * minSide * 0.16;
      const deform = 0.4;
      // Square the flatness so only genuinely noisy material roughens the edge
      // (a tonal track's small baseline flatness stays smooth), and keep the
      // ripple at a low angular frequency so it undulates rather than spikes.
      const rough = flatnessS * flatnessS * 0.3;

      // Compound rim: every band's lobes coexist, plus a flatness micro-ripple.
      for (let i = 0; i < POINTS; i++) {
        const a = (i / POINTS) * TWO_PI;
        let s = 0;
        for (let band = 0; band < BANDS; band++) {
          s += bandAmp[band]! * WEIGHTS[band]! * Math.cos(HARMONICS[band]! * a + bandPhase[band]!);
        }
        s += rough * Math.cos(9 * a + spin * 2);
        const r = Math.max(baseR * 0.35, baseR * (1 + deform * s));
        const da = a + spin - Math.PI / 2;
        px[i] = cx + Math.cos(da) * r;
        py[i] = cy + Math.sin(da) * r;
      }

      const blob = new Path2D();
      let mx = (px[POINTS - 1]! + px[0]!) / 2;
      let my = (py[POINTS - 1]! + py[0]!) / 2;
      blob.moveTo(mx, my);
      for (let i = 0; i < POINTS; i++) {
        const next = (i + 1) % POINTS;
        mx = (px[i]! + px[next]!) / 2;
        my = (py[i]! + py[next]!) / 2;
        blob.quadraticCurveTo(px[i]!, py[i]!, mx, my);
      }
      blob.closePath();

      // The two palette ends: `from` (low-end hue) at the core, `to` (high-end
      // hue) at the rim — both from the palette the overall timbre rotates.
      const hueFrom = bandHueAt(0);
      const hueTo = bandHueAt(BANDS - 1);

      // Beat rings, behind the blob, additively blended for a glow.
      ctx.globalCompositeOperation = 'lighter';
      const ringSpeed = minSide * 0.9;
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i]!;
        ring.radius += ringSpeed * dt;
        ring.life -= dt / 0.9;
        if (ring.life <= 0) {
          rings.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(cx, cy, ring.radius, 0, TWO_PI);
        ctx.strokeStyle = `hsla(${ring.hue}, 90%, 62%, ${ring.life * 0.5})`;
        ctx.lineWidth = Math.max(1, minSide * 0.006 * ring.life);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';

      // Fill: a simple two-stop radial gradient, from → to, with a bloom shadow.
      const grad = ctx.createRadialGradient(cx, cy, baseR * 0.1, cx, cy, baseR * 1.35);
      grad.addColorStop(0, `hsla(${hueFrom}, 95%, 64%, 0.95)`);
      grad.addColorStop(1, `hsla(${hueTo}, 90%, 52%, 0.85)`);
      ctx.fillStyle = grad;
      ctx.shadowColor = `hsla(${hueTo}, 95%, 55%, 0.8)`;
      ctx.shadowBlur = minSide * 0.08;
      ctx.fill(blob);
      ctx.shadowBlur = 0;

      if (flash > 0) {
        ctx.beginPath();
        ctx.arc(cx, cy, baseR * 0.5, 0, TWO_PI);
        ctx.fillStyle = `hsla(${hueTo}, 100%, 85%, ${flash * 0.6})`;
        ctx.fill();
      }

      // Treble sparks: flung off the rim when the high end is energetic, more so
      // when the spectrum is changing fast. Bass-only music makes none.
      let toSpawn = treble > 0.12 ? Math.min(5, Math.round(treble * 6 * (0.4 + fluxRaw * 4))) : 0;
      for (; toSpawn > 0 && sparks.length < 240; toSpawn--) {
        const ang = Math.random() * TWO_PI;
        const speed = minSide * (0.05 + Math.random() * 0.13);
        sparks.push({
          x: cx + Math.cos(ang) * baseR,
          y: cy + Math.sin(ang) * baseR,
          vx: Math.cos(ang) * speed,
          vy: Math.sin(ang) * speed,
          life: 1,
          hue: bandHueAt(BANDS - 1),
          size: minSide * (0.004 + Math.random() * 0.006),
        });
      }
      ctx.globalCompositeOperation = 'lighter';
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i]!;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.life -= dt / 0.8;
        if (s.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * (0.4 + s.life), 0, TWO_PI);
        ctx.fillStyle = `hsla(${s.hue}, 95%, 72%, ${s.life})`;
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    raf = requestAnimationFrame(draw);

    // A desktop tab switch leaves the context running, but resume defensively
    // when we come back to the foreground in case the browser suspended it.
    const onVisibility = () => {
      if (!document.hidden) getAnalyser();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <div className="relative flex-1">
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </div>
  );
}

import { useEffect, useRef } from 'react';

import { getAnalyser } from '../lib/audio-analyser.ts';

const TWO_PI = Math.PI * 2;

/** A bass onset's expanding ring: `life` fades 1→0 as it grows outward. */
type Ring = { radius: number; life: number; hue: number };

/**
 * Full-bleed "aurora" visualiser of the playing track, reading the shared Web Audio analyser each frame. A soft glowing blob breathes with the bass; its rim is deformed into organic lobes by the spectrum (mirrored left/right so it reads as a deliberate shape, not noise); its hue follows the music's tonal balance (bass-heavy → warm, bright → cool); and a detected bass onset fires an expanding ring. Replaces the track list while active.
 */
export function Visualiser() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const analyser = getAnalyser();
    if (!canvas || !ctx || !analyser) return;

    const freq = new Uint8Array(analyser.frequencyBinCount);

    // Fixed ring of rim points, each eased toward its spectral target so the
    // blob morphs fluidly rather than snapping frame to frame.
    const POINTS = 120;
    const rim = new Float32Array(POINTS);
    const px = new Float32Array(POINTS);
    const py = new Float32Array(POINTS);

    let dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const rings: Ring[] = [];
    let bassAvg = 0; // slow envelope, the onset detector's baseline
    let hue = 250; // eased
    let breath = 0; // eased bass-driven radius factor, 0..1
    let flash = 0; // central beat flash, 0..1
    let lastBeat = 0;
    let lastTime = 0;
    let raf = 0;

    const draw = (time: number) => {
      raf = requestAnimationFrame(draw);
      const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0.016;
      lastTime = time;

      analyser.getByteFrequencyData(freq);
      const n = freq.length;

      let bassSum = 0;
      for (let i = 0; i < 12; i++) bassSum += freq[i] ?? 0;
      const bass = bassSum / (12 * 255);

      // Spectral centroid over the lower spectrum → a "brightness" in 0..1.
      let num = 0;
      let den = 0;
      const span = Math.min(256, n);
      for (let i = 0; i < span; i++) {
        const m = freq[i] ?? 0;
        num += i * m;
        den += m;
      }
      const brightness = den > 0 ? num / den / span : 0;
      const hueTarget = 20 + Math.min(1, brightness * 3) * 260;
      hue += (hueTarget - hue) * Math.min(dt * 3, 1);
      breath += (bass - breath) * Math.min(dt * 6, 1);

      if (bass > bassAvg * 1.4 && bass > 0.28 && time - lastBeat > 220) {
        lastBeat = time;
        flash = 1;
        rings.push({ radius: 0, life: 1, hue });
      }
      bassAvg += (bass - bassAvg) * 0.06;
      flash = Math.max(0, flash - dt / 0.25);

      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const minSide = Math.min(w, h);
      ctx.clearRect(0, 0, w, h);

      // A gentle idle pulse so a silent/paused track still feels alive.
      const idle = (Math.sin(time / 1500) + 1) * 0.04;
      const baseR = minSide * 0.15 + (breath + idle) * minSide * 0.12;
      const deform = 0.6;
      const half = POINTS / 2;
      const bandCount = 180;
      for (let i = 0; i < POINTS; i++) {
        // Mirror the spectrum across the vertical axis for left/right symmetry.
        const p = i < half ? i / half : (POINTS - i) / half;
        const idx = Math.min(bandCount - 1, Math.floor(p * bandCount));
        const current = rim[i]!;
        rim[i] = current + ((freq[idx] ?? 0) / 255 - current) * Math.min(dt * 8, 1);
      }
      for (let i = 0; i < POINTS; i++) {
        const smoothed =
          (rim[(i - 1 + POINTS) % POINTS]! + 2 * rim[i]! + rim[(i + 1) % POINTS]!) / 4;
        const r = baseR * (1 + smoothed * deform);
        const a = (i / POINTS) * TWO_PI - Math.PI / 2;
        px[i] = cx + Math.cos(a) * r;
        py[i] = cy + Math.sin(a) * r;
      }

      // Beat rings first, behind the blob.
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

      // The blob: a smooth closed loop through the rim points (quadratic
      // curves via midpoints), filled with a radial glow and a bloom shadow.
      ctx.beginPath();
      let mx = (px[POINTS - 1]! + px[0]!) / 2;
      let my = (py[POINTS - 1]! + py[0]!) / 2;
      ctx.moveTo(mx, my);
      for (let i = 0; i < POINTS; i++) {
        const next = (i + 1) % POINTS;
        mx = (px[i]! + px[next]!) / 2;
        my = (py[i]! + py[next]!) / 2;
        ctx.quadraticCurveTo(px[i]!, py[i]!, mx, my);
      }
      ctx.closePath();

      const grad = ctx.createRadialGradient(cx, cy, baseR * 0.1, cx, cy, baseR * 1.7);
      grad.addColorStop(0, `hsla(${hue + 25}, 95%, 70%, 0.95)`);
      grad.addColorStop(0.55, `hsla(${hue}, 90%, 58%, 0.8)`);
      grad.addColorStop(1, `hsla(${hue - 20}, 85%, 45%, 0)`);
      ctx.fillStyle = grad;
      ctx.shadowColor = `hsla(${hue}, 95%, 60%, 0.8)`;
      ctx.shadowBlur = minSide * 0.07;
      ctx.fill();
      ctx.shadowBlur = 0;

      if (flash > 0) {
        ctx.beginPath();
        ctx.arc(cx, cy, baseR * 0.5, 0, TWO_PI);
        ctx.fillStyle = `hsla(${hue + 40}, 100%, 85%, ${flash * 0.6})`;
        ctx.fill();
      }
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

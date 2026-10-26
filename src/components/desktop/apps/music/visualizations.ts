import { player } from './engine';

/**
 * Visualizations, after Windows Media Player's (Bars and Waves, Ambience,
 * Battery) and Winamp's (the spectrum analyzer and oscilloscope). Each draws
 * a frame onto a 2D canvas from the player's analyser; feedback effects keep
 * their own buffer canvas between frames.
 */

export interface VisFrame {
  /** Byte frequency data, 0-255 per bin (1024 bins). */
  freq: Uint8Array;
  /** Byte time-domain data, 128 = silence. */
  wave: Uint8Array;
  /** Seconds since the visualization started. */
  t: number;
  /** Overall loudness, 0-1. */
  level: number;
  /** Low-end loudness, 0-1 (for beats). */
  bass: number;
}

export interface Visualization {
  id: string;
  name: string;
  group: string;
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, frame: VisFrame, mem: Record<string, unknown>): void;
}

/** Bars from the spectrum on a log frequency scale. */
function bands(freq: Uint8Array, count: number, sampleRate = player.sampleRate): number[] {
  const out: number[] = [];
  const nyquist = sampleRate / 2;
  const lo = Math.log(40);
  const hi = Math.log(Math.min(18000, nyquist));
  for (let i = 0; i < count; i++) {
    const f0 = Math.exp(lo + ((hi - lo) * i) / count);
    const f1 = Math.exp(lo + ((hi - lo) * (i + 1)) / count);
    const b0 = Math.floor((f0 / nyquist) * freq.length);
    const b1 = Math.max(b0 + 1, Math.floor((f1 / nyquist) * freq.length));
    let max = 0;
    for (let b = b0; b < b1 && b < freq.length; b++) max = Math.max(max, freq[b]);
    out.push(max / 255);
  }
  return out;
}

function feedbackBuffer(mem: Record<string, unknown>, w: number, h: number): CanvasRenderingContext2D {
  let buf = mem.buf as HTMLCanvasElement | undefined;
  if (!buf || buf.width !== w || buf.height !== h) {
    buf = document.createElement('canvas');
    buf.width = w;
    buf.height = h;
    mem.buf = buf;
  }
  return buf.getContext('2d')!;
}

const peaks = (mem: Record<string, unknown>, values: number[], fall: number): number[] => {
  const prev = (mem.peaks as number[] | undefined) ?? [];
  const next = values.map((v, i) => Math.max(v, (prev[i] ?? 0) - fall));
  mem.peaks = next;
  return next;
};

export const VISUALIZATIONS: Visualization[] = [
  {
    id: 'bars',
    name: 'Bars',
    group: 'Bars and Waves',
    draw(ctx, w, h, { freq }, mem) {
      ctx.clearRect(0, 0, w, h);
      const count = Math.max(16, Math.min(64, Math.floor(w / 14)));
      const values = bands(freq, count);
      const tops = peaks(mem, values, 0.012);
      const gap = Math.max(2, w / count / 5);
      const bw = w / count - gap;
      // In the player's tint, shaded darker at the foot and paler at the top.
      ctx.fillStyle = (mem.tint as string | undefined) ?? '#2d8cf0';
      values.forEach((v, i) => {
        const bh = v * h * 0.9;
        ctx.fillRect(i * (bw + gap) + gap / 2, h - bh, bw, bh);
      });
      const shade = ctx.createLinearGradient(0, h, 0, 0);
      shade.addColorStop(0, 'rgba(0,0,0,0.55)');
      shade.addColorStop(0.5, 'rgba(0,0,0,0)');
      shade.addColorStop(1, 'rgba(255,255,255,0.6)');
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
      values.forEach((_, i) => {
        const x = i * (bw + gap) + gap / 2;
        if (tops[i] > 0.01) {
          ctx.fillStyle = '#e6f4ff';
          ctx.fillRect(x, h - tops[i] * h * 0.9 - 3, bw, 2);
        }
      });
    },
  },
  {
    id: 'ocean-mist',
    name: 'Ocean Mist',
    group: 'Bars and Waves',
    draw(ctx, w, h, { freq, t }) {
      ctx.fillStyle = 'rgba(0, 12, 24, 0.25)';
      ctx.fillRect(0, 0, w, h);
      const values = bands(freq, 96);
      ctx.globalCompositeOperation = 'lighter';
      for (let layer = 0; layer < 3; layer++) {
        ctx.beginPath();
        ctx.moveTo(0, h);
        values.forEach((v, i) => {
          const x = (i / (values.length - 1)) * w;
          const y = h - v * h * (0.8 - layer * 0.2) - Math.sin(t * (1 + layer) + i / 6) * 6;
          ctx.lineTo(x, y);
        });
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = `hsla(${190 + layer * 18}, 90%, ${45 + layer * 10}%, 0.35)`;
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  {
    id: 'fire-storm',
    name: 'Fire Storm',
    group: 'Bars and Waves',
    draw(ctx, w, h, { freq }, mem) {
      const buf = feedbackBuffer(mem, w, h);
      // Smoke rises: shift the last frame up and darken it.
      buf.globalCompositeOperation = 'copy';
      buf.drawImage(buf.canvas, 0, -3);
      buf.globalCompositeOperation = 'source-over';
      buf.fillStyle = 'rgba(0,0,0,0.08)';
      buf.fillRect(0, 0, w, h);
      const values = bands(freq, 48);
      const bw = w / values.length;
      values.forEach((v, i) => {
        const bh = v * h * 0.7;
        const g = buf.createLinearGradient(0, h, 0, h - bh);
        g.addColorStop(0, '#ffef9a');
        g.addColorStop(0.4, '#ff8a00');
        g.addColorStop(1, 'rgba(180,0,0,0)');
        buf.fillStyle = g;
        buf.fillRect(i * bw, h - bh, bw - 1, bh);
      });
      ctx.drawImage(buf.canvas, 0, 0);
    },
  },
  {
    id: 'scope',
    name: 'Scope',
    group: 'Bars and Waves',
    draw(ctx, w, h, { wave }) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#4cc2ff';
      ctx.shadowColor = '#4cc2ff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let i = 0; i < wave.length; i += 2) {
        const x = (i / wave.length) * w;
        const y = h / 2 + ((wave[i] - 128) / 128) * h * 0.45;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    },
  },
  {
    id: 'water',
    name: 'Water',
    group: 'Ambience',
    draw(ctx, w, h, { wave, t, level, bass }, mem) {
      const buf = feedbackBuffer(mem, w, h);
      // Zoom the last frame slightly out from the middle, fading: tunnels of light.
      buf.save();
      buf.globalAlpha = 0.92;
      buf.translate(w / 2, h / 2);
      buf.rotate(0.004 + bass * 0.01);
      buf.scale(1.02, 1.02);
      buf.drawImage(buf.canvas, -w / 2, -h / 2);
      buf.restore();
      buf.fillStyle = 'rgba(0, 4, 16, 0.06)';
      buf.fillRect(0, 0, w, h);
      const hue = (t * 20) % 360;
      buf.strokeStyle = `hsl(${hue}, 90%, ${55 + level * 30}%)`;
      buf.lineWidth = 1.5 + bass * 3;
      buf.beginPath();
      const r = Math.min(w, h) * (0.18 + level * 0.15);
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        const s = (wave[(i * 8) % wave.length] - 128) / 128;
        const rr = r * (1 + s * 0.6);
        const x = w / 2 + Math.cos(a + t * 0.3) * rr;
        const y = h / 2 + Math.sin(a + t * 0.3) * rr;
        if (i === 0) buf.moveTo(x, y);
        else buf.lineTo(x, y);
      }
      buf.stroke();
      ctx.drawImage(buf.canvas, 0, 0);
    },
  },
  {
    id: 'swirl',
    name: 'Swirl',
    group: 'Ambience',
    draw(ctx, w, h, { freq, t, bass }, mem) {
      const buf = feedbackBuffer(mem, w, h);
      buf.save();
      buf.globalAlpha = 0.95;
      buf.translate(w / 2, h / 2);
      buf.rotate(-0.02 - bass * 0.03);
      buf.scale(0.985, 0.985);
      buf.drawImage(buf.canvas, -w / 2, -h / 2);
      buf.restore();
      const values = bands(freq, 24);
      buf.globalCompositeOperation = 'lighter';
      values.forEach((v, i) => {
        const a = (i / values.length) * Math.PI * 2 + t;
        const r = Math.min(w, h) * 0.42 * v;
        buf.fillStyle = `hsla(${(i * 15 + t * 40) % 360}, 95%, 60%, ${0.25 + v * 0.5})`;
        buf.beginPath();
        buf.arc(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, 2 + v * 8, 0, Math.PI * 2);
        buf.fill();
      });
      buf.globalCompositeOperation = 'source-over';
      ctx.drawImage(buf.canvas, 0, 0);
    },
  },
  {
    id: 'plasma',
    name: 'Plasma Rings',
    group: 'Battery',
    draw(ctx, w, h, { freq, t, level }) {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, `hsl(${(t * 30) % 360}, 70%, ${10 + level * 20}%)`);
      g.addColorStop(1, '#000');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const values = bands(freq, 12);
      ctx.lineWidth = 3;
      values.forEach((v, i) => {
        ctx.strokeStyle = `hsla(${(t * 40 + i * 30) % 360}, 100%, 65%, ${0.3 + v * 0.7})`;
        ctx.beginPath();
        ctx.ellipse(w / 2, h / 2, (i + 1) * (Math.min(w, h) / 26) * (1 + v), (i + 1) * (Math.min(w, h) / 30) * (1 + v * 0.5), t * (i % 2 ? 0.5 : -0.5), 0, Math.PI * 2);
        ctx.stroke();
      });
    },
  },
  {
    id: 'starfield',
    name: 'Starfield',
    group: 'Battery',
    draw(ctx, w, h, { level, bass }, mem) {
      type Star = { x: number; y: number; z: number };
      let stars = mem.stars as Star[] | undefined;
      if (!stars) {
        stars = Array.from({ length: 300 }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() }));
        mem.stars = stars;
      }
      ctx.fillStyle = 'rgba(0,0,8,0.4)';
      ctx.fillRect(0, 0, w, h);
      const speed = 0.004 + level * 0.03 + bass * 0.03;
      for (const s of stars) {
        s.z -= speed;
        if (s.z <= 0.01) {
          s.x = Math.random() * 2 - 1;
          s.y = Math.random() * 2 - 1;
          s.z = 1;
        }
        const x = w / 2 + (s.x / s.z) * w * 0.5;
        const y = h / 2 + (s.y / s.z) * h * 0.5;
        const size = (1 - s.z) * 3;
        ctx.fillStyle = `rgba(200,225,255,${1 - s.z})`;
        ctx.fillRect(x, y, size, size);
      }
    },
  },
  {
    id: 'spectrum',
    name: 'Spectrum Analyzer',
    group: 'Winamp',
    draw(ctx, w, h, { freq }, mem) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      const count = Math.max(19, Math.floor(w / 8));
      const values = bands(freq, count);
      const tops = peaks(mem, values, 0.01);
      const bw = w / count;
      const cells = Math.max(8, Math.floor(h / 4));
      for (let i = 0; i < count; i++) {
        const lit = Math.round(values[i] * cells);
        for (let c = 0; c < lit; c++) {
          const ratio = c / cells;
          ctx.fillStyle = ratio > 0.8 ? '#ef3110' : ratio > 0.55 ? '#d6b521' : '#18a910';
          ctx.fillRect(i * bw + 1, h - (c + 1) * (h / cells) + 1, bw - 2, h / cells - 2);
        }
        ctx.fillStyle = '#969696';
        ctx.fillRect(i * bw + 1, h - tops[i] * h - 2, bw - 2, 2);
      }
    },
  },
  {
    id: 'oscilloscope',
    name: 'Oscilloscope',
    group: 'Winamp',
    draw(ctx, w, h, { wave }) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#d6b521';
      ctx.lineWidth = Math.max(1, h / 80);
      ctx.beginPath();
      for (let i = 0; i < wave.length; i += 4) {
        const x = (i / wave.length) * w;
        const y = h / 2 + ((wave[i] - 128) / 128) * h * 0.5;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    },
  },
];

export function visualizationById(id: string): Visualization {
  return VISUALIZATIONS.find((v) => v.id === id) ?? VISUALIZATIONS[0];
}

const freqBuf = new Uint8Array(1024);
const waveBuf = new Uint8Array(2048);

/** This frame's audio, from the player's analyser (silence before anything plays). */
export function readFrame(t: number): VisFrame {
  const analyser = player.analyser;
  if (analyser && player.getState().status === 'playing') {
    analyser.getByteFrequencyData(freqBuf);
    analyser.getByteTimeDomainData(waveBuf);
  } else {
    freqBuf.fill(0);
    waveBuf.fill(128);
  }
  let sum = 0;
  for (let i = 0; i < freqBuf.length; i++) sum += freqBuf[i];
  let low = 0;
  for (let i = 0; i < 16; i++) low += freqBuf[i];
  return { freq: freqBuf, wave: waveBuf, t, level: sum / freqBuf.length / 255, bass: low / 16 / 255 };
}

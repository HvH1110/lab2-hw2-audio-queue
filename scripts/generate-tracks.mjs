// Generates the demo tracks in public/tracks: deterministic, royalty-free, synthesized from scratch.
// Usage: node scripts/generate-tracks.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 22050;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tracks');

/** Deterministic PRNG (mulberry32) so the files are byte-identical on every run. */
function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12);
const TAU = Math.PI * 2;

/** Adds `fn(tLocal)` into `buffer` starting at `start` seconds for `length` seconds with an ADSR-ish envelope. */
function addNote(buffer, start, length, fn, { attack = 0.01, release = 0.2, gain = 0.3 } = {}) {
  const from = Math.floor(start * SAMPLE_RATE);
  const count = Math.floor((length + release) * SAMPLE_RATE);
  for (let i = 0; i < count && from + i < buffer.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = t < attack ? t / attack : t < length ? 1 : Math.max(0, 1 - (t - length) / release);
    buffer[from + i] += fn(t) * env * gain;
  }
}

const sine = (hz) => (t) => Math.sin(TAU * hz * t);
const organ = (hz) => (t) => Math.sin(TAU * hz * t) + 0.5 * Math.sin(TAU * 2 * hz * t) + 0.25 * Math.sin(TAU * 3 * hz * t);
const bell = (hz) => (t) => (Math.sin(TAU * hz * t) + 0.6 * Math.sin(TAU * 2.76 * hz * t) + 0.3 * Math.sin(TAU * 5.4 * hz * t)) * Math.exp(-3 * t);

function kick(buffer, start) {
  addNote(buffer, start, 0.18, (t) => Math.sin(TAU * (50 + 90 * Math.exp(-25 * t)) * t) * Math.exp(-12 * t), { attack: 0.001, release: 0.05, gain: 0.7 });
}

function hat(buffer, start, random) {
  addNote(buffer, start, 0.04, () => random() * 2 - 1, { attack: 0.001, release: 0.03, gain: 0.12 });
}

/** Karplus–Strong plucked string. */
function pluck(buffer, start, hz, random, gain = 0.4) {
  const period = Math.max(2, Math.round(SAMPLE_RATE / hz));
  const ring = Float32Array.from({ length: period }, () => random() * 2 - 1);
  const from = Math.floor(start * SAMPLE_RATE);
  const count = Math.floor(1.6 * SAMPLE_RATE);
  for (let i = 0; i < count && from + i < buffer.length; i++) {
    const j = i % period;
    const next = (j + 1) % period;
    const value = ring[j];
    ring[j] = 0.996 * 0.5 * (ring[j] + ring[next]);
    buffer[from + i] += value * gain;
  }
}

const TRACKS = [
  {
    file: 'saigon-sunrise.wav',
    seconds: 12,
    render(buffer, random) {
      const chords = [[60, 64, 67, 72], [57, 60, 64, 69], [65, 69, 72, 77], [67, 71, 74, 79]];
      for (let bar = 0; bar < 6; bar++) {
        const chord = chords[bar % chords.length];
        for (let step = 0; step < 8; step++) {
          const t = bar * 2 + step * 0.25;
          addNote(buffer, t, 0.2, sine(midiToHz(chord[step % 4])), { gain: 0.22 });
          if (step % 4 === 0) kick(buffer, t);
          if (step % 2 === 1) hat(buffer, t, random);
        }
        addNote(buffer, bar * 2, 1.8, sine(midiToHz(chord[0] - 24)), { attack: 0.02, release: 0.2, gain: 0.3 });
      }
    },
  },
  {
    file: 'hanoi-night-drive.wav',
    seconds: 12,
    render(buffer, random) {
      const bass = [45, 45, 48, 43];
      for (let beat = 0; beat < 24; beat++) {
        const t = beat * 0.5;
        addNote(buffer, t, 0.4, organ(midiToHz(bass[Math.floor(beat / 6) % 4])), { gain: 0.18 });
        kick(buffer, t);
        hat(buffer, t + 0.25, random);
      }
      const lead = [69, 72, 76, 74, 72, 69, 67, 69];
      lead.forEach((note, i) => addNote(buffer, i * 1.5, 1.2, organ(midiToHz(note)), { attack: 0.05, release: 0.3, gain: 0.12 }));
    },
  },
  {
    file: 'mekong-drift.wav',
    seconds: 14,
    render(buffer) {
      const pentatonic = [62, 64, 67, 69, 71, 74, 76];
      for (let i = 0; i < 28; i++) {
        const note = pentatonic[(i * 3 + (i >> 2)) % pentatonic.length];
        addNote(buffer, i * 0.5, 0.45, sine(midiToHz(note)), { attack: 0.03, release: 0.4, gain: 0.2 });
      }
      for (let bar = 0; bar < 4; bar++) {
        addNote(buffer, bar * 3.5, 3.4, organ(midiToHz(50 + (bar % 2) * 5)), { attack: 0.8, release: 0.8, gain: 0.08 });
      }
    },
  },
  {
    file: 'da-nang-waves.wav',
    seconds: 12,
    render(buffer, random) {
      // Ocean: slowly swelling, low-passed noise.
      let low = 0;
      for (let i = 0; i < buffer.length; i++) {
        const t = i / SAMPLE_RATE;
        low += 0.02 * (random() * 2 - 1 - low);
        buffer[i] += low * (0.5 + 0.5 * Math.sin(TAU * t / 4)) * 0.9;
      }
      [76, 79, 83, 81, 79, 76, 74, 76].forEach((note, i) => addNote(buffer, 0.5 + i * 1.4, 1.2, bell(midiToHz(note)), { gain: 0.25 }));
    },
  },
  {
    file: 'hue-lanterns.wav',
    seconds: 12,
    render(buffer, random) {
      const pattern = [57, 64, 69, 72, 76, 72, 69, 64];
      for (let i = 0; i < 48; i++) {
        pluck(buffer, i * 0.25, midiToHz(pattern[i % pattern.length] + (Math.floor(i / 16) % 2) * 2), random, 0.35);
      }
    },
  },
];

function encodeWav(samples) {
  const dataBytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const ascii = (offset, text) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true));
  return Buffer.from(view.buffer);
}

function master(buffer) {
  const peak = buffer.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const fade = Math.floor(0.05 * SAMPLE_RATE);
  return buffer.map((v, i) => {
    const edge = Math.min(1, i / fade, (buffer.length - 1 - i) / fade);
    return Math.tanh((v / peak) * 1.2) * 0.85 * edge;
  });
}

mkdirSync(OUT_DIR, { recursive: true });
TRACKS.forEach((track, index) => {
  const buffer = new Float32Array(track.seconds * SAMPLE_RATE);
  track.render(buffer, prng(1000 + index));
  const bytes = encodeWav(master(buffer));
  writeFileSync(join(OUT_DIR, track.file), bytes);
  console.log(`${track.file}: ${track.seconds}s, ${(bytes.length / 1024).toFixed(0)} KiB`);
});

// A file that looks like audio by name but cannot be decoded (exercises the FAILED path).
const random = prng(99);
const corrupt = Buffer.from(Array.from({ length: 4096 }, () => Math.floor(random() * 256)));
writeFileSync(join(OUT_DIR, 'corrupt.wav'), corrupt);
console.log('corrupt.wav: 4 KiB of random bytes');

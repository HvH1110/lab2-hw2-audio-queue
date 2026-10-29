/// <reference types="node" />
// Node types are scoped to this file so browser code cannot use Node APIs by accident.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'public', 'tracks');
const wavs = readdirSync(DIR).filter((f) => f.endsWith('.wav') && f !== 'corrupt.wav');

const ascii = (view: DataView, offset: number, length: number): string =>
  String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));

describe('generated tracks', () => {
  it('has five playable tracks', () => {
    expect(wavs.sort()).toEqual(['da-nang-waves.wav', 'hanoi-night-drive.wav', 'hue-lanterns.wav', 'mekong-drift.wav', 'saigon-sunrise.wav']);
  });

  it.each(wavs)('%s is a valid 22.05 kHz mono 16-bit PCM WAV with audible content', (file) => {
    const bytes = readFileSync(join(DIR, file));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36, 4)).toBe('data');
    const dataBytes = view.getUint32(40, true);
    expect(dataBytes).toBe(bytes.byteLength - 44);
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);

    let sumSquares = 0;
    let peak = 0;
    for (let offset = 44; offset < bytes.byteLength; offset += 2) {
      const sample = view.getInt16(offset, true) / 32768;
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sumSquares / (dataBytes / 2));
    expect(rms).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1);
  });

  it('corrupt.wav is not a RIFF file (exercises the decode failure path)', () => {
    const bytes = readFileSync(join(DIR, 'corrupt.wav'));
    expect(bytes.subarray(0, 4).toString('latin1')).not.toBe('RIFF');
  });
});

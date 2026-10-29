import type { TrackInfo } from './audio/types';

const base = import.meta.env.BASE_URL;

/** Synthetic, royalty-free tracks from scripts/generate-tracks.mjs, plus two failure demos. */
export const TRACKS: readonly TrackInfo[] = Object.freeze([
  { id: 'saigon-sunrise', title: 'Saigon Sunrise', url: `${base}tracks/saigon-sunrise.wav` },
  { id: 'hanoi-night-drive', title: 'Hanoi Night Drive', url: `${base}tracks/hanoi-night-drive.wav` },
  { id: 'mekong-drift', title: 'Mekong Drift', url: `${base}tracks/mekong-drift.wav` },
  { id: 'da-nang-waves', title: 'Da Nang Waves', url: `${base}tracks/da-nang-waves.wav` },
  { id: 'hue-lanterns', title: 'Hue Lanterns', url: `${base}tracks/hue-lanterns.wav` },
  { id: 'corrupt', title: 'Corrupt file (decode error demo)', url: `${base}tracks/corrupt.wav` },
  { id: 'missing', title: 'Missing file (404 demo)', url: `${base}tracks/missing.wav` },
]);

export const PLAYABLE_TRACKS = TRACKS.filter((t) => t.id !== 'corrupt' && t.id !== 'missing');

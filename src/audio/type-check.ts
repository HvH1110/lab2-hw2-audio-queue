// Compile-time proof that the real Web Audio API satisfies the structural contracts.
import type { AnalyserLike, AudioContextLike, GainLike, SourceNodeLike } from './types';

export type RealContextFits = AudioContext extends AudioContextLike<AudioBuffer> ? true : never;
export type RealSourceFits = AudioBufferSourceNode extends SourceNodeLike<AudioBuffer> ? true : never;
export type RealAnalyserFits = AnalyserNode extends AnalyserLike ? true : never;
export type RealGainFits = GainNode extends GainLike ? true : never;

export const contractProof: [RealContextFits, RealSourceFits, RealAnalyserFits, RealGainFits] = [true, true, true, true];

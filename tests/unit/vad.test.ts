/**
 * T-045 — energy detection for barge-in.
 *
 * T-045 asks for tests against recorded audio buffers. These are synthetic:
 * silence, a full-scale sine, DC, an impulse. That is a substitution and worth
 * naming — a recording would exercise a real room and these do not. What they do
 * exercise is the part that can actually be wrong: the RMS arithmetic, where a
 * missing square root or a sum over the wrong length is invisible by ear, and
 * the sustain window, where the boundary is the whole point. A sine of amplitude
 * 1.0 has an RMS of 1/sqrt(2) as a matter of arithmetic, so the expected value
 * is derived rather than recorded.
 */

import { describe, expect, it } from 'vitest';

import { BARGE_IN } from '../../src/config/settings.js';
import { createSustainDetector, rms } from '../../src/speech/vad.js';

const LOUD = BARGE_IN.rmsThreshold * 4;
const QUIET = BARGE_IN.rmsThreshold / 4;

function sine(samples: number, cycles: number, amplitude = 1): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * cycles * i) / samples);
  }
  return out;
}

describe('rms', () => {
  it('is zero for an empty buffer', () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it('is zero for silence', () => {
    expect(rms(new Float32Array(1024))).toBe(0);
  });

  it('is 1/sqrt(2) for a full-scale sine', () => {
    expect(rms(sine(4096, 8))).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('scales linearly with amplitude', () => {
    expect(rms(sine(4096, 8, 0.5))).toBeCloseTo(Math.SQRT1_2 / 2, 3);
  });

  it('is the magnitude for a DC signal', () => {
    expect(rms(new Float32Array(512).fill(-1))).toBeCloseTo(1, 6);
  });

  it('is unsigned — a square wave at 0.5 reads 0.5', () => {
    const square = new Float32Array(512);
    for (let i = 0; i < square.length; i += 1) square[i] = i % 2 === 0 ? 0.5 : -0.5;
    expect(rms(square)).toBeCloseTo(0.5, 6);
  });

  it('averages a lone impulse down to almost nothing', () => {
    // Which is precisely why energy alone is not enough and the sustain window
    // exists: the impulse that a threshold would catch, RMS over a window
    // already discards.
    const impulse = new Float32Array(1024);
    impulse[0] = 1;
    expect(rms(impulse)).toBeLessThan(BARGE_IN.rmsThreshold);
  });
});

describe('createSustainDetector', () => {
  it('does not fire before the sustain window has elapsed', () => {
    const detector = createSustainDetector();
    expect(detector.push(LOUD, 0)).toBe(false);
    expect(detector.push(LOUD, BARGE_IN.sustainedMs - 1)).toBe(false);
  });

  it('fires once the level has been high for the whole window', () => {
    const detector = createSustainDetector();
    detector.push(LOUD, 0);
    detector.push(LOUD, 60);
    expect(detector.push(LOUD, BARGE_IN.sustainedMs)).toBe(true);
  });

  it('does not fire on a single loud spike', () => {
    const detector = createSustainDetector();
    expect(detector.push(1, 0)).toBe(false);
    expect(detector.push(QUIET, 20)).toBe(false);
    // The spike restarted nothing; a full window later there is still no fire.
    expect(detector.push(QUIET, 20 + BARGE_IN.sustainedMs * 2)).toBe(false);
  });

  it('does not fire on a burst of spikes separated by quiet', () => {
    const detector = createSustainDetector();
    let fired = false;
    for (let t = 0; t < 2_000; t += 40) {
      fired = detector.push(t % 80 === 0 ? 1 : QUIET, t) || fired;
    }
    expect(fired).toBe(false);
  });

  it('fires only once while the level stays high', () => {
    const detector = createSustainDetector();
    let fires = 0;
    for (let t = 0; t <= 1_000; t += 20) {
      if (detector.push(LOUD, t)) fires += 1;
    }
    expect(fires).toBe(1);
  });

  it('re-arms after the level drops below the threshold', () => {
    const detector = createSustainDetector();
    detector.push(LOUD, 0);
    expect(detector.push(LOUD, BARGE_IN.sustainedMs)).toBe(true);
    expect(detector.push(QUIET, 200)).toBe(false);
    detector.push(LOUD, 300);
    expect(detector.push(LOUD, 300 + BARGE_IN.sustainedMs)).toBe(true);
  });

  it('restarts the window when the level dips mid-way through it', () => {
    const detector = createSustainDetector();
    detector.push(LOUD, 0);
    detector.push(QUIET, 60);
    detector.push(LOUD, 61);
    expect(detector.push(LOUD, BARGE_IN.sustainedMs)).toBe(false);
    expect(detector.push(LOUD, 61 + BARGE_IN.sustainedMs)).toBe(true);
  });

  it('treats a level exactly at the threshold as quiet', () => {
    const detector = createSustainDetector();
    detector.push(BARGE_IN.rmsThreshold, 0);
    expect(detector.push(BARGE_IN.rmsThreshold, 1_000)).toBe(false);
  });

  it('honours an injected threshold and window', () => {
    const detector = createSustainDetector({ threshold: 0.5, sustainedMs: 10 });
    expect(detector.push(0.6, 0)).toBe(false);
    expect(detector.push(0.6, 9)).toBe(false);
    expect(detector.push(0.6, 10)).toBe(true);
    // The default threshold would have rejected this level entirely.
    expect(detector.push(0.4, 11)).toBe(false);
  });

  it('reset() clears a window in progress', () => {
    const detector = createSustainDetector();
    detector.push(LOUD, 0);
    detector.reset();
    expect(detector.push(LOUD, BARGE_IN.sustainedMs)).toBe(false);
    expect(detector.push(LOUD, BARGE_IN.sustainedMs * 2)).toBe(true);
  });

  it('accepts real RMS values from a synthetic buffer', () => {
    const detector = createSustainDetector();
    const speechish = rms(sine(1024, 12, 0.3));
    const roomish = rms(sine(1024, 12, 0.01));
    expect(roomish).toBeLessThan(BARGE_IN.rmsThreshold);
    expect(speechish).toBeGreaterThan(BARGE_IN.rmsThreshold);
    detector.push(roomish, 0);
    detector.push(speechish, 10);
    expect(detector.push(speechish, 10 + BARGE_IN.sustainedMs)).toBe(true);
  });
});

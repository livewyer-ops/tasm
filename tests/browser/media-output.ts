import { test as base, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';

// Native HLS in WebKit bypasses Web Audio. Record the output device for every
// browser so the assertion measures audible output without altering its graph.
interface AudioOutput { reset(): void; rms(): number; drain(): Promise<void> }
export const test = base.extend<{ audioOutput: AudioOutput }>({
  audioOutput: async ({ audioSink }, use) => {
    const recorder = spawn('ffmpeg', ['-v', 'error', '-f', 'pulse', '-fragment_size', '4096', '-i', audioSink ? audioSink + '.monitor' : process.env.TASM_AUDIO_MONITOR ?? '@DEFAULT_MONITOR@', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    let sum = 0, count = 0, error = '';
    recorder.on('error', failure => { error = failure.message; });
    recorder.stderr.on('data', bytes => { error += bytes; });
    recorder.stdout.on('data', (bytes: Buffer) => {
      for (let i = 0; i + 4 <= bytes.length; i += 4) { const value = bytes.readFloatLE(i); sum += value * value; count++; }
    });
    try {
      await expect.poll(() => { if (error || recorder.exitCode !== null) throw new Error(error || 'FFmpeg exited'); return count; }, { timeout: 15000, message: 'FFmpeg must capture a working PulseAudio monitor' }).toBeGreaterThan(0);
      await use({ async drain() {
        const target = count + 14400;
        await expect.poll(() => count).toBeGreaterThanOrEqual(target);
      }, reset() { sum = 0; count = 0; }, rms() { expect(count).toBeGreaterThan(0); return Math.sqrt(sum / count); } });
    } finally { recorder.kill('SIGTERM'); }
  }
});

// Measure the decoded browser output, not manifest metadata or playback counters.
export async function output(page: Page, time: number, audioOutput: AudioOutput) {
  await page.locator('#seek-time').fill(String(time)); await page.locator('#seek-button').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15000 }).toBeCloseTo(time, 1);
  await audioOutput.drain();
  audioOutput.reset();
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.muted = false; video.volume = 1; video.playbackRate = 1; });
  // Sample in the browser so automation round trips cannot shift the capture time.
  const capture = await page.locator('video').evaluateHandle((video: HTMLVideoElement, target: number) => ({ result: (async () => {
    await new Promise<void>((resolve, reject) => {
      const deadline = performance.now() + 15000;
      const check = () => {
        if (!video.paused && video.currentTime > target + 0.28) resolve();
        else if (performance.now() >= deadline) reject(new Error('Playback did not advance'));
        else setTimeout(check, 25);
      };
      check();
    });
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(video, 0, 0, 64, 36);
    const pixels = ctx.getImageData(0, 0, 64, 36).data;
    let brightness = 0; for (let i = 0; i < pixels.length; i += 4) brightness += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
    const result = { brightness: brightness / (64 * 36), time: video.currentTime, duration: video.duration };
    video.pause(); return result;
  })() }), time);
  try {
    await page.locator('omakase-play-button').click();
    const result = await capture.evaluate(({ result }) => result);
    await audioOutput.drain();
    return { ...result, rms: audioOutput.rms() };
  } finally { await capture.dispose(); }
}

export async function expectOutput(page: Page, time: number, video: boolean, audio: boolean, audioOutput: AudioOutput) {
  const result = await output(page, time, audioOutput);
  if (process.env.TASM_TRACE) console.log({ target: time, video, audio, ...result });
  expect(result.time).toBeGreaterThanOrEqual(time - 0.04);
  expect(result.time).toBeLessThan(time + 0.7);
  if (video) expect(result.brightness).toBeGreaterThan(10); else expect(result.brightness).toBeLessThan(2);
  if (audio) expect(result.rms).toBeGreaterThan(0.001); else expect(result.rms).toBeLessThan(0.0001);
}

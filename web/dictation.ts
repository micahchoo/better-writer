/**
 * dictation: browser recording -> 16kHz mono WAV -> POST /transcribe.
 *
 * The local server's transcription expects WAV bytes: PCM16, 16kHz, mono.
 * decodeToMono16k resamples whatever the browser records (webm/opus in
 * Chromium, mp4/aac in Safari) down to a 16kHz mono Float32Array via the
 * OfflineAudioContext; encodeWavPcm16 wraps it in a standard RIFF/WAVE
 * header; transcribeWav posts the bytes to the server.
 */

/** The first media type MediaRecorder supports, or null if recording is unavailable. */
export function pickRecordingMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

/** Encode Float32Array samples ([-1, 1]) as a 16-bit PCM mono WAV blob. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += bytesPerSample) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Decode any browser-recorded audio blob and resample it to 16kHz mono. */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const frameCount = Math.ceil(decoded.duration * 16000);
    const offline = new OfflineAudioContext(1, frameCount, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } finally {
    void audioContext.close();
  }
}

/** POST WAV bytes to the local server's /transcribe endpoint. */
export async function transcribeWav(wav: Blob): Promise<string> {
  const res = await fetch('/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
  });
  if (!res.ok) {
    throw new Error(`Transcription failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { text?: string };
  return data.text ?? '';
}

/** Recorded blob -> transcribed text, through the full local pipeline. */
export async function transcribeAudio(blob: Blob): Promise<string> {
  const mono = await decodeToMono16k(blob);
  const wav = encodeWavPcm16(mono, 16000);
  return transcribeWav(wav);
}

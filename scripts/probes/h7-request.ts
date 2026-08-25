/**
 * H7 probe 2: captured-request inspection of makeByokComplete + transcribeWavByok
 * using an injected global fetch stub. Exercises response classes:
 *   200 JSON, 401 JSON error, 500 HTML body, network throw, 200 non-JSON body.
 * decodeToMono16k is driven through real AudioContext/OfflineAudioContext stubs
 * so the uploaded FormData is genuinely built by byok.ts. No outbound network.
 */
import { makeByokComplete, transcribeWavByok, loadByokConfig } from '../../web/byok';
import { encodeWavPcm16 } from '../../web/dictation';

const KEY = 'better-writer:byok';
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: typeof globalThis.localStorage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

// --- minimal AudioContext / OfflineAudioContext stubs so decodeToMono16k runs ---
(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
  decodeAudioData = async () => ({ duration: 1 });
  close = async () => {};
};
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = class {
  frames: number;
  constructor(_ch: number, frames: number, _rate: number) {
    this.frames = frames;
  }
  destination = {};
  createBufferSource() {
    return { buffer: null, connect() {}, start() {} };
  }
  async startRendering() {
    return { getChannelData: () => new Float32Array(this.frames) };
  }
};

type Captured = { url: string; init: RequestInit & { body: unknown } };
const calls: Captured[] = [];
let responseBuilder: (url: string, init: RequestInit) => Response | Promise<Response>;
(globalThis as unknown as { fetch: unknown }).fetch = async (
  url: string,
  init: RequestInit,
): Promise<Response> => {
  calls.push({ url, init });
  return responseBuilder(url, init);
};

function jsonRes(body: unknown, status = 200, statusText = 'OK', headers = { 'Content-Type': 'application/json' }): Response {
  return new Response(JSON.stringify(body), { status, statusText, headers });
}
function textRes(body: string, status = 200, statusText = 'OK'): Response {
  return new Response(body, { status, statusText });
}

function reset(): void {
  calls.length = 0;
  store.clear();
}

function cfg(overrides: Record<string, unknown> = {}): void {
  store.set(
    KEY,
    JSON.stringify({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      ...overrides,
    }),
  );
}

const sys = 'system msg';
const turns = [{ role: 'user' as const, text: 'the prompt' }];

console.log('=== A. makeByokComplete request shape (200 JSON) ===');
reset();
cfg();
responseBuilder = () => jsonRes({ choices: [{ message: { content: '  trimmed  ' } }] });
const complete = makeByokComplete(loadByokConfig()!);
const out = await complete(sys, turns);
console.log('returned:', JSON.stringify(out));
const c = calls[0];
console.log('url:', c.url);
console.log('method:', c.init.method);
console.log('headers:', JSON.stringify(c.init.headers));
const body = JSON.parse(c.init.body as string);
console.log('body keys:', Object.keys(body));
console.log('temperature default:', body.temperature, '| max_tokens:', body.max_tokens);
console.log('signal is timeout:', c.init.signal && typeof (c.init.signal as AbortSignal).aborted === 'boolean');

console.log('\n=== B. makeByokComplete 401 JSON error body ===');
reset();
cfg();
responseBuilder = () => jsonRes({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }, 401, 'Unauthorized');
try {
  await complete(sys, turns);
  console.log('NO THROW (unexpected)');
} catch (e) {
  console.log('threw:', (e as Error).message.slice(0, 120));
}

console.log('\n=== C. makeByokComplete 500 HTML body (proxy error page) ===');
reset();
cfg();
responseBuilder = () =>
  textRes(
    '<html><body><h1>502 Bad Gateway</h1><p>nginx upstream timeout</p></body></html>',
    502,
    'Bad Gateway',
  );
try {
  await complete(sys, turns);
  console.log('NO THROW (unexpected)');
} catch (e) {
  const msg = (e as Error).message;
  console.log('threw:', msg.slice(0, 60), '... len=', msg.length);
  console.log('html leak into message:', msg.includes('<html>'));
}

console.log('\n=== D. makeByokComplete network throw (fetch rejects) ===');
reset();
cfg();
responseBuilder = () => {
  throw new TypeError('Failed to fetch');
};
try {
  await complete(sys, turns);
  console.log('NO THROW (unexpected)');
} catch (e) {
  console.log('threw:', (e as Error).constructor.name, '|', (e as Error).message);
}

console.log('\n=== E. makeByokComplete 200 non-JSON body ===');
reset();
cfg();
responseBuilder = () => textRes('<html>ok</html>', 200, 'OK');
try {
  const r = await complete(sys, turns);
  console.log('returned:', JSON.stringify(r));
} catch (e) {
  console.log('threw:', (e as Error).constructor.name, '|', (e as Error).message.slice(0, 80));
}

console.log('\n=== F. transcribeWavByok request shape (200 JSON) ===');
reset();
cfg({ sttModel: 'whisper-1' });
responseBuilder = () => jsonRes({ text: '  the keeper winds  ' });
const blob = new Blob(['fake-webm'], { type: 'audio/webm' });
const textOut = await transcribeWavByok(blob);
console.log('returned:', JSON.stringify(textOut));
const t = calls[0];
console.log('url:', t.url);
console.log('method:', t.init.method);
console.log('headers:', JSON.stringify(t.init.headers));
const fd = t.init.body as FormData;
console.log('form fields:', [...fd.keys()]);
const file = fd.get('file') as File;
console.log('file name:', file.name, '| type:', file.type, '| size:', file.size, '| RIFF sig:', new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()).slice(0, 4)));
console.log('model field:', fd.get('model'), '| response_format:', fd.get('response_format'));
console.log('manual Content-Type absent:', !('Content-Type' in (t.init.headers ?? {})));

console.log('\n=== G. transcribeWavByok 401 JSON error body ===');
reset();
cfg({ sttModel: 'whisper-1' });
responseBuilder = () => jsonRes({ error: { message: 'bad key' } }, 401, 'Unauthorized');
try {
  await transcribeWavByok(blob);
  console.log('NO THROW (unexpected)');
} catch (e) {
  console.log('threw:', (e as Error).message.slice(0, 120));
}

console.log('\n=== H. transcribeWavByok 500 HTML body ===');
reset();
cfg({ sttModel: 'whisper-1' });
responseBuilder = () => textRes('<html>proxy exploded</html>', 500, 'Internal Server Error');
try {
  await transcribeWavByok(blob);
  console.log('NO THROW (unexpected)');
} catch (e) {
  const msg = (e as Error).message;
  console.log('threw:', msg.slice(0, 60), '... html leak:', msg.includes('<html>'));
}

console.log('\n=== I. transcribeWavByok openrouter WITH explicit sttModel ===');
reset();
cfg({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', sttModel: 'whisper-1' });
responseBuilder = () => jsonRes({ text: 'x' });
try {
  const r = await transcribeWavByok(blob);
  console.log('RESOLVED — network call MADE to openrouter:', calls[0].url, '| result:', JSON.stringify(r));
} catch (e) {
  console.log('threw:', (e as Error).message);
}

console.log('\n=== J. encodeWavPcm16 header/values sanity ===');
const mono = new Float32Array([1, -1, 0.5, -0.5, 0]);
const wav = encodeWavPcm16(mono, 16000);
const buf = new Uint8Array(await wav.arrayBuffer());
const dv = new DataView(buf.buffer);
const riff = new TextDecoder().decode(buf.slice(0, 4));
const wave = new TextDecoder().decode(buf.slice(8, 12));
const dataSize = dv.getUint32(40, true);
const sampleRate = dv.getUint32(24, true);
const channels = dv.getUint16(22, true);
const bits = dv.getUint16(34, true);
console.log('RIFF:', riff, '| WAVE:', wave, '| dataSize:', dataSize, '| byteLen:', buf.length);
console.log('sampleRate:', sampleRate, '| channels:', channels, '| bits:', bits);
console.log('byteLen === 44 + dataSize:', buf.length === 44 + dataSize, '(', 44 + dataSize, ')');
console.log('RIFF size field (36+data):', dv.getUint32(4, true), '=== 36+dataSize:', 36 + dataSize);

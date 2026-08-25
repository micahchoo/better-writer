/**
 * H7 probe 1: localStorage payload fuzzer vs loadByokConfig / saveByokConfig.
 * Records exact behavior per malformed variant. No network.
 */
import { loadByokConfig, saveByokConfig, sttModelFor, TRANSCRIBES_AUDIO, STT_DEFAULTS } from '../../web/byok';

const KEY = 'better-writer:byok';

// Minimal Map-backed localStorage
const store = new Map<string, string>();
(globalThis as unknown as typeof globalThis.localStorage).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

function seed(payload: unknown): void {
  store.clear();
  store.set(KEY, JSON.stringify(payload));
}

const base = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'k',
  model: 'm',
};

type Row = { label: string; payload: unknown; result: 'loads' | 'null' | 'loads-changed' };

const cases: Row[] = [
  { label: 'valid baseline', payload: base, result: 'loads' },
  { label: 'baseUrl trailing space', payload: { ...base, baseUrl: 'https://api.openai.com/v1 ' }, result: '?' },
  { label: 'baseUrl leading+trailing spaces', payload: { ...base, baseUrl: ' https://api.openai.com/v1 ' }, result: '?' },
  { label: 'baseUrl internal space', payload: { ...base, baseUrl: 'https://api.openai.com/v1 /v2' }, result: '?' },
  { label: 'baseUrl slash duplication', payload: { ...base, baseUrl: 'https://api.openai.com/v1///' }, result: 'loads-changed' },
  { label: 'baseUrl null', payload: { ...base, baseUrl: null }, result: 'null' },
  { label: 'baseUrl number', payload: { ...base, baseUrl: 123 }, result: 'null' },
  { label: 'baseUrl missing', payload: { provider: 'openai', apiKey: 'k', model: 'm' }, result: 'null' },
  { label: 'baseUrl http non-loopback', payload: { ...base, baseUrl: 'http://api.example.com/v1' }, result: 'null' },
  { label: 'apiKey empty', payload: { ...base, apiKey: '' }, result: 'null' },
  { label: 'apiKey number', payload: { ...base, apiKey: 7 }, result: 'null' },
  { label: 'apiKey trailing space', payload: { ...base, apiKey: 'sk-abc ' }, result: 'loads-changed' },
  { label: 'model empty', payload: { ...base, model: '' }, result: 'null' },
  { label: 'model missing', payload: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' }, result: 'null' },
  { label: 'provider unknown', payload: { ...base, provider: 'bogus' }, result: 'null' },
  { label: 'provider number', payload: { ...base, provider: 5 }, result: 'null' },
  { label: 'extra field', payload: { ...base, extra: 'x', another: 1 }, result: 'loads' },
  { label: 'sttModel empty string', payload: { ...base, sttModel: '' }, result: 'loads' },
  { label: 'sttModel number', payload: { ...base, sttModel: 42 }, result: 'loads' },
  { label: 'sttModel blank spaces', payload: { ...base, sttModel: '   ' }, result: 'loads-changed' },
  { label: 'openrouter + explicit sttModel', payload: { ...base, provider: 'openrouter', sttModel: 'whisper-1' }, result: 'loads-changed' },
  { label: 'top-level null', payload: null, result: 'null' },
  { label: 'top-level []', payload: [], result: 'null' },
  { label: 'top-level string', payload: 'hello', result: 'null' },
  { label: 'corrupt JSON', payload: 'not json', result: 'null' }, // raw string, not JSON.stringify'd
];

console.log('=== H7 fuzz: loadByokConfig per malformed variant ===');
for (const c of cases) {
  store.clear();
  if (c.label === 'corrupt JSON') store.set(KEY, '{not valid json');
  else seed(c.payload);
  const loaded = loadByokConfig();
  const detail = loaded
    ? JSON.stringify({ baseUrl: loaded.baseUrl, apiKey: loaded.apiKey, sttModel: loaded.sttModel })
    : 'null';
  console.log(`[${c.label}] -> ${loaded ? 'LOADS' : 'null'}  ${detail}`);
}
store.clear();

console.log('\n=== H7: trailing-space baseUrl reaches request assembly ===');
// Hand-crafted payload with trailing-space baseUrl (loads if the fuzzer says so).
store.set(KEY, JSON.stringify({ ...base, baseUrl: 'https://api.openai.com/v1 ' }));
const spaceCfg = loadByokConfig();
console.log('loads:', !!spaceCfg, '| baseUrl:', JSON.stringify(spaceCfg?.baseUrl));
if (spaceCfg) {
  const assembled = `${spaceCfg.baseUrl}/chat/completions`;
  console.log('makeByokComplete would fetch:', JSON.stringify(assembled));
  let parsed = null;
  try {
    const u = new URL(assembled);
    parsed = { pathname: u.pathname, href: u.href };
  } catch (e) {
    parsed = `THROWS: ${(e as Error).message}`;
  }
  console.log('URL parse of assembled:', JSON.stringify(parsed));
}

console.log('\n=== H7: apiKey trailing space reaches Authorization header ===');
store.set(KEY, JSON.stringify({ ...base, apiKey: 'sk-abc ' }));
const keyCfg = loadByokConfig();
console.log('loads:', !!keyCfg, '| apiKey:', JSON.stringify(keyCfg?.apiKey));

console.log('\n=== H7: TRANSCRIBES_AUDIO vs STT_DEFAULTS vs sttModelFor ===');
for (const p of ['openrouter', 'openai', 'groq', 'custom'] as const) {
  const cfgNoStt = { provider: p, baseUrl: PRESET_URL(p), apiKey: 'k', model: 'm' };
  const cfgWithStt = { ...cfgNoStt, sttModel: 'whisper-1' };
  console.log(
    `provider=${p} TRANSCRIBES_AUDIO=${TRANSCRIBES_AUDIO[p]} STT_DEFAULT=${STT_DEFAULTS[p] ?? '(none)'} ` +
      `sttModelFor(no stt)=${sttModelFor(cfgNoStt)} sttModelFor(with stt)=${sttModelFor(cfgWithStt)}`,
  );
}
function PRESET_URL(p: string): string {
  return p === 'openrouter'
    ? 'https://openrouter.ai/api/v1'
    : p === 'openai'
      ? 'https://api.openai.com/v1'
      : p === 'groq'
        ? 'https://api.groq.com/openai/v1'
        : 'http://localhost:11434/v1';
}

console.log('\n=== H7: saveByokConfig validation asymmetry ===');
store.clear();
// save() does not validate: unsafe URL persists but load() rejects it.
saveByokConfig({ ...base, baseUrl: 'http://evil.example/v1' } as unknown as Parameters<typeof saveByokConfig>[0]);
console.log('after save of unsafe http baseUrl, raw stored:', store.get(KEY));
console.log('loadByokConfig after that save:', loadByokConfig() === null ? 'null (rejected on load)' : 'LOADS');

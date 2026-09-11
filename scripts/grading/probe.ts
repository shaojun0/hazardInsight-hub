import { loadEnvFile } from 'node:process';
try { loadEnvFile('.env'); } catch {}
const { resolveProvider } = await import('../../server/providers/index.js');
try {
  const r = await resolveProvider().provider.chat('只输出 JSON。', '返回一个 ok 为 true 的 JSON 对象', { maxTokens: 100, signal: AbortSignal.timeout(25000) });
  console.log(JSON.stringify({ ok: true, text: r.text, usage: r.usage }));
} catch (e) { console.log(JSON.stringify({ ok: false, error: (e as Error).message })); }

/**
 * 极简 .env 加载（无第三方依赖）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(rootDir = process.cwd()): void {
  const file = resolve(rootDir, '.env');
  if (!existsSync(file)) return;
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] === undefined) {
        process.env[key] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // .env 读取失败不阻塞启动，仅记录
    console.warn('[hazard] 读取 .env 失败，忽略。');
  }
}

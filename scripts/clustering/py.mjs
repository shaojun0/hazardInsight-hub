/**
 * Python 聚类服务的统一启动/测试入口。
 *
 * 为什么需要这个脚本：仓库要同时支持 Windows（.venv/Scripts/python.exe）
 * 与 Linux/macOS（.venv/bin/python），直接把这些路径写进 package.json 会导致
 * 另一端无法运行。这里做一次解释器探测，让 npm script 保持跨平台。
 *
 * 用法：
 *   node scripts/clustering/py.mjs serve      # 启动 FastAPI（uvicorn，端口取 PY_CLUSTER_PORT，默认 8000）
 *   node scripts/clustering/py.mjs test       # 运行 pytest
 *   node scripts/clustering/py.mjs <args...>  # 其余参数原样透传给该解释器
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const backendDir = join(root, 'backend', 'python');

/** 显式覆盖优先；只探测当前平台的虚拟环境，避免跨系统复制后误用另一端的解释器。 */
const virtualPython = process.platform === 'win32'
  ? join(backendDir, '.venv', 'Scripts', 'python.exe')
  : join(backendDir, '.venv', 'bin', 'python');
const overridePython = process.env.PY_CLUSTER_PYTHON?.trim();
// 覆盖值也可以是 PATH 中的命令（如 python3.12），不存在时由 spawn 明确报错。
const interpreter = overridePython || (existsSync(virtualPython) ? virtualPython : 'python3');

const [command, ...rest] = process.argv.slice(2);
let args;

if (command === 'serve') {
  args = [
    '-m', 'uvicorn', 'app.main:app',
    '--host', process.env.PY_CLUSTER_HOST ?? '127.0.0.1',
    '--port', process.env.PY_CLUSTER_PORT ?? '8000',
    ...rest,
  ];
} else if (command === 'test') {
  args = ['-m', 'pytest', ...rest];
} else {
  args = [command, ...rest].filter((item) => item !== undefined);
}

if (command === 'serve' && !overridePython && !existsSync(virtualPython)) {
  console.warn('[clustering] 未找到 backend/python/.venv，将使用 PATH 中的 python3。');
  console.warn('[clustering] 首次使用请先执行：cd backend/python && python -m venv .venv && pip install -r requirements.txt');
}

const child = spawn(interpreter, args, { cwd: backendDir, stdio: 'inherit', env: process.env });
child.on('error', (error) => {
  console.error(`[clustering] 无法启动 Python 解释器（${interpreter}）：${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';

test('legacy Mock configuration migrates to AI-only settings without a simulated fallback', async () => {
  const originalCwd = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), 'hazard-model-mode-'));
  const names = ['MULTIMODAL_API_KEY', 'MULTIMODAL_API_BASE_URL', 'MULTIMODAL_MODEL'];
  const originalEnv = names.map((name) => process.env[name]);
  let server: Server | undefined;
  try {
    process.chdir(directory);
    for (const name of names) delete process.env[name];
    writeFileSync(join(directory, '.runtime-model.json'), JSON.stringify({ mode: 'mock' }));
    const { getRuntimeConfig } = await import('../../server/services/model-config.js');
    const { resolveProvider, ProviderNotConfiguredError } = await import('../../server/providers/index.js');
    const { createModelRoutes } = await import('../../server/http/model.routes.js');
    assert.equal(getRuntimeConfig().mode, 'auto');
    assert.throws(() => resolveProvider(), ProviderNotConfiguredError);

    const app = express();
    app.use(express.json());
    app.use('/api', createModelRoutes());
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}/api`;
    const info = await (await fetch(`${baseUrl}/model`)).json();
    assert.equal(info.mode, 'ai');
    assert.equal(info.runtimeMode, 'auto');
    assert.equal(info.configured, false);

    const rejected = await fetch(`${baseUrl}/model-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'mock' }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await fetch(`${baseUrl}/mode`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${baseUrl}/health-check`, { method: 'POST' })).status, 502);

    process.env.MULTIMODAL_API_KEY = 'test-key';
    assert.equal(resolveProvider().mode, 'ai');
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    process.chdir(originalCwd);
    names.forEach((name, index) => {
      if (originalEnv[index] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[index];
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTaskId } from '../../web/agent/session.js';

test('workbench initializes on HTTP origins without crypto.randomUUID', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor));

  const { getWorkbenchSnapshot } = await import('../../web/lib/workbenchSession.js');
  assert.equal(getWorkbenchSnapshot().phase, 'idle');
  const taskIds = Array.from({ length: 100 }, createAgentTaskId);
  assert.equal(new Set(taskIds).size, taskIds.length);
  for (const id of [getWorkbenchSnapshot().taskId, ...taskIds]) {
    assert.match(id, /^task_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('agent task IDs also work in secure contexts', () => {
  assert.match(createAgentTaskId(), /^task_[0-9a-f-]{36}$/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_PRESETS,
  DEFAULT_PRESET_ID,
  nextCustomName,
  presetById,
  removePreset,
  switchActive,
  upsertPreset,
  type ModelConfigStore,
  type ModelPreset,
} from '../../web/lib/modelConfigs.js';

function makeStore(overrides: Partial<ModelConfigStore> = {}): ModelConfigStore {
  return {
    presets: BUILTIN_PRESETS.map((p) => ({ ...p })),
    activeId: DEFAULT_PRESET_ID,
    history: [],
    ...overrides,
  };
}

function custom(id: string, name: string): ModelPreset {
  return { id, name, mode: 'ai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen2.5-vl' };
}

test('default store ships the three builtin presets', () => {
  const store = makeStore();
  assert.equal(store.presets.length, 3);
  assert.deepEqual(
    store.presets.map((p) => p.name),
    ['默认模型配置', '本地模型配置', '服务器本地模型配置']
  );
  assert.equal(store.activeId, DEFAULT_PRESET_ID);
  assert.deepEqual(store.history, []);
});

test('switchActive records the previous config into history (max two, dedup)', () => {
  let store = makeStore();
  store = switchActive(store, 'preset-local');
  assert.deepEqual(store.history, [DEFAULT_PRESET_ID]);
  store = switchActive(store, 'preset-server-local');
  assert.deepEqual(store.history, ['preset-local', DEFAULT_PRESET_ID]);
  store = switchActive(store, DEFAULT_PRESET_ID);
  assert.deepEqual(store.history, ['preset-server-local', 'preset-local']);
  const same = switchActive(store, DEFAULT_PRESET_ID);
  assert.equal(same, store);
});

test('history keeps only the last two configs', () => {
  const store = switchActive(
    switchActive(switchActive(makeStore(), 'preset-local'), 'preset-server-local'),
    DEFAULT_PRESET_ID
  );
  assert.equal(store.history.length, 2);
  assert.deepEqual(store.history, ['preset-server-local', 'preset-local']);
});

test('upsertPreset adds a custom config and never marks it builtin', () => {
  const store = upsertPreset(makeStore(), custom('preset-custom-1', '我的配置'));
  const found = presetById(store, 'preset-custom-1');
  assert.ok(found);
  assert.equal(found.builtin, false);
  assert.equal(store.presets.length, 4);
});

test('upsertPreset updates an existing custom config in place', () => {
  let store = upsertPreset(makeStore(), custom('preset-custom-1', '我的配置'));
  store = upsertPreset(store, { ...custom('preset-custom-1', '我的配置 v2'), model: 'llava' });
  const found = presetById(store, 'preset-custom-1');
  assert.equal(found?.name, '我的配置 v2');
  assert.equal(found?.model, 'llava');
  assert.equal(store.presets.length, 4);
});

test('removePreset deletes a custom config and falls back to default when it was active', () => {
  let store = upsertPreset(makeStore(), custom('preset-custom-1', '我的配置'));
  store = switchActive(store, 'preset-custom-1');
  assert.equal(store.activeId, 'preset-custom-1');
  store = removePreset(store, 'preset-custom-1');
  assert.equal(store.activeId, DEFAULT_PRESET_ID);
  assert.equal(store.presets.length, 3);
  assert.ok(!store.history.includes('preset-custom-1'));
});

test('removePreset keeps the active config when removing a non-active one', () => {
  let store = upsertPreset(makeStore(), custom('preset-custom-1', '我的配置'));
  store = removePreset(store, 'preset-custom-1');
  assert.equal(store.activeId, DEFAULT_PRESET_ID);
});

test('nextCustomName generates non-conflicting names', () => {
  const store = makeStore();
  assert.equal(nextCustomName(store), '自定义配置 1');
  const withCustom = upsertPreset(store, { ...custom('c1', '自定义配置 1') });
  assert.equal(nextCustomName(withCustom), '自定义配置 2');
});

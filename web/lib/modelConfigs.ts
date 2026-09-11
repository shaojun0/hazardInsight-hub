/**
 * 模型配置库（localStorage 持久化）。
 *
 * 维护多套命名配置（内置预设 + 用户自定义）、当前激活配置与最近两次历史配置。
 * 切换/应用配置时由页面调用服务端 /api/model-config 写入 .runtime-model.json
 * （见 services/model-config.ts），本模块只负责前端侧的配置列表、选择与历史
 * （存储键 hazard.modelConfigs.v1）。
 */
export type ModelMode = 'auto' | 'ai';

export interface ModelPreset {
  id: string;
  name: string;
  /** 内置预设（默认/本地/服务器本地）不可删除；保存时按「另存为新配置」处理。 */
  builtin?: boolean;
  mode: ModelMode;
  baseUrl: string;
  apiKey: string;
  model: string;
  note?: string;
}

export interface ModelConfigStore {
  presets: ModelPreset[];
  activeId: string;
  /** 最近两次历史配置 id，最新的在前。 */
  history: string[];
}

export const DEFAULT_PRESET_ID = 'preset-default';

export const BUILTIN_PRESETS: ModelPreset[] = [
  {
    id: DEFAULT_PRESET_ID,
    name: '默认模型配置',
    builtin: true,
    mode: 'auto',
    baseUrl: '',
    apiKey: '',
    model: '',
    note: '使用 .env 环境变量默认：有 API Key 用 AI 模式；未配置时提示未配置真实模型。',
  },
  {
    id: 'preset-local',
    name: '本地模型配置',
    builtin: true,
    mode: 'ai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    model: 'qwen2.5-vl',
    note: '本机 Ollama（OpenAI 兼容 /v1 接口，无需 API Key）。',
  },
  {
    id: 'preset-server-local',
    name: '服务器本地模型配置',
    builtin: true,
    mode: 'ai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    model: 'Qwen2.5-VL-7B-Instruct',
    note: '服务器已部署的本地模型资源（vLLM 等 OpenAI 兼容服务），与 API 服务同机可直接调用。',
  },
];

const STORE_KEY = 'hazard.modelConfigs.v1';

export function defaultStore(): ModelConfigStore {
  return { presets: BUILTIN_PRESETS.map((p) => ({ ...p })), activeId: DEFAULT_PRESET_ID, history: [] };
}

export function loadStore(): ModelConfigStore {
  const fallback = defaultStore();
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ModelConfigStore> | null;
    if (!parsed || !Array.isArray(parsed.presets) || !parsed.presets.length) return fallback;
    const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id));
    const presets = [
      ...BUILTIN_PRESETS.map((p) => ({ ...p })),
      ...parsed.presets
        .filter((p): p is ModelPreset => Boolean(p && typeof p.id === 'string' && !builtinIds.has(p.id)))
        .map(normalizePreset),
    ];
    const known = new Set(presets.map((p) => p.id));
    const activeId =
      typeof parsed.activeId === 'string' && known.has(parsed.activeId) ? parsed.activeId : DEFAULT_PRESET_ID;
    const history = (Array.isArray(parsed.history) ? parsed.history : [])
      .filter((id): id is string => typeof id === 'string' && known.has(id) && id !== activeId)
      .slice(0, 2);
    return { presets, activeId, history };
  } catch {
    return fallback;
  }
}

export function saveStore(store: ModelConfigStore): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // 存储满时静默失败，不影响本次内存态使用
  }
}

export function normalizePreset(p: ModelPreset): ModelPreset {
  return {
    id: p.id,
    name: p.name || '未命名配置',
    builtin: false,
    mode: p.mode === 'ai' ? 'ai' : 'auto',
    baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
    model: typeof p.model === 'string' ? p.model : '',
    note: typeof p.note === 'string' ? p.note : undefined,
  };
}

export function presetById(store: ModelConfigStore, id: string): ModelPreset | null {
  return store.presets.find((p) => p.id === id) ?? null;
}

/** 切换激活配置：记录「上一次配置」历史（最多两条，去重）。 */
export function switchActive(store: ModelConfigStore, nextId: string): ModelConfigStore {
  if (nextId === store.activeId) return store;
  const history = [store.activeId, ...store.history.filter((id) => id !== nextId && id !== store.activeId)].slice(0, 2);
  return { ...store, activeId: nextId, history };
}

/** 保存（新增或更新）自定义配置；内置预设由调用方先另存为新 id。 */
export function upsertPreset(store: ModelConfigStore, preset: ModelPreset): ModelConfigStore {
  const normalized = { ...normalizePreset(preset), builtin: false };
  const idx = store.presets.findIndex((p) => p.id === preset.id);
  const presets = idx >= 0
    ? store.presets.map((p, i) => (i === idx ? normalized : p))
    : [...store.presets, normalized];
  return { ...store, presets };
}

/** 删除自定义配置；若删除的是激活配置则回落到默认配置。 */
export function removePreset(store: ModelConfigStore, id: string): ModelConfigStore {
  const presets = store.presets.filter((p) => p.id !== id);
  const activeId = store.activeId === id ? DEFAULT_PRESET_ID : store.activeId;
  const history = store.history.filter((h) => h !== id);
  return { ...store, presets, activeId, history };
}

export function nextCustomName(store: ModelConfigStore): string {
  const count = store.presets.filter((p) => !p.builtin).length + 1;
  const name = `自定义配置 ${count}`;
  return store.presets.some((p) => p.name === name) ? `自定义配置 ${count + 1}` : name;
}

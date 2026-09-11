import { useCallback, useEffect, useState } from 'react';
import { fetchModelInfo, resetModelConfig, saveModelConfig, type ModelInfo } from '../api/model';
import {
  IconEye,
  IconEyeOff,
  IconInfo,
  IconPlus,
  IconRefresh,
  IconSave,
  IconServer,
  IconTrash,
  IconZap,
} from '../components/icons';
import {
  DEFAULT_PRESET_ID,
  loadStore,
  nextCustomName,
  presetById,
  removePreset,
  saveStore,
  switchActive,
  upsertPreset,
  type ModelConfigStore,
  type ModelMode,
  type ModelPreset,
} from '../lib/modelConfigs';

export function ModelConfig({ onConfigChanged }: { onConfigChanged: () => void }) {
  const [store, setStore] = useState<ModelConfigStore>(() => loadStore());
  const [selectedId, setSelectedId] = useState(store.activeId);
  const selected = presetById(store, selectedId) ?? store.presets[0];
  const [form, setForm] = useState<ModelPreset>(() => ({ ...selected }));
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    void fetchModelInfo().then(setInfo).catch(() => undefined);
  }, []);

  // 选中配置变化时，编辑表单同步为该配置
  useEffect(() => {
    const p = presetById(store, selectedId);
    if (p) setForm({ ...p });
  }, [selectedId, store]);

  /** 应用配置到服务端：先清空运行期配置，避免旧 API Key / 字段残留。 */
  const applyToServer = useCallback(async (preset: ModelPreset): Promise<ModelInfo> => {
    const cleared = await resetModelConfig();
    if (preset.id === DEFAULT_PRESET_ID) return cleared;
    return saveModelConfig({ baseUrl: preset.baseUrl, apiKey: preset.apiKey, model: preset.model, mode: preset.mode });
  }, []);

  const switchTo = useCallback(
    async (id: string) => {
      const preset = presetById(store, id);
      if (!preset || id === store.activeId) return;
      setSwitching(true);
      setFeedback('');
      try {
        const nextInfo = await applyToServer(preset);
        const nextStore = switchActive(store, id);
        setStore(nextStore);
        saveStore(nextStore);
        setSelectedId(id);
        setInfo(nextInfo);
        onConfigChanged();
        setFeedback(`已切换到「${preset.name}」，新的分析请求将立即使用该配置。`);
      } catch (e) {
        setFeedback(`切换失败：${(e as Error).message}`);
      } finally {
        setSwitching(false);
      }
    },
    [store, applyToServer, onConfigChanged]
  );

  const save = useCallback(async () => {
    setSaving(true);
    setFeedback('');
    try {
      const target: ModelPreset = {
        ...selected,
        id: selected.builtin ? `preset-custom-${Date.now()}` : selected.id,
        builtin: false,
        name: form.name.trim() || selected.name,
        mode: form.mode,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        model: form.model.trim(),
      };
      let nextStore = upsertPreset(store, target);
      if (target.id !== store.activeId) nextStore = switchActive(nextStore, target.id);
      setStore(nextStore);
      saveStore(nextStore);
      setSelectedId(target.id);
      const nextInfo = await applyToServer(target);
      setInfo(nextInfo);
      onConfigChanged();
      setFeedback(
        selected.builtin
          ? `已按新配置保存并应用「${target.name}」（内置预设未改动）。`
          : `已保存并应用「${target.name}」，新的分析请求将使用该配置。`
      );
    } catch (e) {
      setFeedback(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [store, selected, form, applyToServer, onConfigChanged]);

  const createNew = useCallback(async () => {
    const preset: ModelPreset = {
      id: `preset-custom-${Date.now()}`,
      name: nextCustomName(store),
      builtin: false,
      mode: 'auto',
      baseUrl: '',
      apiKey: '',
      model: '',
      note: '自定义配置：填写后点击「保存配置」生效。',
    };
    const nextStore = switchActive({ ...store, presets: [...store.presets, preset] }, preset.id);
    setStore(nextStore);
    saveStore(nextStore);
    setSelectedId(preset.id);
    setSwitching(true);
    setFeedback('');
    try {
      const nextInfo = await applyToServer(preset);
      setInfo(nextInfo);
      onConfigChanged();
      setFeedback(`已新建并应用「${preset.name}」（空白配置），编辑后点击「保存配置」。`);
    } catch (e) {
      setFeedback(`新建失败：${(e as Error).message}`);
    } finally {
      setSwitching(false);
    }
  }, [store, applyToServer, onConfigChanged]);

  const remove = useCallback(async () => {
    if (selected.builtin) return;
    setFeedback('');
    try {
      const nextStore = removePreset(store, selected.id);
      setStore(nextStore);
      saveStore(nextStore);
      setSelectedId(nextStore.activeId);
      if (nextStore.activeId !== store.activeId) {
        const fallback = presetById(nextStore, nextStore.activeId);
        if (fallback) {
          const nextInfo = await applyToServer(fallback);
          setInfo(nextInfo);
          onConfigChanged();
        }
      }
      setFeedback(`已删除「${selected.name}」。`);
    } catch (e) {
      setFeedback(`删除失败：${(e as Error).message}`);
    }
  }, [store, selected, applyToServer, onConfigChanged]);

  const test = useCallback(async () => {
    setTesting(true);
    setTestResult('');
    try {
      const res = await fetch('/api/health-check', { method: 'POST' });
      const data = (await res.json()) as { ok: boolean; message: string };
      setTestResult(data.message);
    } catch {
      setTestResult('测试请求失败');
    } finally {
      setTesting(false);
    }
  }, []);

  const sourceLabel =
    info?.source === 'runtime' ? '运行期配置（模型配置页保存）' : info?.source === 'env' ? '环境变量 / .env' : '未配置（需填写 API Key / Base URL）';
  const historyLabel = store.history.map((id) => presetById(store, id)?.name ?? id).join(' → ');

  return (
    <div className="page">
      <div className="page-head">
        <h1>模型配置</h1>
        <div className="sub">多套模型接入配置集中管理：下拉切换、自定义新增/编辑/保存；配置持久化并保留最近两次历史。</div>
      </div>

      {feedback && (
        <div className="disclaimer-bar" style={{ marginBottom: 16, color: 'var(--text-2)' }}>
          <IconInfo size={13} />
          {feedback}
        </div>
      )}

      <div className="settings-grid">
        {/* 切换配置 */}
        <div className="card card-pad">
          <div className="section-label">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconServer size={14} /> 切换模型配置
            </span>
          </div>

          <div className="form-field">
            <label>当前配置</label>
            <select className="select" value={selectedId} disabled={switching} onChange={(e) => void switchTo(e.target.value)}>
              {store.presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <div className="hint">选择后立即应用并持久化到服务端 .runtime-model.json；自定义配置保存在浏览器本地。</div>
          </div>

          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button
              className="btn btn-outline btn-sm"
              disabled={switching || !store.history[0]}
              onClick={() => void switchTo(store.history[0])}
              title="恢复上一次配置"
            >
              <IconRefresh size={13} />
              上一次配置
            </button>
            <button
              className="btn btn-outline btn-sm"
              disabled={switching || !store.history[1]}
              onClick={() => void switchTo(store.history[1])}
              title="恢复上上次配置"
            >
              <IconRefresh size={13} />
              上上次配置
            </button>
            <span className="small muted" style={{ marginLeft: 'auto' }}>
              {store.history.length ? `历史：${historyLabel}` : '暂无历史记录'}
            </span>
          </div>

          {selected.note && (
            <div className="small muted" style={{ marginTop: 12, lineHeight: 1.7 }}>
              <IconInfo size={12} /> {selected.note}
            </div>
          )}

          <div style={{ marginTop: 14, borderTop: '1px dashed var(--border)', paddingTop: 12 }}>
            <div className="info-row"><span className="k">当前生效模式</span><span className="v">AI 模式</span></div>
            <div className="info-row"><span className="k">生效模型</span><span className="v">{info?.model ?? '未配置'}</span></div>
            <div className="info-row"><span className="k">配置来源</span><span className="v">{sourceLabel}</span></div>
            <div className="info-row"><span className="k">API Key</span><span className="v">{info?.hasApiKey ? '已配置' : '未配置'}</span></div>
          </div>
        </div>

        {/* 编辑配置 */}
        <div className="card card-pad">
          <div className="section-label">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconZap size={14} /> 编辑当前配置{selected.builtin ? '（内置预设，保存将另存为新配置）' : '（自定义配置）'}
            </span>
          </div>

          <div className="form-field">
            <label>配置名称</label>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="配置名称"
              spellCheck={false}
            />
          </div>

          <div className="form-field">
            <label>运行模式</label>
            <select className="select" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as ModelMode })}>
              <option value="auto">自动（有 Key 用 AI，无 Key 提示未配置）</option>
              <option value="ai">始终使用 AI 模式（需填写地址 / Key）</option>
            </select>
          </div>

          <div className="form-field">
            <label>API 地址（OpenAI 兼容 Base URL）</label>
            <input
              className="input"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="https://api.deepseek.com/v1（无需带 /chat/completions）"
              spellCheck={false}
            />
          </div>

          <div className="form-field">
            <label>API Key</label>
            <div className="pwd-wrap">
              <input
                className="input"
                type={showKey ? 'text' : 'password'}
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder="sk-...（本地模型可留空）"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="pwd-eye"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </button>
            </div>
            <div className="hint">密钥以明文保存于项目根目录 .runtime-model.json（已加入 .gitignore），仅用于服务端调用模型。</div>
          </div>

          <div className="form-field">
            <label>模型名称</label>
            <input
              className="input"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="deepseek-v4-flash-vision-exp / qwen2.5-vl"
              spellCheck={false}
            />
          </div>

          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-outline btn-sm" onClick={() => void test()} disabled={testing}>
              {testing ? '正在测试…' : '测试连接'}
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => void createNew()} disabled={switching}>
              <IconPlus size={13} />
              新建配置
            </button>
            {!selected.builtin && (
              <button className="btn btn-danger-soft btn-sm" onClick={() => void remove()} disabled={switching}>
                <IconTrash size={13} />
                删除配置
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving || switching}>
              <IconSave size={13} />
              {saving ? '保存中…' : '保存配置'}
            </button>
          </div>

          {testResult && <div className="small" style={{ marginTop: 10, color: 'var(--text-2)' }}>连通性测试：{testResult}</div>}
        </div>
      </div>
    </div>
  );
}

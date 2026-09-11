/** 浏览器侧 Agent ID：conversation 跨刷新，session 仅当前标签，task 按业务任务生成。 */
const CONVERSATION_KEY = 'hazard.agent.conversation.v1';
const SESSION_KEY = 'hazard.agent.session.v1';

function newId(prefix: string): string {
  // HTTP 服务器 IP 不属于安全上下文，randomUUID 可能不可用；getRandomValues 仍可使用。
  if (typeof crypto.randomUUID === 'function') return `${prefix}_${crypto.randomUUID()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function persistentId(storage: Storage, key: string, prefix: string): string {
  try {
    const current = storage.getItem(key);
    if (current) return current;
    const created = newId(prefix);
    storage.setItem(key, created);
    return created;
  } catch {
    return newId(prefix);
  }
}

export function getAgentIdentity(): { conversationId: string; sessionId: string } {
  return {
    conversationId: persistentId(localStorage, CONVERSATION_KEY, 'conv'),
    sessionId: persistentId(sessionStorage, SESSION_KEY, 'sess'),
  };
}

export function createAgentTaskId(): string {
  return newId('task');
}

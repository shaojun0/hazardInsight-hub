/** Token Usage 查询：前端只消费后端归一化后的 Provider usage。 */
import type { TokenUsageOverview } from '../../shared/token-usage';
import type { ContextObservabilityOverview, LLMStep } from '../../shared/context-observability';
import { getAgentIdentity } from '../agent/session';
import { parseRes } from './client';

export async function fetchTokenUsageOverview(signal?: AbortSignal): Promise<TokenUsageOverview> {
  const identity = getAgentIdentity();
  const params = new URLSearchParams({
    conversationId: identity.conversationId,
    sessionId: identity.sessionId,
  });
  const response = await fetch(`/api/agent/token-usage?${params}`, { signal });
  const body = await parseRes<{ data: TokenUsageOverview }>(response);
  return body.data;
}

export async function fetchContextObservability(signal?: AbortSignal): Promise<ContextObservabilityOverview> {
  const identity = getAgentIdentity();
  const params = new URLSearchParams({ conversationId: identity.conversationId, sessionId: identity.sessionId });
  const response = await fetch(`/api/agent/context-observability?${params}`, { signal });
  const body = await parseRes<{ data: ContextObservabilityOverview }>(response);
  return body.data;
}

export async function fetchContextStep(stepId: string, signal?: AbortSignal): Promise<LLMStep> {
  const response = await fetch(`/api/agent/context-observability/steps/${encodeURIComponent(stepId)}`, { signal });
  const body = await parseRes<{ data: LLMStep }>(response);
  return body.data;
}

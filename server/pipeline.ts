/**
 * 旧 pipeline 兼容门面。
 * 新代码应通过共享 AgentRuntime 调用；保留本导出避免已有集成一次性失效。
 */
import type { AnalysisResult } from '../shared/types.js';
import { AgentRuntime } from './agent/runtime.js';
import type { MultimodalModelProvider } from './providers/types.js';
import type { KnowledgeRetriever } from './retrieval/index.js';

export interface RunAnalysisInput {
  buffer: Buffer;
  mimeType: string;
  scenario?: string;
  provider: MultimodalModelProvider;
  retriever: KnowledgeRetriever;
}
export async function runAnalysis(input: RunAnalysisInput): Promise<AnalysisResult> {
  const runtime = new AgentRuntime(input.retriever);
  return runtime.runHazardAnalysis({
    buffer: input.buffer,
    mimeType: input.mimeType,
    scenario: input.scenario,
    providerOverride: input.provider,
    frontendState: { source: 'workbench', scenarioId: input.scenario },
  });
}

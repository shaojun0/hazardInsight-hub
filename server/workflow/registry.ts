/** 有界进程内 Workflow Registry；生产可替换为持久化仓库。 */
import type { WorkflowDefinition } from '../../shared/workflow-schema.js';
import type { NodeRegistry } from '../nodes/registry.js';
import { validateWorkflow, type WorkflowValidationReport } from './validator.js';

export type WorkflowRevisionStatus = 'draft' | 'published' | 'retired';

export interface StoredWorkflowRevision {
  status: WorkflowRevisionStatus;
  definition: WorkflowDefinition;
  hash: string;
  validation: WorkflowValidationReport;
  createdAt: string;
  publishedAt?: string;
}

export class InMemoryWorkflowRegistry {
  private readonly revisions = new Map<string, StoredWorkflowRevision>();

  constructor(private readonly nodes: NodeRegistry) {}

  saveDraft(definition: WorkflowDefinition): StoredWorkflowRevision {
    const validation = validateWorkflow(definition, this.nodes);
    const revision: StoredWorkflowRevision = {
      status: 'draft',
      definition: structuredClone(definition),
      hash: validation.canonicalHash,
      validation,
      createdAt: new Date().toISOString(),
    };
    this.revisions.set(keyOf(definition.metadata.id, definition.metadata.version), revision);
    return structuredClone(revision);
  }

  publish(id: string, version: string, expectedHash: string): StoredWorkflowRevision {
    const key = keyOf(id, version);
    const current = this.revisions.get(key);
    if (!current) throw new Error(`Workflow revision 不存在：${id}@${version}`);
    if (current.hash !== expectedHash) throw new Error('Workflow base hash 已变化，拒绝发布。');
    if (!current.validation.valid) throw new Error('Workflow 校验失败，不能发布。');
    if (current.validation.riskSummary.unimplementedNodes.length) {
      throw new Error(`Workflow 仍有未接入执行器的 Node：${current.validation.riskSummary.unimplementedNodes.join(', ')}`);
    }
    const next: StoredWorkflowRevision = {
      ...current,
      status: 'published',
      publishedAt: new Date().toISOString(),
    };
    this.revisions.set(key, next);
    return structuredClone(next);
  }

  get(id: string, version: string): StoredWorkflowRevision | null {
    const value = this.revisions.get(keyOf(id, version));
    return value ? structuredClone(value) : null;
  }

  list(): StoredWorkflowRevision[] {
    return [...this.revisions.values()].map((value) => structuredClone(value));
  }
}

function keyOf(id: string, version: string): string {
  return `${id}@${version}`;
}


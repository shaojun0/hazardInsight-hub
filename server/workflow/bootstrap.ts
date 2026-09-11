/** 组装首期 Workflow 控制面，并加载仓库内置 draft。 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBuiltinNodeRegistry } from '../nodes/builtin-catalog.js';
import { loadWorkflowSource } from './loader.js';
import { InMemoryWorkflowRegistry } from './registry.js';

export function createWorkflowControlPlane(rootDir = process.cwd()) {
  const nodes = createBuiltinNodeRegistry();
  const workflows = new InMemoryWorkflowRegistry(nodes);
  const builtin = resolve(rootDir, 'configs', 'workflows', 'hazard-analysis.v1.yaml');
  if (existsSync(builtin)) {
    const definition = loadWorkflowSource(readFileSync(builtin, 'utf8'), 'yaml');
    workflows.saveDraft(definition);
  }
  return { nodes, workflows };
}

export type WorkflowControlPlane = ReturnType<typeof createWorkflowControlPlane>;


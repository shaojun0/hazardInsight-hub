/** 可插拔 Node 注册表；Workflow 只引用精确 type@version。 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { NodeCatalogEntry, NodeDefinition } from '../../shared/node-protocol.js';

const NODE_USE = /^([a-z][a-z0-9_.-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function parseNodeUse(value: string): { type: string; version: string } | null {
  const match = value.match(NODE_USE);
  return match ? { type: match[1], version: match[2] } : null;
}

export class NodeRegistry {
  private readonly definitions = new Map<string, NodeDefinition>();

  register<I, O, C>(definition: NodeDefinition<I, O, C>): void {
    const key = `${definition.type}@${definition.version}`;
    if (this.definitions.has(key)) throw new Error(`Node 已重复注册：${key}`);
    this.definitions.set(key, definition as NodeDefinition);
  }

  resolve(use: string): NodeDefinition | null {
    return this.definitions.get(use) ?? null;
  }

  require(use: string): NodeDefinition {
    const definition = this.resolve(use);
    if (!definition) throw new Error(`Node 未注册：${use}`);
    return definition;
  }

  catalog(): NodeCatalogEntry[] {
    return [...this.definitions.values()]
      .sort((a, b) => a.type.localeCompare(b.type) || a.version.localeCompare(b.version))
      .map((definition) => ({
        type: definition.type,
        version: definition.version,
        description: definition.description,
        capabilities: definition.capabilities,
        implemented: typeof definition.execute === 'function',
        inputJsonSchema: zodToJsonSchema(definition.inputSchema, { target: 'jsonSchema7' }) as object,
        outputJsonSchema: zodToJsonSchema(definition.outputSchema, { target: 'jsonSchema7' }) as object,
        configJsonSchema: zodToJsonSchema(definition.configSchema, { target: 'jsonSchema7' }) as object,
      }));
  }
}


/** Agent run/event 进程内观测存储；有界保存，生产可替换为持久化 repository。 */
import type { AgentRunSnapshot, AgentStreamEvent } from '../../../shared/agent-protocol.js';

export class InMemoryRunStore {
  private readonly runs = new Map<string, AgentRunSnapshot>();
  private readonly events = new Map<string, AgentStreamEvent[]>();

  constructor(private readonly maxRuns = 200) {}

  create(snapshot: AgentRunSnapshot): void {
    this.runs.set(snapshot.runId, snapshot);
    this.events.set(snapshot.runId, []);
    this.prune();
  }

  update(runId: string, patch: Partial<AgentRunSnapshot>): AgentRunSnapshot | null {
    const current = this.runs.get(runId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.runs.set(runId, next);
    return next;
  }

  append(event: AgentStreamEvent): void {
    const list = this.events.get(event.runId) ?? [];
    list.push(event);
    this.events.set(event.runId, list.slice(-500));
  }

  getRun(runId: string): AgentRunSnapshot | null {
    return this.runs.get(runId) ?? null;
  }

  getEvents(runId: string, after = 0): AgentStreamEvent[] {
    return (this.events.get(runId) ?? []).filter((event) => event.sequence > after);
  }

  getByTraceId(traceId: string): AgentRunSnapshot | null {
    return [...this.runs.values()].find((run) => run.traceId === traceId) ?? null;
  }

  private prune(): void {
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.runs.delete(oldest);
      this.events.delete(oldest);
    }
  }
}

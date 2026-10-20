import type { UIMessage } from 'ai';
import type { TurnMetadata } from './api';

/** Read-only views over a session's UIMessage list, used by the conversation UI. */

/** Bounded context size from the newest assistant message that recorded it. */
export function latestContext(messages: UIMessage[]): TurnMetadata['context'] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const context = (messages[index].metadata as TurnMetadata | undefined)?.context;
    if (messages[index].role === 'assistant' && context) return context;
  }
}

export type PlanItem = { step: string; status: 'pending' | 'in_progress' | 'done' };

/** The newest updatePlan call in this session, shown above the composer. */
export function latestPlan(messages: UIMessage[]): PlanItem[] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const parts = messages[index].parts;
    for (let part = parts.length - 1; part >= 0; part--) {
      const item = parts[part] as { type: string; input?: { items?: PlanItem[] } };
      if (item.type === 'tool-updatePlan' && Array.isArray(item.input?.items)) return item.input.items;
    }
  }
}

export const hasPendingApproval = (messages: UIMessage[]) => messages.at(-1)?.role === 'assistant'
  && messages.at(-1)!.parts.some(part => (part as { state?: string }).state === 'approval-requested');

/** The newest tool call that has not finished, for the activity bar. */
export function currentStep(messages: UIMessage[]): string | undefined {
  const parts = messages.at(-1)?.role === 'assistant' ? messages.at(-1)!.parts : [];
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index] as { type: string; toolName?: string; state?: string };
    if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
      return part.state === 'input-streaming' || part.state === 'input-available' ? part.toolName || part.type.slice(5) : undefined;
    }
  }
}

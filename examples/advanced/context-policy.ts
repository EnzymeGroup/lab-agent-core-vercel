import type { ModelMessage, ToolLoopAgentSettings, ToolSet } from 'ai';

export interface SavedArtifact { path: string; note?: string }
export interface ContextNotice { characters: number; budget: number; droppedMessages: number; artifactCount: number }

/** Native prepareStep policy: no new message protocol or generated memory summary. */
export function createScientificContextPolicy(options: {
  stableRules: string;
  savedArtifacts: () => SavedArtifact[] | Promise<SavedArtifact[]>;
  maxContextChars: number;
  warningRatio?: number;
  onNearBudget?: (notice: ContextNotice) => void;
}): NonNullable<ToolLoopAgentSettings<never, ToolSet>['prepareStep']> {
  const ratio = options.warningRatio ?? 0.8;
  if (!Number.isSafeInteger(options.maxContextChars) || options.maxContextChars < 256 || ratio <= 0 || ratio >= 1) throw new Error('Choose a character budget >=256 and a warning ratio between 0 and 1.');
  let notified = false;
  return async step => {
    const artifacts = await options.savedArtifacts();
    const characters = JSON.stringify(step.messages).length;
    const near = characters >= options.maxContextChars * ratio;
    const messages: ModelMessage[] = [...step.messages];
    if (near) {
      // Cut only at complete user-turn boundaries, preserving tool-call/result pairs.
      while (JSON.stringify(messages).length > options.maxContextChars * 0.65) {
        const next = messages.findIndex((message, index) => index > 0 && message.role === 'user');
        if (next < 0) break; // Never silently discard a current turn's tool evidence.
        messages.splice(0, next);
      }
    }
    const references = artifacts.map(item => `- ${item.path}${item.note ? `: ${item.note}` : ''}`).join('\n') || '(none saved)';
    const base = step.initialInstructions ?? '';
    const initial = typeof base === 'string' ? [{ role: 'system' as const, content: base }] : Array.isArray(base) ? base : [base];
    const notice = { characters, budget: options.maxContextChars, droppedMessages: step.messages.length - messages.length, artifactCount: artifacts.length };
    if (near && !notified) options.onNearBudget?.(notice);
    notified = near;
    return {
      messages,
      instructions: [...initial, { role: 'system', content: [
        options.stableRules,
        `Saved intermediate artifact references (paths only; read the file before relying on its contents):\n${references}`,
        near ? 'Context is near the configured character budget. Save intermediate results in the active output directory and cite their paths. Older complete turns may be omitted; do not invent their contents.' : '',
      ].filter(Boolean).join('\n\n') }],
    };
  };
}

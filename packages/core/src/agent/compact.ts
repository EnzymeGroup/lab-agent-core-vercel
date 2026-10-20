import { convertToModelMessages, generateText, type ModelMessage, type ToolSet, type UIMessage } from 'ai';
import { InputError } from '../errors.js';
import { limitsOf } from '../config/load.js';
import { selectModel } from '../config/models.js';
import { stepRecord } from './steps.js';
import type { AgentConfig, CompactionConfig, SessionRecord, StepRecord } from '../types.js';

/**
 * Compaction: older turns are replaced in the model's view by one summary message.
 * Session history is never rewritten; session.summary records which messages the
 * summary covers. Runs only at the start of a user turn, so the cut always falls
 * on a user-message boundary and never separates a tool call from its result.
 */

const DEFAULTS = { at: 0.75, keepTurns: 2 };
const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_PART_CHARS = 2_000;

const SUMMARY_RULES = `You compress an agent conversation so work can continue without the full transcript.
Write a concise summary with these sections when they apply:
- Goal: what the person wants, including acceptance criteria.
- Decisions and facts: conclusions reached, numbers, constraints.
- Files: project paths read or written, and what they contained or received.
- Tool results that matter later.
- Open items: what remains to be done next.
Use only information in the transcript. Do not invent results.`;

export function compactionPolicy(config: AgentConfig): Required<Omit<CompactionConfig, 'model'>> & { model?: string } | undefined {
  return config.compaction === false ? undefined : { ...DEFAULTS, ...config.compaction };
}

/** Messages after the summarized prefix. A summary pointing at a missing message is ignored. */
export function unsummarized(session: SessionRecord): UIMessage[] {
  const through = session.summary?.throughMessageId;
  const index = through ? session.messages.findIndex(message => message.id === through) : -1;
  return index < 0 ? session.messages : session.messages.slice(index + 1);
}

/** The summary as the first user message of the model's view. */
export function summaryMessage(session: SessionRecord): ModelMessage[] {
  const summary = session.summary;
  if (!summary || unsummarized(session) === session.messages) return [];
  return [{ role: 'user', content: `[Summary of ${summary.messageCount} earlier messages. The full history is saved on disk but not shown to you.]\n${summary.text}` }];
}

/** True when the unsummarized history would reach the compaction threshold. */
export async function needsCompaction(config: AgentConfig, session: SessionRecord, tools: ToolSet, lastInputTokens?: number): Promise<boolean> {
  const policy = compactionPolicy(config);
  if (!policy || userIndexes(session.messages).length <= policy.keepTurns) return false;
  const limits = limitsOf(config);
  if (limits.maxContextTokens && lastInputTokens && lastInputTokens >= limits.maxContextTokens * policy.at) return true;
  const messages = await convertToModelMessages(unsummarized(session), { tools, ignoreIncompleteToolCalls: true });
  return JSON.stringify([...summaryMessage(session), ...messages]).length >= limits.maxContextChars * policy.at;
}

/**
 * Summarize everything before the last keepTurns user turns (including any previous summary).
 * Returns false when there is nothing old enough to summarize.
 */
export async function compactSession(config: AgentConfig, session: SessionRecord, tools: ToolSet, options: { modelKey?: string; signal?: AbortSignal; onStep?: (step: StepRecord) => void } = {}): Promise<boolean> {
  const policy = compactionPolicy(config);
  if (!policy) throw new InputError('Compaction is disabled for this agent (compaction: false).');
  const pending = unsummarized(session);
  const offset = session.messages.length - pending.length;
  const users = userIndexes(pending);
  if (users.length <= policy.keepTurns) return false;
  const cut = users.at(-policy.keepTurns)!;
  const older = pending.slice(0, cut);
  if (!older.length) return false;

  const transcript = render(await convertToModelMessages(older, { tools, ignoreIncompleteToolCalls: true }));
  const previous = session.summary && offset ? `Previous summary:\n${session.summary.text}\n\n` : '';
  const selected = selectModel(config, policy.model ?? options.modelKey);
  const result = await generateText({
    model: selected.model, instructions: SUMMARY_RULES, maxRetries: limitsOf(config).maxRetries, abortSignal: options.signal,
    prompt: `${previous}Conversation to summarize:\n${transcript}`,
  });
  for (const step of result.steps) options.onStep?.(stepRecord('summary', selected.key, step));
  const text = result.text.trim();
  if (!text) throw new Error('The summary model returned no text.');
  session.summary = {
    text, throughMessageId: older.at(-1)!.id,
    messageCount: offset + older.length, createdAt: new Date().toISOString(),
  };
  return true;
}

function userIndexes(messages: UIMessage[]): number[] {
  return messages.flatMap((message, index) => message.role === 'user' ? [index] : []);
}

/** Plain-text transcript, each part clipped, keeping the newest text when over budget. */
function render(messages: ModelMessage[]): string {
  const clip = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > MAX_PART_CHARS ? `${text.slice(0, MAX_PART_CHARS)} […]` : text;
  };
  const lines = messages.map(message => {
    if (typeof message.content === 'string') return `${message.role}: ${clip(message.content)}`;
    return message.content.map(part => {
      if (part.type === 'text') return `${message.role}: ${clip(part.text)}`;
      if (part.type === 'tool-call') return `tool call ${part.toolName}: ${clip(part.input)}`;
      if (part.type === 'tool-result') return `tool result ${part.toolName}: ${clip(part.output)}`;
      return '';
    }).filter(Boolean).join('\n');
  });
  const text = lines.join('\n');
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text;
}

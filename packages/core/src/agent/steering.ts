import { randomUUID } from 'node:crypto';
import type { ModelMessage, UIMessage, UIMessageChunk } from 'ai';
import type { SteeringQueue } from '../workspace/context.js';
import type { SessionRecord } from '../types.js';

/**
 * Messages a person sends while a turn runs.
 *
 *   steer()      → queue.pending
 *   prepareStep  → appended to the model's view as user messages (the SDK carries
 *                  prepared messages into later steps), moved to queue.announced
 *   UI stream    → a `data-steer` part is emitted before the next step starts
 *   turn end     → splitSteering() turns each data-steer part into a real user message
 *
 * Text still pending when the loop ends becomes a follow-up segment (finish.ts).
 */

export const STEER_PART = 'data-steer';

export function createSteeringQueue(): SteeringQueue {
  return { pending: [], announced: [], accepting: true };
}

/** Called from prepareStep: move pending steering into the model's view. */
export function injectSteering(queue: SteeringQueue | undefined, messages: ModelMessage[]): ModelMessage[] {
  if (!queue?.pending.length) return messages;
  const texts = queue.pending.splice(0);
  queue.announced.push(...texts);
  return [...messages, ...texts.map(text => ({ role: 'user' as const, content: text }))];
}

/** Record injected steering in the UI stream just before the step that first sees it. */
export function announceSteering(queue: SteeringQueue): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream({
    transform(chunk, writer) {
      if (chunk.type === 'start-step') {
        for (const text of queue.announced.splice(0)) writer.enqueue({ type: STEER_PART, data: { text } } as UIMessageChunk);
      }
      writer.enqueue(chunk);
    },
    flush() {
      // Injected but never reached a step (the loop ended): retry as a follow-up.
      queue.pending.unshift(...queue.announced.splice(0));
    },
  });
}

/**
 * Split assistant messages at data-steer parts:
 *   assistant[a, steer, b] → assistant[a], user[steer], assistant[b]
 * The first piece keeps the original ID; the last keeps the turn metadata. Idempotent.
 */
export function splitSteering(session: SessionRecord): void {
  if (!session.messages.some(message => message.role === 'assistant' && message.parts.some(part => part.type === STEER_PART))) return;
  const messages: UIMessage[] = [];
  for (const message of session.messages) {
    if (message.role !== 'assistant' || !message.parts.some(part => part.type === STEER_PART)) {
      messages.push(message);
      continue;
    }
    const pieces: UIMessage[] = [];
    let parts: UIMessage['parts'] = [];
    const flush = () => {
      if (parts.some(part => part.type !== 'step-start')) pieces.push({ id: pieces.length ? randomUUID() : message.id, role: 'assistant', parts });
      parts = [];
    };
    for (const part of message.parts) {
      if (part.type !== STEER_PART) {
        parts.push(part);
        continue;
      }
      flush();
      const text = String((part as { data?: { text?: unknown } }).data?.text ?? '');
      pieces.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }], metadata: { source: 'steer' } });
    }
    flush();
    const last = pieces.findLast(piece => piece.role === 'assistant');
    if (last && message.metadata !== undefined) last.metadata = message.metadata;
    messages.push(...pieces);
  }
  session.messages = messages;
}

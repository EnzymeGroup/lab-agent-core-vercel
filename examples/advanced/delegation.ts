import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { modelFromEnv } from 'lab-agent-core-vercel';

/** Native AI SDK composition. Core does not add a scheduler or graph DSL. */
export async function delegatedAnswer(prompt: string, abortSignal?: AbortSignal) {
  const model = modelFromEnv();
  const reviewer = new ToolLoopAgent({
    model,
    instructions: 'Review a proposed analysis. Identify unsupported claims and missing evidence. Return concise feedback.',
    stopWhen: stepCountIs(2),
  });
  const author = new ToolLoopAgent({
    model,
    instructions: 'Draft an answer, ask the reviewer tool for evidence review, then provide your final answer.',
    tools: {
      review: tool({
        description: 'Ask a second native Agent to review a draft.',
        inputSchema: z.object({ draft: z.string() }),
        execute: async ({ draft }, options) => {
          // The parent tool execution signal reaches the delegated model request.
          const review = await reviewer.generate({ prompt: draft, abortSignal: options.abortSignal });
          return { text: review.text };
        },
      }),
    },
    stopWhen: stepCountIs(4),
  });
  return author.generate({ prompt, abortSignal });
}

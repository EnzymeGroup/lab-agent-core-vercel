import { ToolLoopAgent, stepCountIs } from 'ai';
import { modelFromEnv } from 'lab-agent-core-vercel';

/** The application owns this explicit sequence and passes cancellation through. */
export async function analyzeThenReview(task: string, abortSignal?: AbortSignal) {
  const model = modelFromEnv();
  const analyst = new ToolLoopAgent({ model, instructions: 'Write a bounded analysis. Distinguish observations from assumptions.', stopWhen: stepCountIs(3) });
  const reviewer = new ToolLoopAgent({ model, instructions: 'Audit the supplied analysis against the original task. Return issues and a corrected summary.', stopWhen: stepCountIs(3) });
  abortSignal?.throwIfAborted();
  const analysis = await analyst.generate({ prompt: task, abortSignal });
  abortSignal?.throwIfAborted();
  const review = await reviewer.generate({ prompt: `Original task:\n${task}\n\nAnalysis:\n${analysis.text}`, abortSignal });
  return { analysis: analysis.text, review: review.text };
}

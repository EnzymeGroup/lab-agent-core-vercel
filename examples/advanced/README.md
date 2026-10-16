# Native Agent composition

delegation.ts defines a reviewer as a native AI SDK tool used by an author Agent. two-agent-workflow.ts defines an explicit analyst → reviewer sequence. Both use ToolLoopAgent and propagate AbortSignal to every model call. There is no hidden scheduler, orchestration DSL or model switching policy.

Install dependencies and configure LAB_AGENT_MODEL and LAB_AGENT_API_KEY. Import either function from a TypeScript application (Node 22.19+ can import these files with built-in type stripping). These advanced native SDK calls are outside Core's automatic session/run persistence and delivery checks. For persisted execution, expose a native tool on defineAgent and invoke it through runTask/chat.

context-policy.ts is a reusable native prepareStep policy. It preserves initial instructions and stable scientific rules, retains references to saved intermediate files, emits a near-budget callback/model notice, and drops only older complete user turns. It does not invent summaries or mutate durable history. Its character bound is not a tokenizer-specific context guarantee; an oversized current turn still needs smaller tool output or a new session.

python-arguments.ts defines a native Tool + Zod input schema for a fixed CSV and a bounded maxRows argument. It invokes tools/csv-arguments.py through literal runCommand argv with the tool's AbortSignal and active Core task output directory. It refuses execution outside a task. The CSV sample preserves raw cells and missingness, while reporting only sampled rows. This trusted Python tool is not sandboxed.

context-agent.ts wires both helpers into an ordinary Core config, adding successful sample artifact paths to the next step's context references. Its in-memory reference list lasts for the current process; a production savedArtifacts callback should reload your durable artifact index after restart. Copy this complete advanced directory into an independent project, install the current Core tarball plus its declared native dependencies, and run:

```ts
import { createAgent, modelFromEnv } from 'lab-agent-core-vercel';
import { createContextExampleConfig } from './context-agent.ts';

const agent = await createAgent(createContextExampleConfig(process.cwd(), modelFromEnv()));
try {
  const run = await agent.runTask('Use csvHead to save two rows without changing empty cells.', {
    inputs: ['data/input.csv'],
  });
  console.log(run.execution, run.delivery);
} finally {
  await agent.close();
}
```

These native tools coexist with ordinary registered runPython, demonstrated by the sequence-summary/table-quality applications. Those computational registrations use modes:['task']; registrations without modes retain both modes for compatibility. No independent scientific checker is supplied for this bounded-sample advanced example, so delivery remains not_checked.

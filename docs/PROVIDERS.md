# Provider recipes

These are configuration recipes, not live-provider verification results. The local tests use a labeled deterministic HTTP fixture. Core accepts any compatible native AI SDK LanguageModel; modelFromEnv is a small helper for OpenAI Chat Completions and Anthropic, not an inventory of every SDK provider.

## OpenAI or Anthropic

In the project .env:

```dotenv
LAB_AGENT_PROVIDER=openai
LAB_AGENT_MODEL=YOUR_TOOL_CAPABLE_MODEL_ID
LAB_AGENT_API_KEY=YOUR_PROVIDER_KEY
# Optional OpenAI-compatible Chat Completions endpoint:
# LAB_AGENT_BASE_URL=https://your-endpoint.example/v1
```

For Anthropic use LAB_AGENT_PROVIDER=anthropic and its model ID/key. OPENAI_API_KEY and ANTHROPIC_API_KEY are accepted fallbacks. With the standard factory, modelFromEnv(env) reads the project env directly. Explicit process variables override .env without changing process.env. Do not put credentials in AGENTS.md, Skills, inputs or tool outputs.

Run `lab-agent inspect --json` to inspect the selected model without a connection. `lab-agent doctor` does not infer. `lab-agent doctor --probe-model` makes one explicit, potentially billable tool-free request; it does not prove the selected model can reliably perform the application's full tool workflow.

## Local vLLM

Run a model whose vLLM configuration supports tool calling. Automatic tool choice requires the matching parser and may require a model-specific chat template; follow the model's documented options rather than applying one parser universally. [Official vLLM tool-calling guide](https://docs.vllm.ai/en/latest/features/tool_calling/).

Point Core at that server:

```dotenv
LAB_AGENT_PROVIDER=openai
LAB_AGENT_MODEL=THE_SERVER_SERVED_MODEL_NAME
LAB_AGENT_BASE_URL=http://127.0.0.1:8000/v1
LAB_AGENT_API_KEY=THE_SERVER_CONFIGURED_TOKEN
```

The provider label selects the OpenAI-compatible protocol. The model ID must match the served name. If an intentionally unauthenticated local development server ignores authentication, a nonempty placeholder satisfies the client's explicit key requirement but does not add server authentication. Actual model/tool compatibility and GPU/server operation have not been tested here.

## Local Ollama

Start Ollama and obtain a tool-capable model using its normal installation workflow. Its OpenAI-compatible endpoint uses /v1 and accepts an API-key field that the local endpoint ignores. [Official Ollama compatibility documentation](https://docs.ollama.com/api/openai-compatibility).

```dotenv
LAB_AGENT_PROVIDER=openai
LAB_AGENT_MODEL=YOUR_INSTALLED_TOOL_CAPABLE_MODEL
LAB_AGENT_BASE_URL=http://127.0.0.1:11434/v1
LAB_AGENT_API_KEY=ollama-local-placeholder
```

The placeholder is for this local endpoint. It is not a credential for a hosted service. Tool support still depends on the actual installed model and server version.

## Native Google provider

Install the native provider in your independent project: `npm install @ai-sdk/google`. Current AI SDK documentation exposes createGoogle for an explicit API key; supply the project's env instead of relying on process-global provider defaults. [Official AI SDK Google provider documentation](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai).

```ts
import { createGoogle } from '@ai-sdk/google';
import { defineAgent } from 'lab-agent-core-vercel';

export default defineAgent(({ root, env }) => {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error('Set GOOGLE_GENERATIVE_AI_API_KEY');
  const google = createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  return { root, model: google('YOUR_GOOGLE_MODEL_ID') };
});
```

This uses a native LanguageModel directly. Setting LAB_AGENT_PROVIDER=google on modelFromEnv is unsupported and fails explicitly. Provider package versions must be compatible with this project's AI SDK major; inspect their official migration notes when upgrading. No Google credential-backed probe was performed in this environment.

## Optional real-provider application smoke

The repository includes `npm run test:live`. It is **opt-in and not run in the credential-free verification environment**. Export LAB_AGENT_PROVIDER, LAB_AGENT_MODEL and LAB_AGENT_API_KEY for the intended real provider before invoking it; LAB_AGENT_BASE_URL optionally selects the endpoint. The script does not substitute a fixture for missing credentials.

This makes actual, potentially billable requests on the two Python applications, checks Skill/Python execution, and additionally requires the native sourceEvidence tool on the CSV task. Evidence is written under .artifacts/live/<timestamp>. It is a bounded application-connectivity test, not a reasoning benchmark, human onboarding trial or scientific discovery validation.

# Native Agent composition

delegation.ts defines a reviewer as a native AI SDK tool used by an author Agent. two-agent-workflow.ts defines an explicit analyst → reviewer sequence. Both use ToolLoopAgent and propagate AbortSignal to every model call. There is no hidden scheduler, orchestration DSL or model switching policy.

Install dependencies and configure LAB_AGENT_MODEL and LAB_AGENT_API_KEY. Import either function from a TypeScript application (Node 22.19+ can import these files with built-in type stripping). These advanced native SDK calls are outside Core's automatic session/run persistence and delivery checks. For persisted execution, expose a native tool on defineAgent and invoke it through runTask/chat.

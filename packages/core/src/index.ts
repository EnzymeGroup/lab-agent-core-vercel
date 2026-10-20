/**
 * lab-agent-core-vercel — public API.
 *
 * Most projects need only defineAgent + modelFromEnv in agent.config.ts, then the
 * `lab-agent` CLI. Applications embedding an agent use createAgent.
 */

// Configure
export { defineAgent, loadAgentConfig, loadProjectEnvironment, type AgentConfigContext, type AgentConfigFactory } from './config/load.js';
export { modelFromEnv, modelInfo } from './config/models.js';

// Run
export { createAgent, type LabAgent } from './agent/create.js';
export { projectContext } from './agent/prompt.js';
export { loadEvalFile, runEvals, type EvalCase, type EvalAttempt, type EvalReport } from './agent/eval.js';
export { limitsOf } from './config/load.js';
export { createHttpServer, type ServerOptions } from './server/http.js';
export { createRequestHandler } from './server/routes.js';

// Records
export { acquireOperation, lockOwner } from './store/lock.js';
export { atomicJSON } from './store/files.js';
export { sha256 } from './store/hash.js';
export { createSessionStore } from './store/sessions.js';
export { createRunStore } from './runs/store.js';
export { checkRun } from './runs/check.js';

// Building blocks for custom tools
export { createWorkspace, isSensitiveName, type Workspace } from './workspace/workspace.js';
export { getExecutionContext, runWithExecutionContext, type ExecutionContext } from './workspace/context.js';
export { runCommand, type CommandOptions, type CommandResult, type CommandError } from './workspace/process.js';
export { createTools, waitForToolExecutions, pythonToolAllowed } from './tools/index.js';
export { describeTools, type ToolDetail } from './tools/describe.js';
export { discoverSkills, loadSkill, snapshotSkills } from './tools/skills.js';
export { connectMcp, type McpStatus } from './tools/mcp.js';
export { listMemory, readMemory, saveMemory, forgetMemory, type MemoryEntry, type MemorySummary } from './store/memory.js';

// Diagnostics and scaffolding
export { inspectConfig, doctor } from './cli/doctor.js';
export { scaffold, templates } from './cli/scaffold.js';

// Errors
export { BusyError, NotFoundError, InputError, RunError, SessionCompatibilityError } from './errors.js';

export type * from './types.js';

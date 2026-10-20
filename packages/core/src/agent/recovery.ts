import { interruptCheckUnlocked } from '../runs/check.js';
import { listArtifacts, type RunStore } from '../runs/store.js';
import type { SessionStore } from '../store/sessions.js';
import type { AgentConfig } from '../types.js';

/**
 * After a crash, mark unfinished sessions, runs and checks as interrupted.
 * Never replays a tool call or checker. Caller must hold the project lock.
 */
export async function recoverInterrupted(config: AgentConfig, sessions: SessionStore, runs: RunStore): Promise<string[]> {
  const recovered: string[] = [];
  for (const session of (await sessions.list()).sessions) {
    if (session.state !== 'running') continue;
    session.state = 'interrupted';
    session.error = 'Previous process ended before this turn was finalized. Tool side effects were not replayed.';
    delete session.activeRunId;
    await sessions.save(session);
    recovered.push(session.id);
  }
  for (const run of (await runs.list()).runs) {
    if (run.pendingCheck) {
      await interruptCheckUnlocked(config, run);
      recovered.push(run.id);
    }
    if (run.execution !== 'running') continue;
    run.execution = 'failed';
    run.finishReason = 'interrupted';
    run.error = 'Execution was interrupted by process termination. Inspect existing outputs before retrying.';
    run.finishedAt = new Date().toISOString();
    run.artifacts = await listArtifacts(config.root, run.id).catch(() => run.artifacts);
    await runs.save(run);
    recovered.push(run.id);
  }
  return recovered;
}

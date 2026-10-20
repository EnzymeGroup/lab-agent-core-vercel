import type { RunRecord } from './types.js';

/** Error classes map directly to HTTP status codes and CLI exit behavior. */

/** 409: another operation owns the project. */
export class BusyError extends Error {
  constructor(message = 'Another operation is using this project. Wait or cancel the active operation.') {
    super(message);
    this.name = 'BusyError';
  }
}

/** 404: the requested record or artifact does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** 400: the caller supplied invalid input. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** A task failed; `run` is its persisted terminal record. */
export class RunError extends Error {
  constructor(readonly run: RunRecord, cause?: unknown) {
    super(run.error ?? 'Task execution failed.', { cause });
    this.name = 'RunError';
  }
}

/** Stored tool calls no longer match current tool definitions. History is left untouched. */
export class SessionCompatibilityError extends InputError {
  constructor(readonly sessionId: string, readonly incompatibleTools: string[], cause?: unknown) {
    const tools = incompatibleTools.length ? ` (${incompatibleTools.join(', ')})` : '';
    super(`Session ${sessionId} cannot continue with the current tool definitions${tools}. Restore compatible tool schemas or start a new session. Saved history has not been changed.`);
    this.name = 'SessionCompatibilityError';
    this.cause = cause;
  }
}

const SECRET_KEY =/(?:API_KEY|TOKEN|PASSWORD|SECRET)$/;

/** Format any thrown value, replacing credential values from the process and project environment. */
export function errorMessage(error: unknown, env?: NodeJS.ProcessEnv): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [key, value] of [...Object.entries(process.env), ...Object.entries(env ?? {})]) {
    if (value && value.length >= 6 && SECRET_KEY.test(key)) message = message.split(value).join('[redacted]');
  }
  return message;
}

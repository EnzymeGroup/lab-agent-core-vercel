import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}
/** Thrown execution failures retain bounded diagnostics for delivery logs. */
export interface CommandError extends Error {
  stdout: string;
  stderr: string;
  durationMs: number;
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Runs trusted registered commands with argv, never a shell. */
export async function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || !Array.isArray(args)
    || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TypeError('Command and arguments must be nonempty executable/string argv without NUL bytes.');
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError('Command timeoutMs must be 1–2147483647; maxOutputBytes must be a positive safe integer.');
  }
  options.signal?.throwIfAborted();
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error;
      }
    };
    const stop = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 150);
    };
    const abort = () => stop(namedError('AbortError', 'Command canceled.'));
    const timer = setTimeout(() => stop(namedError('CommandTimeoutError', `Command exceeded ${timeoutMs}ms.`)), timeoutMs);
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (failure) return;
      const remaining = maxOutputBytes - bytes;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining) {
        stop(namedError('OutputLimitError', `Command output exceeded ${maxOutputBytes} bytes.`));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('error', error => { failure ??= error; });
    // The leader's completion does not grant a registered script permission to
    // leave background children behind, including children that inherit pipes.
    child.once('exit', () => killGroup('SIGKILL'));
    child.once('close', (code, signal) => {
      settled = true;
      killGroup('SIGKILL');
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      const result = { code: code ?? (signal ? 128 : 1), stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), durationMs: performance.now() - started };
      if (failure) reject(Object.assign(failure, { stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs }));
      else resolve(result);
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    // Account for cancellation between the initial check and listener install.
    if (options.signal?.aborted) abort();
  });
}

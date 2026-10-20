import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { createWorkspace, getExecutionContext, runCommand, type Workspace } from 'lab-agent-core-vercel';

/**
 * captureEnvironment: record the software environment a task ran in, for reproducibility.
 * Runs `conda env export` and `python -m pip freeze --all` as argv (no shell). In a task the
 * files are written to <outputDirectory>/environment/ through Core's write policy, so they
 * become run artifacts with hashes; in chat the text is returned and nothing is saved.
 * Core already records Node, platform, the Python version and CONDA_DEFAULT_ENV in every run.
 */

export interface EnvToolOptions {
  /** Project root (config.root). */
  root: string;
  /** Environment for conda and Python; default process.env. Pass config.env. */
  env?: NodeJS.ProcessEnv;
  /** conda executable; default env.CONDA_EXE, then "conda" on PATH. */
  conda?: string;
  /** Python used for pip freeze; default "python3". Pass the same command as config.python. */
  python?: string;
  timeoutMs?: number;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const short = (text: string) => text.trim().split('\n').slice(-3).join(' ').slice(0, 300);

export function envTools(options: EnvToolOptions): ToolSet {
  let workspace: Promise<Workspace> | undefined;
  return {
    captureEnvironment: tool({
      description: 'Record the software environment for reproducibility: the conda environment (conda env export) and installed Python packages (pip freeze). In a task the files are saved under <outputDirectory>/environment/ and become run artifacts; in chat the text is returned.',
      inputSchema: z.object({
        condaEnv: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u).optional().describe('Conda environment name; default the active one.'),
      }),
      async execute({ condaEnv }, { abortSignal }) {
        const env = options.env ?? process.env;
        const run = (command: string, args: string[]) => runCommand(command, args, { cwd: options.root, env, signal: abortSignal, timeoutMs: options.timeoutMs ?? 60_000, maxOutputBytes: 4 * 1024 * 1024 });
        const captured: Array<{ name: string; content: string }> = [];
        const notes: string[] = [];

        let conda: { env: string } | undefined;
        const target = condaEnv ? ['-n', condaEnv] : env.CONDA_PREFIX ? ['-p', env.CONDA_PREFIX] : undefined;
        if (!target) {
          notes.push('No conda environment is active (CONDA_PREFIX is unset); pass condaEnv to export one by name.');
        } else {
          try {
            const result = await run(options.conda ?? env.CONDA_EXE ?? 'conda', ['env', 'export', ...target]);
            if (result.code === 0 && result.stdout.trim()) {
              captured.push({ name: 'conda-environment.yml', content: result.stdout });
              conda = { env: condaEnv ?? env.CONDA_DEFAULT_ENV ?? env.CONDA_PREFIX! };
            } else {
              notes.push(`conda env export failed (${result.code}): ${short(result.stderr || result.stdout)}`);
            }
          } catch (error) {
            abortSignal?.throwIfAborted();
            notes.push(`conda is unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        const python = options.python ?? 'python3';
        try {
          const version = await run(python, ['--version']);
          const freeze = await run(python, ['-m', 'pip', 'freeze', '--all']);
          if (freeze.code === 0) captured.push({ name: 'pip-freeze.txt', content: `# ${(version.stdout || version.stderr).trim()}\n${freeze.stdout}` });
          else notes.push(`pip freeze failed (${freeze.code}): ${short(freeze.stderr || freeze.stdout)}`);
        } catch (error) {
          abortSignal?.throwIfAborted();
          notes.push(`${python} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!captured.length) throw new Error(`Nothing was captured. ${notes.join(' ')}`);

        const context = getExecutionContext();
        if (!context?.outputDirectory) {
          return {
            saved: false, ...(conda ? { conda } : {}),
            files: captured.map(file => ({ name: file.name, sha256: sha256(file.content), bytes: Buffer.byteLength(file.content), content: file.content.slice(0, 20_000) })),
            notes: [...notes, 'Not in a task, so nothing was saved. Run it in a task to keep the files as run artifacts.'],
          };
        }
        workspace ??= createWorkspace(options.root);
        const files = await workspace;
        const output = relative(files.root, context.outputDirectory).split(sep).join('/');
        const saved = [];
        for (const file of captured) {
          const path = `${output}/environment/${file.name}`;
          await files.write(path, file.content);
          saved.push({ path, sha256: sha256(file.content), bytes: Buffer.byteLength(file.content) });
        }
        return { saved: true, ...(conda ? { conda } : {}), files: saved, notes };
      },
    }),
  };
}

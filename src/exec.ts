import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
  env?: Record<string, string>;
}

/** Command execution port. The pi extension can substitute pi.exec; tests and
 * the default path use node child_process. */
export type ExecPort = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const nodeExec: ExecPort = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        signal: opts.signal,
        timeout: opts.timeout ?? 10 * 60_000,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        maxBuffer: 32 * 1024 * 1024,
        shell: false,
      },
      (error, stdout, stderr) => {
        const rawCode: unknown = error ? (error as NodeJS.ErrnoException & { code?: unknown }).code ?? 1 : 0;
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          code: typeof rawCode === "number" ? rawCode : 1,
        });
      },
    );
  });

/** Run a shell command string (e.g. "./setup.sh" from benchmark.json manifests). */
export const shellExec =
  (exec: ExecPort): ((command: string, opts?: ExecOptions) => Promise<ExecResult>) =>
  (command, opts) =>
    exec("/bin/bash", ["-c", command], opts);

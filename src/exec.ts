import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True when node terminated the child because ExecOptions.timeout elapsed. */
  timedOut?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
  env?: Record<string, string>;
  /** Receives process output as it is produced, before the command exits. */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

/** Command execution port. The pi extension can substitute pi.exec; tests and
 * the default path use node child_process. */
export type ExecPort = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const nodeExec: ExecPort = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        signal: opts.signal,
        timeout: opts.timeout ?? 10 * 60_000,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
        shell: false,
      },
      (error, stdout, stderr) => {
        const processError = error as
          | (NodeJS.ErrnoException & { code?: unknown; killed?: boolean })
          | null;
        const rawCode: unknown = processError ? processError.code ?? 1 : 0;
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          code: typeof rawCode === "number" ? rawCode : 1,
          timedOut:
            processError?.killed === true &&
            opts.timeout !== undefined &&
            !(opts.signal?.aborted ?? false),
        });
      },
    );
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => opts.onOutput?.(chunk, "stdout"));
    child.stderr?.on("data", (chunk: string) => opts.onOutput?.(chunk, "stderr"));
  });

/** Run a shell command string (e.g. "./setup.sh" from benchmark.json manifests). */
export const shellExec =
  (exec: ExecPort): ((command: string, opts?: ExecOptions) => Promise<ExecResult>) =>
  (command, opts) =>
    exec("/bin/bash", ["-c", command], opts);

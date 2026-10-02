import { fork, type ChildProcess, type Serializable } from "node:child_process";

const SANDBOX_ENV = { NODE_ENV: "production" } as const;

interface SandboxExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SandboxOptions {
  script: string;
  args?: string[];
  heapMb?: number;
  serialization?: "json" | "advanced";
  exitMessage: (exit: SandboxExit) => string;
}

/** A Node child under the permission model that answers one message at a time and is killed when done. */
export class Sandbox {
  private constructor(
    private readonly child: ChildProcess,
    private readonly exitMessage: SandboxOptions["exitMessage"],
  ) {}

  static fork({ script, args = [], heapMb, serialization, exitMessage }: SandboxOptions): Sandbox {
    const child = fork(script, args, {
      execArgv: [
        "--permission",
        "--disallow-code-generation-from-strings",
        `--allow-fs-read=${script}`,
        ...(heapMb === undefined ? [] : [`--max-old-space-size=${heapMb}`]),
      ],
      env: SANDBOX_ENV,
      serialization,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    return new Sandbox(child, exitMessage);
  }

  request<T>(message: Serializable, timeoutMs: number, timeoutReason: string): Promise<T> {
    this.child.send(message);
    return this.nextMessage(timeoutMs, timeoutReason);
  }

  /** Rejects when the child exits, fails or stays silent past the timeout. */
  nextMessage<T>(timeoutMs: number, timeoutReason: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const settle = (outcome: () => void) => {
        clearTimeout(timer);
        this.child.off("message", onMessage);
        this.child.off("exit", onExit);
        this.child.off("error", onError);
        outcome();
      };
      const onMessage = (message: unknown) => settle(() => resolve(message as T));
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        settle(() => reject(new Error(this.exitMessage({ code, signal }))));
      const onError = (err: Error) => settle(() => reject(err));
      const timer = setTimeout(() => settle(() => reject(new Error(timeoutReason))), timeoutMs);
      this.child.on("message", onMessage);
      this.child.on("exit", onExit);
      this.child.on("error", onError);
    });
  }

  stop(): void {
    this.child.kill("SIGKILL");
  }
}

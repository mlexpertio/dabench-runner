import { fork, type ChildProcess, type Serializable } from "node:child_process";

const SANDBOX_ENV = { NODE_ENV: "production" } as const;
const V8_HEAP_EXHAUSTED_SIGNAL = "SIGABRT";

export interface SandboxOptions {
  script: string;
  label: string;
  args?: string[];
  heapMb?: number;
  serialization?: "json" | "advanced";
}

export class Sandbox {
  private constructor(
    private readonly child: ChildProcess,
    private readonly label: string,
  ) {}

  static fork({ script, label, args = [], heapMb, serialization }: SandboxOptions): Sandbox {
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
    return new Sandbox(child, label);
  }

  request<T>(message: Serializable, timeoutMs: number, timeoutReason: string): Promise<T> {
    this.child.send(message);
    return this.nextMessage(timeoutMs, timeoutReason);
  }

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
        settle(() => reject(new Error(this.exitMessage(code, signal))));
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

  private exitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    return signal === V8_HEAP_EXHAUSTED_SIGNAL
      ? `the ${this.label} ran out of memory`
      : `the ${this.label} exited (${code})`;
  }
}

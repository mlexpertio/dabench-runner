import { invokedCommand } from "./invocation";
import { PUBLIC_NOTES, runCli } from "./program";

runCli({ command: invokedCommand(process.env), notes: PUBLIC_NOTES });

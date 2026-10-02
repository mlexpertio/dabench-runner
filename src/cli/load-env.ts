import { existsSync } from "node:fs";

const ENV_FILES_BY_PRECEDENCE = [".env.local", ".env"];

export function loadEnv(): void {
  for (const file of ENV_FILES_BY_PRECEDENCE) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

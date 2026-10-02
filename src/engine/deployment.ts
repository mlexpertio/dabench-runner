import { Harness, isLocalHarness, knownHarness } from "./harness";
import { OPENAI_API_URL, OPENAI_BASE_URL_ENV } from "./providers";
import type { RunConfig } from "./runconfig";

export enum Deployment {
  Hosted = "hosted",
  Local = "local",
}

type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "[::1]", "::1"]);
const LOOPBACK_IPV4 = /^127\./;
const LOOPBACK_SUFFIX = ".localhost";
const LAN_SUFFIX = ".local";
const PRIVATE_IPV4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

export function runDeployment(config: RunConfig, env: Env): Deployment {
  const { harness, local } = config.openai;
  if (knownHarness(harness) === Harness.OpenRouter) return Deployment.Hosted;
  if (isLocalHarness(harness) || local) return Deployment.Local;
  return isLocalHost(apiUrl(config, env).hostname) ? Deployment.Local : Deployment.Hosted;
}

/** The host a hosted OpenAI-compatible run was sent to: the one fact about its server the bench can observe. */
export function hostedApiHost(config: RunConfig, env: Env): string {
  return apiUrl(config, env).hostname;
}

function apiUrl(config: RunConfig, env: Env): URL {
  return new URL(config.openai.baseUrl ?? env[OPENAI_BASE_URL_ENV] ?? OPENAI_API_URL);
}

/** Whether the host is this machine itself, not merely on its network. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || LOOPBACK_IPV4.test(host) || host.endsWith(LOOPBACK_SUFFIX);
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isLoopbackHost(host) || PRIVATE_IPV4.test(host) || host.endsWith(LAN_SUFFIX);
}

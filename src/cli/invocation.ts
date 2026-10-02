import packageJson from "../../package.json" with { type: "json" };

const NODE_RANGE_PREFIX = ">=";
const MINIMUM_NODE_VERSION = packageJson.engines.node.slice(NODE_RANGE_PREFIX.length);
const NPX_LIFECYCLE_EVENT = "npx";
const ENGINE_SCRIPT = "engine";

export const ENGINE_SCRIPT_COMMAND = `npm run ${ENGINE_SCRIPT} --`;

export function invokedCommand(env: NodeJS.ProcessEnv): string {
  switch (env.npm_lifecycle_event) {
    case NPX_LIFECYCLE_EVENT:
      return `npx ${packageJson.name}`;
    case ENGINE_SCRIPT:
      return ENGINE_SCRIPT_COMMAND;
    default:
      return packageJson.name;
  }
}

export function unsupportedNodeMessage(version: string): string | undefined {
  return isOlder(version, MINIMUM_NODE_VERSION)
    ? `${packageJson.name} needs Node.js ${MINIMUM_NODE_VERSION} or newer (this is ${version})`
    : undefined;
}

function isOlder(version: string, minimum: string): boolean {
  const actual = version.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  const differing = required.findIndex((part, i) => actual[i] !== part);
  return differing !== -1 && actual[differing] < required[differing];
}

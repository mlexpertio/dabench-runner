export enum ServiceTier {
  Default = "default",
  Flex = "flex",
  Priority = "priority",
  Fast = "fast",
  Ultrafast = "ultrafast",
}

export function parseServiceTier(value: unknown = ServiceTier.Default): ServiceTier {
  const tier = Object.values(ServiceTier).find((known) => known === value);
  if (!tier)
    throw new Error(`unknown service tier ${JSON.stringify(value)}. One of: ${Object.values(ServiceTier).join(", ")}`);
  return tier;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}

export function errorMessage(err: unknown): string {
  return isRecord(err) && typeof err.message === "string" ? err.message : String(err);
}

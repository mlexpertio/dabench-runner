import { canonicalize } from "../canonical";
import { isRecord } from "../guards";
import type { JsonSchemaSpec } from "../json-schema";
import type { Assertion } from "../schema";
import { assertion, previewJson } from "./verdict";

export function validateJsonSchema(value: unknown, spec: JsonSchemaSpec, path = "$"): Assertion[] {
  const isNullableValue = value === null && spec.nullable === true;
  const typeOk = isNullableValue || checkType(value, spec.type);
  const out = [
    assertion(
      `${path}: ${spec.type}${spec.nullable ? "|null" : ""}`,
      typeOk,
      `expected ${spec.type}, got ${jsType(value)}`,
    ),
  ];
  if (!typeOk) return out;

  if (spec.enum) out.push(enumAssertion(value, spec.enum, path));
  if (Object.hasOwn(spec, "const")) out.push(constAssertion(value, spec.const, path));
  if (isNullableValue) return out;

  switch (spec.type) {
    case "object":
      out.push(...validateObject(value as Record<string, unknown>, spec, path));
      break;
    case "array":
      out.push(...validateArray(value as unknown[], spec, path));
      break;
    case "string":
      out.push(...validateString(value as string, spec, path));
      break;
    case "number":
    case "integer":
      out.push(...validateNumber(value as number, spec, path));
  }
  return out;
}

function enumAssertion(value: unknown, allowed: unknown[], path: string): Assertion {
  const passed = allowed.some((entry) => canonicalize(entry) === canonicalize(value));
  return assertion(`${path}: enum`, passed, `value not among ${allowed.length} allowed`);
}

function constAssertion(value: unknown, expected: unknown, path: string): Assertion {
  const passed = canonicalize(value) === canonicalize(expected);
  return assertion(`${path}: const`, passed, `expected ${previewJson(expected)}, got ${previewJson(value)}`);
}

type BoundKeyword = {
  [K in keyof JsonSchemaSpec]-?: NonNullable<JsonSchemaSpec[K]> extends number ? K : never;
}[keyof JsonSchemaSpec];
type Holds = (actual: number, limit: number) => boolean;
type Bound = readonly [keyword: BoundKeyword, holds: Holds, relation: string];

const atLeast: Holds = (actual, limit) => actual >= limit;
const atMost: Holds = (actual, limit) => actual <= limit;
const above: Holds = (actual, limit) => actual > limit;
const below: Holds = (actual, limit) => actual < limit;

const MINIMUM = "minimum";
const MAXIMUM = "maximum";
const PROPERTY_BOUNDS: readonly Bound[] = [
  ["minProperties", atLeast, MINIMUM],
  ["maxProperties", atMost, MAXIMUM],
];
const ITEM_BOUNDS: readonly Bound[] = [
  ["minItems", atLeast, MINIMUM],
  ["maxItems", atMost, MAXIMUM],
];
const LENGTH_BOUNDS: readonly Bound[] = [
  ["minLength", atLeast, MINIMUM],
  ["maxLength", atMost, MAXIMUM],
];
const NUMBER_BOUNDS: readonly Bound[] = [
  ["minimum", atLeast, MINIMUM],
  ["maximum", atMost, MAXIMUM],
  ["exclusiveMinimum", above, "must be >"],
  ["exclusiveMaximum", below, "must be <"],
];

function bounds(path: string, actual: number, spec: JsonSchemaSpec, table: readonly Bound[]): Assertion[] {
  return table.flatMap(([keyword, holds, relation]) => {
    const limit = spec[keyword];
    if (limit === undefined) return [];
    return [assertion(`${path}: ${keyword}`, holds(actual, limit), `got ${actual}, ${relation} ${limit}`)];
  });
}

function validateObject(value: Record<string, unknown>, spec: JsonSchemaSpec, path: string): Assertion[] {
  const keys = Object.keys(value);
  const out = bounds(path, keys.length, spec, PROPERTY_BOUNDS);
  for (const key of spec.required ?? []) {
    out.push(assertion(`${path}.${key}: required`, Object.hasOwn(value, key), "missing required key"));
  }
  for (const [key, childSpec] of Object.entries(spec.properties ?? {})) {
    if (Object.hasOwn(value, key)) out.push(...validateJsonSchema(value[key], childSpec, `${path}.${key}`));
  }
  if (spec.additionalProperties === false) {
    const unexpected = keys.filter((key) => !Object.hasOwn(spec.properties ?? {}, key));
    out.push(
      assertion(
        `${path}: additionalProperties`,
        unexpected.length === 0,
        `unexpected key(s): ${unexpected.join(", ")}`,
      ),
    );
  }
  return out;
}

function validateArray(value: unknown[], spec: JsonSchemaSpec, path: string): Assertion[] {
  const out = bounds(path, value.length, spec, ITEM_BOUNDS);
  if (spec.uniqueItems) {
    const canonical = value.map(canonicalize);
    out.push(
      assertion(`${path}: uniqueItems`, new Set(canonical).size === canonical.length, "array contains duplicate items"),
    );
  }
  if (spec.items) {
    for (const [index, item] of value.entries()) {
      out.push(...validateJsonSchema(item, spec.items, `${path}[${index}]`));
    }
  }
  return out;
}

function validateString(value: string, spec: JsonSchemaSpec, path: string): Assertion[] {
  const out = bounds(path, [...value].length, spec, LENGTH_BOUNDS);
  if (spec.pattern !== undefined) {
    out.push(
      assertion(`${path}: pattern`, new RegExp(spec.pattern, "u").test(value), `does not match /${spec.pattern}/u`),
    );
  }
  if (spec.format !== undefined) {
    out.push(assertion(`${path}: format:${spec.format}`, checkFormat(value, spec.format), `invalid ${spec.format}`));
  }
  return out;
}

function validateNumber(value: number, spec: JsonSchemaSpec, path: string): Assertion[] {
  const out = bounds(path, value, spec, NUMBER_BOUNDS);
  if (spec.multipleOf !== undefined) {
    const quotient = value / spec.multipleOf;
    const passed = Math.abs(quotient - Math.round(quotient)) <= Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4;
    out.push(assertion(`${path}: multipleOf`, passed, `got ${value}, expected a multiple of ${spec.multipleOf}`));
  }
  return out;
}

function checkFormat(value: string, format: NonNullable<JsonSchemaSpec["format"]>): boolean {
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case "uri": {
      try {
        const url = new URL(value);
        return url.protocol.length > 1;
      } catch {
        return false;
      }
    }
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
      return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value));
  }
}

function checkType(value: unknown, type: JsonSchemaSpec["type"]): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function jsType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

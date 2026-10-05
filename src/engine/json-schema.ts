import { z } from "zod";
import { requireUnique } from "./schema";

const JSON_SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean"] as const;
const STRING_FORMATS = ["email", "uri", "uuid", "date", "date-time"] as const;

export interface JsonSchemaSpec {
  type: (typeof JSON_SCHEMA_TYPES)[number];
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchemaSpec>;
  additionalProperties?: boolean;
  minProperties?: number;
  maxProperties?: number;
  items?: JsonSchemaSpec;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: (typeof STRING_FORMATS)[number];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  enum?: unknown[];
  const?: unknown;
}

const FIELDS_BY_TYPE: Record<JsonSchemaSpec["type"], Array<keyof JsonSchemaSpec>> = {
  object: ["required", "properties", "additionalProperties", "minProperties", "maxProperties"],
  array: ["items", "minItems", "maxItems", "uniqueItems"],
  string: ["minLength", "maxLength", "pattern", "format"],
  number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  boolean: [],
};
const TYPE_SPECIFIC_FIELDS = new Set(Object.values(FIELDS_BY_TYPE).flat());

export const JsonSchemaSpecSchema: z.ZodType<JsonSchemaSpec> = z.lazy(() =>
  z
    .object({
      type: z.enum(JSON_SCHEMA_TYPES),
      nullable: z.boolean().optional(),
      required: z.array(z.string().min(1)).optional(),
      properties: z.record(z.string(), JsonSchemaSpecSchema).optional(),
      additionalProperties: z.boolean().optional(),
      minProperties: z.number().int().nonnegative().optional(),
      maxProperties: z.number().int().nonnegative().optional(),
      items: JsonSchemaSpecSchema.optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
      uniqueItems: z.boolean().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      pattern: z.string().optional(),
      format: z.enum(STRING_FORMATS).optional(),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      exclusiveMinimum: z.number().finite().optional(),
      exclusiveMaximum: z.number().finite().optional(),
      multipleOf: z.number().positive().finite().optional(),
      enum: z.array(z.unknown()).optional(),
      const: z.unknown().optional(),
    })
    .superRefine((s, ctx) => {
      for (const field of TYPE_SPECIFIC_FIELDS) {
        if (s[field] !== undefined && !FIELDS_BY_TYPE[s.type].includes(field)) {
          ctx.addIssue({ code: "custom", message: `${String(field)} is not valid for type ${s.type}`, path: [field] });
        }
      }
      if (s.minLength !== undefined && s.maxLength !== undefined && s.minLength > s.maxLength) {
        ctx.addIssue({ code: "custom", message: "minLength cannot exceed maxLength" });
      }
      if (s.minItems !== undefined && s.maxItems !== undefined && s.minItems > s.maxItems) {
        ctx.addIssue({ code: "custom", message: "minItems cannot exceed maxItems" });
      }
      if (s.minProperties !== undefined && s.maxProperties !== undefined && s.minProperties > s.maxProperties) {
        ctx.addIssue({ code: "custom", message: "minProperties cannot exceed maxProperties" });
      }
      if (s.minimum !== undefined && s.maximum !== undefined && s.minimum > s.maximum) {
        ctx.addIssue({ code: "custom", message: "minimum cannot exceed maximum" });
      }
      if (
        s.exclusiveMinimum !== undefined &&
        s.exclusiveMaximum !== undefined &&
        s.exclusiveMinimum >= s.exclusiveMaximum
      ) {
        ctx.addIssue({ code: "custom", message: "exclusiveMinimum must be below exclusiveMaximum" });
      }
      if (s.pattern !== undefined) {
        try {
          new RegExp(s.pattern, "u");
        } catch {
          ctx.addIssue({ code: "custom", message: "pattern must be a valid regular expression", path: ["pattern"] });
        }
      }
      const required = s.required ?? [];
      requireUnique(ctx, required, "required key", ["required"]);
      for (const key of required) {
        if (!s.properties || !Object.hasOwn(s.properties, key)) {
          ctx.addIssue({
            code: "custom",
            message: `required key ${JSON.stringify(key)} has no property schema`,
            path: ["required"],
          });
        }
      }
    }),
);

export function toStandardJsonSchema(spec: JsonSchemaSpec): Record<string, unknown> {
  const { nullable, properties, items, ...rest } = spec;
  const out: Record<string, unknown> = { ...rest };
  if (properties) {
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([key, sub]) => [key, toStandardJsonSchema(sub)]),
    );
  }
  if (items) out.items = toStandardJsonSchema(items);
  if (nullable) out.type = [spec.type, "null"];
  return out;
}

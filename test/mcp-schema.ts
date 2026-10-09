import captured from "./fixtures/feishu-mcp-tools.json" with { type: "json" };

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface CapturedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const FEISHU_MCP_TOOLS = captured as unknown as {
  capturedAt: string;
  source: string;
  capture: string;
  tools: CapturedTool[];
};

export function capturedTool(name: string): CapturedTool {
  const tool = FEISHU_MCP_TOOLS.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing captured tool ${name}`);
  return tool;
}

/** Unknown keys and missing required keys are rejected. Nested objects and element arrays are checked the same way. */
export function argumentError(schema: JsonSchema, args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be an object";
  const record = args as Record<string, unknown>;
  const props = schema.properties ?? {};
  for (const key of Object.keys(record)) {
    if (!(key in props)) return `unknown argument ${key}`;
  }
  for (const key of schema.required ?? []) {
    if (!(key in record)) return `missing argument ${key}`;
  }
  for (const [key, value] of Object.entries(record)) {
    const child = props[key];
    if (!child) continue;
    if (child.type === "object" && child.properties && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = argumentError(child, value);
      if (nested) return `${key}.${nested}`;
    }
    if (child.type === "array" && child.items?.properties && Array.isArray(value)) {
      for (const item of value) {
        const nested = argumentError(child.items, item);
        if (nested) return `${key}.${nested}`;
      }
    }
  }
  return null;
}

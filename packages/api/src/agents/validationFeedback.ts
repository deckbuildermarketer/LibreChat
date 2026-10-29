import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';

const MAX_FIELDS = 8;
const safeName = (name: string): string => name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);

/** Actionable, raw-free feedback for known programmatic execution failures. */
export function toolExecutionFeedback(error: unknown, toolName: string): string | undefined {
  if (
    toolName !== 'run_tools_with_bash' ||
    !(error instanceof Error) ||
    !error.message.startsWith('Bash programmatic execution failed:')
  )
    return undefined;
  if (
    error.message.includes('stdout length exceeded') ||
    error.message.includes('Execution output exceeded the size limit')
  ) {
    return 'Tool output exceeded its delivery limit. The batch may already have executed persistent actions. Inspect exact targets/operation keys before another write; retain saved IDs. Continue with paginated reads and bounded selected-field summaries instead of repeating the full output dump.';
  }
  if (
    error.message.includes('jq: error') &&
    error.message.includes('Cannot index string with string')
  ) {
    return 'The program expected an object but received a string or encoded tool content. Inspect the documented response shape and JSON type before selecting fields; decode only valid JSON text. Do not replay persistent actions to repair result parsing.';
  }
  return undefined;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

/** Bounded schema-owned paths and constraints; never parser text or input values. */
function constraintFeedback(schema: unknown, input: unknown): string[] {
  const issues: string[] = [];
  let visited = 0;
  const walk = (node: unknown, value: unknown, path: string, depth: number): void => {
    // This traversal budget bounds diagnostic work on untrusted tool input.
    if (!record(node) || depth > 8 || visited++ >= 256 || issues.length >= MAX_FIELDS) return;
    const report = (hint: string) => issues.push(`${path || 'input'} (${hint})`);
    if (typeof value === 'string') {
      if (typeof node.minLength === 'number' && value.length < node.minLength)
        report(`minimum ${node.minLength} characters`);
      if (typeof node.maxLength === 'number' && value.length > node.maxLength)
        report(`maximum ${node.maxLength} characters`);
    }
    if (typeof value === 'number') {
      if (node.type === 'integer' && !Number.isInteger(value)) report('expected integer');
      if (typeof node.minimum === 'number' && value < node.minimum)
        report(`minimum ${node.minimum}`);
      if (typeof node.exclusiveMinimum === 'number' && value <= node.exclusiveMinimum)
        report(`greater than ${node.exclusiveMinimum}`);
      if (typeof node.maximum === 'number' && value > node.maximum)
        report(`maximum ${node.maximum}`);
    }
    if (Array.isArray(node.enum) && !node.enum.includes(value)) report('use a declared choice');
    if (Array.isArray(value)) {
      if (typeof node.minItems === 'number' && value.length < node.minItems)
        report(`minimum ${node.minItems} items`);
      if (typeof node.maxItems === 'number' && value.length > node.maxItems)
        report(`maximum ${node.maxItems} items`);
      for (let i = 0; i < value.length && visited < 256 && issues.length < MAX_FIELDS; i++)
        walk(node.items, value[i], `${path}[]`, depth + 1);
    }
    if (!record(value) || !record(node.properties)) return;
    for (const [field, child] of Object.entries(node.properties)) {
      if (visited >= 256 || issues.length >= MAX_FIELDS) break;
      const next = path ? `${path}.${safeName(field)}` : safeName(field);
      const property = Object.getOwnPropertyDescriptor(value, field);
      if (!property && Array.isArray(node.required) && node.required.includes(field) && depth > 0)
        report(`missing ${next}`);
      if (property && 'value' in property) walk(child, property.value, next, depth + 1);
    }
  };
  walk(schema, input, '', 0);
  return issues.slice(0, MAX_FIELDS);
}

/** Read only schema-owned field names; parser messages/output can contain input secrets. */
export function toolValidationFeedback(
  error: unknown,
  toolName: string,
  schema?: StructuredToolInterface['schema'],
  input?: unknown,
  canCheckBackground = false,
): string | undefined {
  if (
    !(error instanceof Error) ||
    error.constructor.name !== 'ToolInputParsingException' ||
    !error.message.startsWith('Received tool input did not match expected schema')
  ) {
    return undefined;
  }
  const fields: string[] = [];
  if (schema != null && typeof schema === 'object' && 'required' in schema) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const field of required.slice(0, MAX_FIELDS)) {
        if (
          typeof field === 'string' &&
          (input == null ||
            typeof input !== 'object' ||
            !Object.prototype.hasOwnProperty.call(input, field))
        ) {
          fields.push(safeName(field));
        }
      }
    }
  }
  const missing = fields.length ? ` Missing required fields: ${fields.join(', ')}.` : '';
  const invalid: string[] = [];
  if (
    schema != null &&
    typeof schema === 'object' &&
    'properties' in schema &&
    schema.properties != null &&
    typeof schema.properties === 'object' &&
    input != null &&
    typeof input === 'object'
  ) {
    for (const [field, property] of Object.entries(schema.properties).slice(0, MAX_FIELDS)) {
      if (
        !Object.prototype.hasOwnProperty.call(input, field) ||
        property == null ||
        typeof property !== 'object' ||
        !('type' in property)
      )
        continue;
      const type = property.type;
      const value = Object.getOwnPropertyDescriptor(input, field)?.value;
      if ((type === 'string' || type === 'boolean' || type === 'number') && typeof value !== type) {
        invalid.push(`${safeName(field)} (expected ${type})`);
      }
    }
  }
  const invalidTypes = invalid.length ? ` Invalid field types: ${invalid.join(', ')}.` : '';
  const constraints = constraintFeedback(schema, input);
  const constraintHints = constraints.length
    ? ` Constraint violations: ${constraints.join(', ')}.`
    : '';
  const polling =
    canCheckBackground &&
    input != null &&
    typeof input === 'object' &&
    Object.prototype.hasOwnProperty.call(input, 'background_task_id')
      ? ' To inspect an existing background task, call check_background_task with background_task_id.'
      : '';
  return `Tool "${safeName(toolName)}" input failed schema validation.${missing}${invalidTypes}${constraintHints} Use this tool's declared arguments.${polling}`;
}

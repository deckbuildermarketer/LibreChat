import { tool } from '@librechat/agents/langchain/tools';
import { toolExecutionFeedback, toolValidationFeedback } from './validationFeedback';

describe('toolExecutionFeedback', () => {
  it('explains output-limit recovery without leaking captured output', () => {
    const feedback = toolExecutionFeedback(
      new Error(
        'Bash programmatic execution failed: Execution output exceeded the size limit. private-output [sandbox] stdout length exceeded',
      ),
      'run_tools_with_bash',
    );
    expect(feedback).toContain('may already have executed persistent actions');
    expect(feedback).toContain('paginated reads');
    expect(feedback).not.toContain('private-output');
  });
  it('explains response shape errors without echoing tool output or repeating writes', () => {
    const feedback = toolExecutionFeedback(
      new Error(
        'Bash programmatic execution failed: jq: error: Cannot index string with string "private-field" private-output',
      ),
      'run_tools_with_bash',
    );
    expect(feedback).toContain('JSON type');
    expect(feedback).toContain('Do not replay persistent actions');
    expect(feedback).not.toContain('private-');
  });
  it('leaves other tool failures and schemas with their existing owner', () => {
    expect(
      toolExecutionFeedback(
        new Error('Bash programmatic execution failed: stdout length exceeded'),
        'other_tool',
      ),
    ).toBeUndefined();
    expect(
      toolExecutionFeedback(
        new Error('Other exception with private-output'),
        'run_tools_with_bash',
      ),
    ).toBeUndefined();
  });
});

describe('toolValidationFeedback', () => {
  it('explains nested WordPress source limits without echoing source or parser messages', async () => {
    const execute = jest.fn(async () => 'executed');
    const mapping = tool(execute, {
      name: 'wp_validate_content_mapping',
      description: 'Validates a plan',
      schema: {
        type: 'object',
        properties: {
          plan: {
            type: 'object',
            properties: {
              source_units: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { role: { type: 'string', maxLength: 12 } },
                  required: ['role'],
                },
              },
            },
            required: ['source_units'],
          },
        },
        required: ['plan'],
      },
    });
    const input = { plan: { source_units: [{ role: 'private-source-content-never-echo' }] } };
    const error = await mapping.invoke(input).catch((failure: Error) => failure);
    const feedback = toolValidationFeedback(error, mapping.name, mapping.schema, input);
    expect(feedback).toContain('plan.source_units[].role (maximum 12 characters)');
    expect(feedback).not.toContain('private-source');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports numeric bounds and missing nested fields using schema-owned names only', async () => {
    const execute = jest.fn(async () => 'executed');
    const mapping = tool(execute, {
      name: 'mapping',
      description: 'Validates a plan',
      schema: {
        type: 'object',
        properties: {
          plan: {
            type: 'object',
            properties: { post_id: { type: 'integer', minimum: 1 }, title: { type: 'string' } },
            required: ['post_id', 'title'],
          },
        },
        required: ['plan'],
      },
    });
    const input = { plan: { post_id: -12345, secret: 'never-echo' } };
    const error = await mapping.invoke(input).catch((failure: Error) => failure);
    const feedback = toolValidationFeedback(error, mapping.name, mapping.schema, input);
    expect(feedback).toContain('plan.post_id (minimum 1)');
    expect(feedback).toContain('missing plan.title');
    expect(feedback).not.toMatch(/12345|never-echo|secret/);
  });
  it('explains a misrouted poll without invoking Bash or disclosing values', async () => {
    const execute = jest.fn(async () => 'executed');
    const bash = tool(execute, {
      name: 'bash_tool',
      description: 'Runs commands',
      schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    });
    const input = { background_task_id: 'private-task-id', intent: 'private-intent' };
    const error = await bash.invoke(input).catch((failure: Error) => failure);
    const feedback = toolValidationFeedback(error, bash.name, bash.schema, input, true);
    expect(execute).not.toHaveBeenCalled();
    expect(feedback).toContain('Missing required fields: command');
    expect(feedback).toContain('call check_background_task');
    expect(feedback).not.toContain('private-');
    expect(toolValidationFeedback(error, bash.name, bash.schema, input)).not.toContain(
      'check_background_task',
    );
  });

  it('does not rewrite execution failures that happen to use the parser message', () => {
    expect(
      toolValidationFeedback(
        new Error('Received tool input did not match expected schema'),
        'bash_tool',
      ),
    ).toBeUndefined();
  });

  it('reports primitive type mismatches using schema metadata only', async () => {
    const execute = jest.fn(async () => 'executed');
    const bash = tool(execute, {
      name: 'bash_tool',
      description: 'Runs commands',
      schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    });
    const input = { command: { secret: 'never-echo' } };
    const error = await bash.invoke(input).catch((failure: Error) => failure);
    const feedback = toolValidationFeedback(error, bash.name, bash.schema, input);
    expect(feedback).toContain('command (expected string)');
    expect(feedback).not.toContain('never-echo');
    expect(execute).not.toHaveBeenCalled();
  });
});

import { compactMCPResult } from '../dbmResultCompaction';

describe('DBM MCP result compaction', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original, DBM_MCP_RESULT_COMPACTION: 'true', DBM_MCP_RESULT_MAX_CHARS: '1000' };
  });

  afterAll(() => {
    process.env = original;
  });

  it('compacts Google Docs structural JSON into useful plain text', () => {
    const repeated = 'Useful homeowner copy. '.repeat(80);
    const payload = JSON.stringify({
      title: 'Morrison City Page',
      revisionId: 'noisy-revision',
      body: {
        content: [
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_1' },
              elements: [{ textRun: { content: 'Deck Builder in Morrison\n' } }],
            },
          },
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
              elements: [{ textRun: { content: repeated } }],
            },
          },
        ],
      },
    });

    const [content] = compactMCPResult([payload, undefined], {
      serverName: 'google-docs',
      toolName: 'read_doc',
    });

    expect(content).toContain('Title: Morrison City Page');
    expect(content).toContain('HEADING_1: Deck Builder in Morrison');
    expect(content).toContain('Useful homeowner copy.');
    expect(content).not.toContain('noisy-revision');
    expect(content.length).toBeLessThan(payload.length);
  });

  it('never compacts write tools', () => {
    const payload = 'x'.repeat(5000);
    const result = compactMCPResult([payload, undefined], {
      serverName: 'google-docs',
      toolName: 'update_doc',
    });
    expect(result[0]).toBe(payload);
  });

  it('clips oversized read-only non-JSON content while preserving a tail', () => {
    const payload = `START-${'x'.repeat(5000)}-END`;
    const [content] = compactMCPResult([payload, undefined], {
      serverName: 'external-reader',
      toolName: 'read_url',
    });
    expect(content).toContain('START-');
    expect(content).toContain('-END');
    expect(content).toContain('DBM_CONTEXT_COMPACTION');
    expect(content.length).toBeLessThan(payload.length);
  });
});

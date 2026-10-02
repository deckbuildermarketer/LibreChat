import { compactMCPResult } from '../dbmResultCompaction';

describe('DBM MCP result compaction', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = {
      ...original,
      DBM_MCP_RESULT_COMPACTION: 'true',
      DBM_MCP_RESULT_MAX_CHARS: '1800',
    };
  });

  afterAll(() => {
    process.env = original;
  });

  it('compacts Google Docs JSON while preserving text, indexes, headings, and links', () => {
    const repeated = 'Useful homeowner copy. '.repeat(80);
    const payload = JSON.stringify({
      title: 'Morrison City Page',
      revisionId: 'noisy-revision',
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 28,
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_1' },
              elements: [
                {
                  startIndex: 1,
                  endIndex: 28,
                  textRun: { content: 'Deck Builder in Morrison\n' },
                },
              ],
            },
          },
          {
            startIndex: 28,
            endIndex: 1800,
            paragraph: {
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
              elements: [
                {
                  startIndex: 28,
                  endIndex: 52,
                  textRun: {
                    content: 'Composite deck systems ',
                    textStyle: { link: { url: 'https://example.com/composite-decks' } },
                  },
                },
                { startIndex: 52, endIndex: 1800, textRun: { content: repeated } },
              ],
            },
          },
        ],
      },
    });

    const [content] = compactMCPResult([payload, undefined], {
      serverName: 'google-docs',
      toolName: 'read_doc',
      toolArguments: { document_id: 'abc' },
    });

    expect(content).toContain('Title: Morrison City Page');
    expect(content).toContain('HEADING_1: Deck Builder in Morrison');
    expect(content).toContain('[1:28] HEADING_1');
    expect(content).toContain('https://example.com/composite-decks');
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

  it('honors an explicit raw/full/structure read request', () => {
    const payload = 'x'.repeat(5000);
    const result = compactMCPResult([payload, undefined], {
      serverName: 'google-docs',
      toolName: 'read_doc',
      toolArguments: { mode: 'structure' },
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

'use strict';

const {
  EXECUTIVE_ID,
  buildBlueprint,
  buildMcpAllToken,
  parseList,
} = require('./blueprint');

const BASE_ENV = {
  DBM_EXECUTIVE_PROVIDER: 'openAI',
  DBM_EXECUTIVE_MODEL: 'base-model',
  DBM_EXECUTIVE_REASONING_PROVIDER: 'openAI',
  DBM_EXECUTIVE_REASONING_MODEL: 'reasoning-model',
  DBM_EXECUTIVE_FAST_PROVIDER: 'glm',
  DBM_EXECUTIVE_FAST_MODEL: 'fast-model',
};

describe('DBM Executive Advisor blueprint', () => {
  test('builds one executive and nine unique shallow specialists', () => {
    const blueprint = buildBlueprint(BASE_ENV);
    expect(blueprint.executive.id).toBe(EXECUTIVE_ID);
    expect(blueprint.specialists).toHaveLength(9);
    expect(blueprint.allAgents).toHaveLength(10);
    expect(new Set(blueprint.allAgents.map((agent) => agent.id)).size).toBe(10);
    expect(blueprint.executive.subagents).toEqual({
      enabled: true,
      allowSelf: false,
      agent_ids: blueprint.specialists.map((agent) => agent.id),
    });
    for (const specialist of blueprint.specialists) {
      expect(specialist.subagents).toBeUndefined();
      expect(specialist.edges).toEqual([]);
    }
  });

  test('routes reasoning and fast roles to the configured model tiers', () => {
    const blueprint = buildBlueprint(BASE_ENV);
    const byKey = Object.fromEntries(blueprint.specialists.map((agent) => [agent.key, agent]));
    expect(byKey.cro.model).toBe('reasoning-model');
    expect(byKey.cfo.model).toBe('reasoning-model');
    expect(byKey.gc.model).toBe('reasoning-model');
    expect(byKey.cmo.model).toBe('fast-model');
    expect(byKey.coo.model).toBe('fast-model');
    expect(blueprint.executive.model).toBe('reasoning-model');
  });

  test('falls back to the base provider and model when optional tiers are not configured', () => {
    const blueprint = buildBlueprint({
      DBM_EXECUTIVE_PROVIDER: 'custom',
      DBM_EXECUTIVE_MODEL: 'glm-model',
    });
    expect(blueprint.allAgents.every((agent) => agent.provider === 'custom')).toBe(true);
    expect(blueprint.allAgents.every((agent) => agent.model === 'glm-model')).toBe(true);
  });

  test('fails closed when no executable model is configured', () => {
    expect(() => buildBlueprint({})).toThrow(
      'DBM_EXECUTIVE_PROVIDER and DBM_EXECUTIVE_MODEL are required',
    );
  });

  test('attaches explicit tools and MCP runtime wildcards without duplicates', () => {
    const blueprint = buildBlueprint(
      {
        ...BASE_ENV,
        DBM_EXECUTIVE_TOOLS: 'memory,web_search,memory',
        DBM_EXECUTIVE_MCP_SERVERS: 'workspace,analytics',
        DBM_EXECUTIVE_CRO_TOOLS: 'sales_search',
        DBM_EXECUTIVE_CRO_MCP_SERVERS: 'crm,workspace',
      },
      { mcpDelimiter: '_mcp_' },
    );
    const cro = blueprint.specialists.find((agent) => agent.key === 'cro');
    expect(cro.tools).toEqual(
      expect.arrayContaining([
        'memory',
        'web_search',
        'sales_search',
        'mcp_all_mcp_workspace',
        'mcp_all_mcp_analytics',
        'mcp_all_mcp_crm',
      ]),
    );
    expect(cro.tools.filter((tool) => tool === 'mcp_all_mcp_workspace')).toHaveLength(1);
    expect(cro.mcpServerNames).toEqual(['workspace', 'analytics', 'crm']);
  });

  test('keeps skill access fail-closed when no skill allowlist is configured', () => {
    const blueprint = buildBlueprint(BASE_ENV);
    expect(blueprint.allAgents.every((agent) => agent.skills_enabled === false)).toBe(true);
    expect(blueprint.allAgents.every((agent) => agent.skills.length === 0)).toBe(true);
  });

  test('encodes April daily support, sales growth, evidence, and consequential-action safety', () => {
    const prompt = buildBlueprint(BASE_ENV).executive.instructions;
    expect(prompt).toMatch(/April's AI CEO partner/i);
    expect(prompt).toMatch(/profitable revenue/i);
    expect(prompt).toMatch(/generate more clients|client acquisition/i);
    expect(prompt).toMatch(/Never fabricate DBM's current/i);
    expect(prompt).toMatch(/explicit approval immediately before/i);
    expect(prompt).toMatch(/CRO by default/i);
  });

  test('CRO prompt diagnoses the revenue system rather than blindly increasing volume', () => {
    const cro = buildBlueprint(BASE_ENV).specialists.find((agent) => agent.key === 'cro');
    expect(cro.instructions).toMatch(/locate the biggest leak/i);
    expect(cro.instructions).toMatch(/Expected new revenue/i);
    expect(cro.instructions).toMatch(/delivery capacity/i);
  });

  test('list parsing and MCP wildcard format remain deterministic', () => {
    expect(parseList('a, b, a,,c')).toEqual(['a', 'b', 'c']);
    expect(buildMcpAllToken('google-workspace')).toBe('mcp_all_mcp_google-workspace');
  });
});

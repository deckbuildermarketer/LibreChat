import { AgentCapabilities, EModelEndpoint } from 'librechat-data-provider';
import type { InitializedAgent, InitializeAgentParams } from './initialize';
import { needsDBMV1DirectSubagentTrigger } from './dbmV1Subagents';

function makeParams({
  initial = true,
  enabled = true,
}: {
  initial?: boolean;
  enabled?: boolean;
} = {}): InitializeAgentParams {
  return {
    runtime: {
      requestBody: {},
      turnStartedAt: Date.now(),
      appConfig: {
        endpoints: {
          [EModelEndpoint.agents]: {
            capabilities: enabled ? [AgentCapabilities.subagents] : [],
          },
        },
      },
    },
    agent: { id: 'root' },
    allowedProviders: new Set(['openai']),
    isInitialAgent: initial,
  } as unknown as InitializeAgentParams;
}

function makeConfig({
  agentIds = ['child'],
  graphs = [],
}: {
  agentIds?: string[];
  graphs?: Array<Record<string, unknown>>;
} = {}): InitializedAgent {
  return {
    id: 'root',
    subagents: {
      enabled: true,
      agent_ids: agentIds,
      graphs,
    },
  } as unknown as InitializedAgent;
}

describe('DBM /v1 direct-subagent compatibility trigger', () => {
  it('activates for an initial /v1 agent that only has direct agent_ids', () => {
    expect(needsDBMV1DirectSubagentTrigger(makeParams(), makeConfig())).toBe(true);
  });

  it('does not activate when the admin subagents capability is disabled', () => {
    expect(needsDBMV1DirectSubagentTrigger(makeParams({ enabled: false }), makeConfig())).toBe(
      false,
    );
  });

  it('does not activate for non-initial agent initialization', () => {
    expect(needsDBMV1DirectSubagentTrigger(makeParams({ initial: false }), makeConfig())).toBe(
      false,
    );
  });

  it('does not activate when a real saved subagent graph already enters upstream discovery', () => {
    const graph = {
      type: 'research_team',
      name: 'Research team',
      description: 'Existing upstream graph',
      agent_ids: ['child'],
      edges: [],
      entry_agent_id: 'child',
      result_agent_id: 'child',
    };
    expect(needsDBMV1DirectSubagentTrigger(makeParams(), makeConfig({ graphs: [graph] }))).toBe(
      false,
    );
  });

  it('does not activate when no direct subagents are configured', () => {
    expect(needsDBMV1DirectSubagentTrigger(makeParams(), makeConfig({ agentIds: [] }))).toBe(false);
  });
});

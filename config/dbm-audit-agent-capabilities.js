const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const connect = require('./connect');
const { Agent } = require('~/db/models');

const TARGETS = {
  scout: 'agent_d-Q_-2dKqhlE1T-zJXuS7',
  marketing: 'agent_Om6097sLPWDShJxbv6T81',
  content: 'agent_HzCrIyRmdU8-zsTzIGGNM',
  website: 'agent_M3Iw3bDzDLcoVuWsl9ABU',
  delivery: 'agent_BQUZvpQzOBWna39mbf_ML',
  bi: 'agent_DvwPJLC98JUU8G5FXITQh',
};

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map(String))];
}

function summarizeToolOptions(toolOptions) {
  const entries = Object.entries(toolOptions || {});
  const configured = {};
  const counts = {
    entries: entries.length,
    defer_loading: 0,
    code_execution: 0,
    run_in_background: 0,
    describe_intent: 0,
  };

  for (const [name, value] of entries) {
    if (!value || typeof value !== 'object') continue;

    const option = {};
    if (value.defer_loading === true) {
      counts.defer_loading += 1;
      option.defer_loading = true;
    }
    if (Array.isArray(value.allowed_callers)) {
      option.allowed_callers = unique(value.allowed_callers);
      if (option.allowed_callers.includes('code_execution')) {
        counts.code_execution += 1;
      }
    }
    if (value.run_in_background === true) {
      counts.run_in_background += 1;
      option.run_in_background = true;
    }
    if (value.describe_intent === true) {
      counts.describe_intent += 1;
      option.describe_intent = true;
    }
    if (Object.keys(option).length > 0) {
      configured[name] = option;
    }
  }

  return { counts, configured };
}

async function main() {
  await connect();

  const allAgents = await Agent.find({})
    .select('id name subagents agent_ids stateful_code_sessions')
    .lean();

  const targetDocs = await Agent.find({ id: { $in: Object.values(TARGETS) } })
    .select(
      'id name tools tool_options subagents agent_ids stateful_code_sessions skills skills_enabled mcpServerNames updatedAt',
    )
    .lean();

  const maxSubagents = allAgents.reduce((max, agent) => {
    const count = Math.max(
      Array.isArray(agent?.subagents?.agent_ids) ? agent.subagents.agent_ids.length : 0,
      Array.isArray(agent?.agent_ids) ? agent.agent_ids.length : 0,
    );
    return Math.max(max, count);
  }, 0);

  const agentsAtMax = allAgents
    .filter((agent) => {
      const count = Math.max(
        Array.isArray(agent?.subagents?.agent_ids) ? agent.subagents.agent_ids.length : 0,
        Array.isArray(agent?.agent_ids) ? agent.agent_ids.length : 0,
      );
      return count === maxSubagents && count > 0;
    })
    .map((agent) => ({ id: agent.id, name: agent.name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const statefulEnabled = allAgents
    .filter((agent) => agent.stateful_code_sessions === true)
    .map((agent) => ({ id: agent.id, name: agent.name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const byId = new Map(targetDocs.map((agent) => [agent.id, agent]));
  const targets = {};

  for (const [role, id] of Object.entries(TARGETS)) {
    const agent = byId.get(id);
    if (!agent) {
      targets[role] = { id, missing: true };
      continue;
    }

    const tools = unique(agent.tools);
    const options = summarizeToolOptions(agent.tool_options);
    targets[role] = {
      id,
      name: agent.name,
      toolCount: tools.length,
      mcpToolCount: tools.filter((tool) => tool.includes('_mcp_') || tool.startsWith('sys__server__')).length,
      skillCount: Array.isArray(agent.skills) ? agent.skills.length : 0,
      skillsEnabled: agent.skills_enabled === true,
      subagentCount: Math.max(
        Array.isArray(agent?.subagents?.agent_ids) ? agent.subagents.agent_ids.length : 0,
        Array.isArray(agent?.agent_ids) ? agent.agent_ids.length : 0,
      ),
      statefulCodeSessions: agent.stateful_code_sessions === true,
      mcpServerNames: unique(agent.mcpServerNames).sort(),
      tools: tools.sort(),
      toolOptionCounts: options.counts,
      configuredToolOptions: options.configured,
      updatedAt: agent.updatedAt,
    };
  }

  console.log(
    '[DBM_AGENT_CAPABILITY_AUDIT]' +
      JSON.stringify({
        ok: true,
        totalAgents: allAgents.length,
        maxSubagents,
        agentsAtMax,
        statefulEnabledCount: statefulEnabled.length,
        statefulEnabled,
        targets,
      }),
  );

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[DBM_AGENT_CAPABILITY_AUDIT_ERROR]', error?.stack || error);
    process.exit(1);
  });

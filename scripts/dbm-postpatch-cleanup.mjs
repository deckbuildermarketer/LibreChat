import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(content, before, after, label) {
  const first = content.indexOf(before);
  if (first === -1) {
    throw new Error(`Cleanup anchor not found: ${label}`);
  }
  if (content.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Cleanup anchor is not unique: ${label}`);
  }
  return content.slice(0, first) + after + content.slice(first + before.length);
}

{
  const path = 'packages/api/src/agents/dbmMemoryRun.ts';
  let content = readFileSync(path, 'utf8');
  const obsolete = `function collectReachableAgents(agents: CreateRunOptions['agents']): ReachableAgent[] {\n  const result: ReachableAgent[] = [];\n  const visited = new Set<string>();\n  const pending = [...(agents as ReachableAgent[])];\n  for (let index = 0; index < pending.length; index++) {\n    const agent = pending[index];\n    if (!agent?.id || visited.has(agent.id)) {\n      continue;\n    }\n    visited.add(agent.id);\n    result.push(agent);\n    for (const child of agent.subagentAgentConfigs ?? []) {\n      pending.push(child);\n    }\n  }\n  return result;\n}\n\n`;
  content = replaceOnce(content, obsolete, '', 'obsolete eager reachable-agent collector');
  writeFileSync(path, content);
}

for (const path of [
  'api/server/controllers/agents/openai.js',
  'api/server/controllers/agents/responses.js',
]) {
  let content = readFileSync(path, 'utf8');
  content = replaceOnce(
    content,
    `    if (\n      primaryConfig.edges?.length ||\n      primaryHasGraphSubagents ||\n      primaryHasLegacySubagents\n    ) {`,
    `    if (primaryConfig.edges?.length || primaryHasGraphSubagents || primaryHasLegacySubagents) {`,
    `${path}: prettier-compatible legacy discovery gate`,
  );
  writeFileSync(path, content);
}

// Upstream's graph-budget regression used fixed fixture sizes chosen for the default
// 50-node ceiling. DBM intentionally raises that ceiling to 300, so keep the test's
// semantics invariant by deriving a first batch and a one-node-overflow second batch
// from MAX_SUBAGENT_GRAPH_NODES instead of hard-coding 32 + 20.
{
  const path = 'packages/api/src/agents/discovery.spec.ts';
  let content = readFileSync(path, 'utf8');
  content = replaceOnce(
    content,
    `    const firstMemberIds = Array.from({ length: 32 }, (_, index) => \`missing_first_\${index}\`);\n    const overflowMemberIds = Array.from({ length: 20 }, (_, index) => \`missing_overflow_\${index}\`);`,
    `    const firstMemberCount = Math.ceil(MAX_SUBAGENT_GRAPH_NODES / 2);\n    const overflowMemberCount = MAX_SUBAGENT_GRAPH_NODES - firstMemberCount + 1;\n    const firstMemberIds = Array.from(\n      { length: firstMemberCount },\n      (_, index) => \`missing_first_\${index}\`,\n    );\n    const overflowMemberIds = Array.from(\n      { length: overflowMemberCount },\n      (_, index) => \`missing_overflow_\${index}\`,\n    );`,
    'graph budget regression fixture scales with configured limit',
  );
  writeFileSync(path, content);
}

console.log('DBM integration cleanup applied successfully.');

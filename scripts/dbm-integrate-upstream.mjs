import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function read(path) {
  return readFileSync(path, 'utf8');
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function replaceOnce(content, before, after, label) {
  const first = content.indexOf(before);
  if (first === -1) {
    throw new Error(`Patch anchor not found: ${label}`);
  }
  if (content.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return content.slice(0, first) + after + content.slice(first + before.length);
}

function copyFromProduction(path) {
  const content = execFileSync('git', ['show', `origin/secondary:${path}`], { encoding: 'utf8' });
  write(path, content);
}

for (const path of [
  'packages/api/src/memory/dbmGateway.ts',
  'packages/api/src/memory/dbmGateway.spec.ts',
  'packages/api/src/agents/dbmMemoryRun.ts',
  'packages/api/src/agents/dbmMemoryRun.spec.ts',
]) {
  copyFromProduction(path);
}

// External-memory extraction is gated by the agents that actually produced model output.
// Index every DBM alias here so newly-lazy native LibreChat subagents remain eligible for
// post-run extraction without eagerly resolving their graph before the run.
{
  const path = 'packages/api/src/agents/dbmMemoryRun.ts';
  let content = read(path);
  const before = `  const reachableAgents = collectReachableAgents(options.agents);\n  const aliases = await getDBMMemoryAliases();\n  const aliasByAgentId = new Map(aliases.map((alias) => [alias.librechatAgentId, alias]));\n\n  // Build an in-memory lookup for POST-RUN extraction. This performs zero Mem0\n  // searches and lets extraction target only agents that actually ran.\n  for (const agent of reachableAgents) {\n    const alias = aliasByAgentId.get(agent.id);\n    if (alias) {\n      aliasesByAgentId.set(agent.id, alias);\n    }\n  }\n`;
  const after = `  const aliases = await getDBMMemoryAliases();\n\n  // Index aliases, not eagerly reachable configs. Modern LibreChat resolves explicit\n  // subagents lazily, so a child may not exist in the run graph until it is selected.\n  // Extraction remains strictly bounded by activeAgentIds, which records only agents\n  // that actually produced model output during this run.\n  for (const alias of aliases) {\n    aliasesByAgentId.set(alias.librechatAgentId, alias);\n  }\n`;
  content = replaceOnce(content, before, after, 'DBM lazy-subagent alias indexing');
  write(path, content);
}

// Preserve DBM's intentionally larger nested-agent envelope while retaining upstream's
// new configurable per-parent maxSubagents support.
{
  const path = 'packages/data-provider/src/config.ts';
  let content = read(path);
  content = replaceOnce(
    content,
    `export const MAX_SUBAGENT_DEPTH = 5;\n\n/** Maximum unique explicit subagent targets that may be loaded at runtime. */\nexport const MAX_SUBAGENT_GRAPH_NODES = 50;\n\n/** Maximum expanded SubagentConfig entries embedded into one run request. */\nexport const MAX_SUBAGENT_RUN_CONFIGS = 100;`,
    `export const MAX_SUBAGENT_DEPTH = 10;\n\n/** DBM: larger bounded graph for Scout -> Director -> Program -> Client routing. */\nexport const MAX_SUBAGENT_GRAPH_NODES = 300;\n\n/** DBM: keep the expanded run envelope aligned with the graph-node budget. */\nexport const MAX_SUBAGENT_RUN_CONFIGS = 300;`,
    'DBM subagent graph limits',
  );
  write(path, content);
}

// Preserve the external DBM Mem0 wrapper while keeping every new upstream agent export.
{
  const path = 'packages/api/src/agents/index.ts';
  let content = read(path);
  content = replaceOnce(
    content,
    `export * from './run';\n`,
    `export * from './run';\n/** DBM: external Mem0-compatible memory wrapper around canonical createRun. */\nexport { createRun } from './dbmMemoryRun';\n`,
    'DBM createRun export override',
  );
  write(path, content);
}

// Railway must never publish an image whose frontend compilation silently failed.
{
  const path = 'Dockerfile';
  let content = read(path);
  content = replaceOnce(
    content,
    `RUN \\\n    # React client build with configurable memory\n    NODE_OPTIONS=\"--max-old-space-size=\${NODE_MAX_OLD_SPACE_SIZE}\" npm run frontend; \\\n    npm prune --production; \\\n    npm cache clean --force`,
    `RUN set -e; \\\n    # React client build with configurable memory. Fail the image build immediately\n    # if compilation does not produce the expected client entrypoint.\n    NODE_OPTIONS=\"--max-old-space-size=\${NODE_MAX_OLD_SPACE_SIZE}\" npm run frontend; \\\n    test -f /app/client/dist/index.html; \\\n    npm prune --production; \\\n    npm cache clean --force`,
    'Railway frontend fail-fast',
  );
  write(path, content);
}

// Current upstream supersedes the old DBM subagent loader for in-app/JWT runs. Keep only
// the still-missing OpenAI-compatible compatibility path for legacy subagents.agent_ids,
// implemented on top of today's shared discovery + ACL + initialization primitives.
{
  const path = 'packages/api/src/agents/discovery.ts';
  let content = read(path);
  content = replaceOnce(
    content,
    `  EModelEndpoint,\n  MAX_SUBAGENT_GRAPH_NODES,\n`,
    `  EModelEndpoint,\n  MAX_SUBAGENT_DEPTH,\n  MAX_SUBAGENT_GRAPH_NODES,\n`,
    'legacy subagent depth import',
  );

  const marker = `/**\n * Discovers and initializes all agents reachable from \`primaryConfig.edges\``;
  const helper = `/**\n * DBM compatibility for persisted legacy \`subagents.agent_ids\` on OpenAI-compatible\n * endpoints. Native LibreChat now owns the in-app lazy-subagent path and saved graph\n * teams; this adapter only closes the remaining /v1 parity gap without restoring the\n * retired DBM loader. Every referenced child passes the same resourceType + VIEW ACL,\n * model validation, skill scoping, tool initialization, and capability wiring as the\n * current shared discovery path.\n */\nexport async function resolveLegacySubagentAgentIds(\n  params: ResolveSubagentGraphsParams,\n  deps: DiscoverConnectedAgentsDeps,\n): Promise<Record<string, Record<string, string>> | undefined> {\n  const configById = new Map<string, InitializedAgent>();\n  for (const rootConfig of params.rootConfigs) {\n    configById.set(rootConfig.id, rootConfig);\n    for (const graph of rootConfig.subagentGraphConfigs ?? []) {\n      for (const memberConfig of graph.memberConfigs) {\n        configById.set(memberConfig.id, memberConfig);\n      }\n    }\n  }\n\n  const failedAgentIds = new Set<string>();\n  const loadedLegacyIds = new Set<string>();\n  const maxResolvedDepthById = new Map<string, number>();\n  let userMCPAuthMap: Record<string, Record<string, string>> | undefined;\n\n  const mergeAuth = (config: InitializedAgent): void => {\n    if (config.userMCPAuthMap) {\n      userMCPAuthMap = { ...userMCPAuthMap, ...config.userMCPAuthMap };\n    }\n  };\n  for (const config of configById.values()) {\n    mergeAuth(config);\n  }\n\n  const resolveConfig = async (\n    config: InitializedAgent & { subagentAgentConfigs?: InitializedAgent[] },\n    depth: number,\n    ancestors: ReadonlySet<string>,\n  ): Promise<void> => {\n    const previousDepth = maxResolvedDepthById.get(config.id);\n    if (previousDepth != null && previousDepth >= depth) {\n      return;\n    }\n    maxResolvedDepthById.set(config.id, depth);\n\n    if (config.subagents?.enabled !== true) {\n      config.subagentAgentConfigs ??= [];\n      return;\n    }\n\n    const childIds = Array.from(\n      new Set(\n        Array.isArray(config.subagents.agent_ids)\n          ? config.subagents.agent_ids.filter(\n              (id): id is string => typeof id === 'string' && id.length > 0 && id !== config.id,\n            )\n          : [],\n      ),\n    );\n\n    if (childIds.length > 0 && depth >= MAX_SUBAGENT_DEPTH) {\n      logger.warn('[resolveLegacySubagentAgentIds] Subagent depth limit exceeded', {\n        agentId: config.id,\n        depth,\n        maxSubagentDepth: MAX_SUBAGENT_DEPTH,\n        childCount: childIds.length,\n      });\n      throw new Error(\n        \`Subagent graph exceeds the maximum depth of \${MAX_SUBAGENT_DEPTH} at agent \${config.id}.\`,\n      );\n    }\n\n    const resolvedChildren: InitializedAgent[] = [];\n    for (const childId of childIds) {\n      if (ancestors.has(childId) || failedAgentIds.has(childId)) {\n        continue;\n      }\n\n      let childConfig = configById.get(childId);\n      if (!childConfig) {\n        if (loadedLegacyIds.size >= MAX_SUBAGENT_GRAPH_NODES) {\n          logger.warn('[resolveLegacySubagentAgentIds] Subagent graph node limit exceeded', {\n            agentId: config.id,\n            childId,\n            loadedSubagentCount: loadedLegacyIds.size,\n            maxSubagentGraphNodes: MAX_SUBAGENT_GRAPH_NODES,\n          });\n          throw new Error(\n            \`Subagent graph exceeds the maximum of \${MAX_SUBAGENT_GRAPH_NODES} unique agents.\`,\n          );\n        }\n\n        const resolved = await initializeReferencedAgent(childId, params, deps);\n        if (!resolved) {\n          failedAgentIds.add(childId);\n          continue;\n        }\n        childConfig = resolved.config;\n        loadedLegacyIds.add(childId);\n        configById.set(childId, childConfig);\n        mergeAuth(childConfig);\n      }\n      resolvedChildren.push(childConfig);\n    }\n\n    config.subagentAgentConfigs = resolvedChildren;\n    const nextAncestors = new Set(ancestors);\n    nextAncestors.add(config.id);\n    for (const childConfig of resolvedChildren) {\n      await resolveConfig(childConfig, depth + 1, nextAncestors);\n    }\n  };\n\n  for (const rootConfig of params.rootConfigs) {\n    await resolveConfig(rootConfig, 0, new Set<string>());\n  }\n  return userMCPAuthMap;\n}\n\n`;
  if (content.includes('export async function resolveLegacySubagentAgentIds(')) {
    throw new Error('Legacy /v1 compatibility helper already exists unexpectedly');
  }
  const markerIndex = content.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('Patch anchor not found: discovery helper insertion');
  }
  content = content.slice(0, markerIndex) + helper + content.slice(markerIndex);
  write(path, content);
}

function patchRemoteController(path) {
  let content = read(path);
  content = replaceOnce(
    content,
    `  resolveSubagentGraphs,\n`,
    `  resolveSubagentGraphs,\n  resolveLegacySubagentAgentIds,\n`,
    `${path}: legacy resolver import`,
  );
  content = replaceOnce(
    content,
    `    const primaryHasGraphSubagents =\n      subagentsCapabilityEnabled &&\n      primaryConfig.subagents?.enabled === true &&\n      (primaryConfig.subagents.graphs?.length ?? 0) > 0;\n    if (primaryConfig.edges?.length || primaryHasGraphSubagents) {`,
    `    const primaryHasGraphSubagents =\n      subagentsCapabilityEnabled &&\n      primaryConfig.subagents?.enabled === true &&\n      (primaryConfig.subagents.graphs?.length ?? 0) > 0;\n    const primaryHasLegacySubagents =\n      subagentsCapabilityEnabled &&\n      primaryConfig.subagents?.enabled === true &&\n      Array.isArray(primaryConfig.subagents.agent_ids) &&\n      primaryConfig.subagents.agent_ids.length > 0;\n    if (\n      primaryConfig.edges?.length ||\n      primaryHasGraphSubagents ||\n      primaryHasLegacySubagents\n    ) {`,
    `${path}: legacy subagent discovery gate`,
  );
  const graphBlock = `      if (subagentsCapabilityEnabled) {\n        discoveredMCPAuthMap = await resolveSubagentGraphs(\n          {\n            ...discoveryParams,\n            rootConfigs: [primaryConfig, ...handoffAgentConfigs.values()],\n          },\n          discoveryDeps,\n        );\n      }`;
  const combinedBlock = `${graphBlock}\n      if (subagentsCapabilityEnabled) {\n        const legacyMCPAuthMap = await resolveLegacySubagentAgentIds(\n          {\n            ...discoveryParams,\n            rootConfigs: [primaryConfig, ...handoffAgentConfigs.values()],\n          },\n          discoveryDeps,\n        );\n        discoveredMCPAuthMap = {\n          ...(discoveredMCPAuthMap ?? {}),\n          ...(legacyMCPAuthMap ?? {}),\n        };\n      }`;
  content = replaceOnce(content, graphBlock, combinedBlock, `${path}: legacy resolver call`);
  write(path, content);
}

patchRemoteController('api/server/controllers/agents/openai.js');
patchRemoteController('api/server/controllers/agents/responses.js');

// Document DBM's opt-in external memory contract without changing LibreChat defaults.
{
  const path = '.env.example';
  let content = read(path);
  if (!content.includes('DBM_MEMORY_ENABLED=')) {
    const anchor = `# CONFIG_PATH=\"/alternative/path/to/librechat.yaml\"\n`;
    const block = `\n#=====================#\n# DBM External Memory #\n#=====================#\n# Fail-open external memory gateway used by the DBM agent hierarchy. All flags\n# default to safe/off behavior unless explicitly enabled in the deployment.\n# DBM_MEMORY_ENABLED=false\n# DBM_MEMORY_RECALL_ENABLED=true\n# DBM_MEMORY_INJECTION_ENABLED=false\n# DBM_MEMORY_WRITE_ENABLED=false\n# DBM_MEMORY_GATEWAY_URL=\n# DBM_MEMORY_GATEWAY_API_KEY=\n# DBM_MEMORY_TIMEOUT_MS=2500\n# DBM_MEMORY_ALIAS_CACHE_TTL_MS=300000\n# DBM_MEMORY_RECALL_LIMIT=8\n# DBM_MEMORY_MAX_INJECTED_CHARS=6000\n# DBM_MEMORY_ALIASES_PATH=/v1/admin/aliases\n# DBM_MEMORY_RECALL_PATH=/v1/recall\n# DBM_MEMORY_EXTRACT_PATH=/v1/extract\n`;
    content = replaceOnce(content, anchor, anchor + block, 'DBM env documentation');
  }
  write(path, content);
}

// Keep a dedicated future regression gate so upstream syncs cannot silently drop DBM memory.
write(
  '.github/workflows/dbm-memory-pr.yml',
  `name: DBM Memory PR\n\non:\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: dbm-memory-pr-\${{ github.event.pull_request.number || github.ref }}\n  cancel-in-progress: true\n\njobs:\n  validate-memory:\n    runs-on: ubuntu-latest\n    timeout-minutes: 35\n    steps:\n      - uses: actions/checkout@v5\n      - name: Use Node.js 24.16.0\n        uses: actions/setup-node@v5\n        with:\n          node-version: 24.16.0\n          cache: npm\n      - name: Install dependencies\n        run: npm ci --no-audit\n      - name: Build DBM dependency graph\n        run: npm run build:data-provider && npm run build:data-schemas && npm run build:api\n      - name: Run DBM memory regressions\n        run: >-\n          npm --workspace=packages/api run test:ci -- --runInBand --runTestsByPath\n          src/memory/dbmGateway.spec.ts\n          src/agents/dbmMemoryRun.spec.ts\n      - name: Run shared subagent discovery regressions\n        run: >-\n          npm --workspace=packages/api run test:ci -- --runInBand --runTestsByPath\n          src/agents/discovery.spec.ts\n`,
);

console.log('DBM upstream integration patch applied successfully.');

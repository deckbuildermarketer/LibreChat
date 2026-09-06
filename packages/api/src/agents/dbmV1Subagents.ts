import { logger } from '@librechat/data-schemas';
import {
  AgentCapabilities,
  EModelEndpoint,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_GRAPH_NODES,
  PermissionBits,
  ResourceType,
} from 'librechat-data-provider';
import type { Agent, AgentSubagentGraph } from 'librechat-data-provider';
import type {
  InitializedAgent,
  InitializeAgentDbMethods,
  InitializeAgentParams,
} from './initialize';
import type {
  DiscoverConnectedAgentsDeps,
  GraphSubagentHostConfig,
  ResolveSubagentGraphsParams,
} from './discovery';
import { initializeAgent as initializeBaseAgent } from './initialize';
import { resolveSubagentGraphs as resolveBaseSubagentGraphs } from './discovery';
import { validateAgentModel as validateBaseAgentModel } from './validation';
import { isFatalAgentInitializationError } from './errors';

/**
 * LibreChat's current /v1 controllers enter their subagent discovery block for
 * handoff edges and saved graph teams, but not for a root that only declares
 * `subagents.agent_ids`. DBM relies on that direct nested topology for its
 * Director -> Program -> Client routing.
 *
 * This module keeps the compatibility fix at the package boundary instead of
 * patching the large OpenAI-compatible controllers. The trigger below exists
 * only long enough to make those controllers enter their already-secured
 * discovery block; it is stripped before any graph is resolved or executed.
 */
const DBM_DIRECT_SUBAGENT_TRIGGER_TYPE = '__dbm_direct_subagent_ids_trigger__';

type DBMSubagentHost = GraphSubagentHostConfig & {
  subagentAgentConfigs?: DBMSubagentHost[];
};

function directSubagentIds(config: { subagents?: { enabled?: boolean; agent_ids?: unknown[] } }): string[] {
  if (config.subagents?.enabled !== true || !Array.isArray(config.subagents.agent_ids)) {
    return [];
  }
  return Array.from(
    new Set(
      config.subagents.agent_ids.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  );
}

function hasRealSubagentGraph(config: {
  subagents?: { graphs?: Array<{ type?: string }> };
}): boolean {
  return (config.subagents?.graphs ?? []).some(
    (graph) => graph?.type !== DBM_DIRECT_SUBAGENT_TRIGGER_TYPE,
  );
}

function hasSubagentCapability(params: InitializeAgentParams): boolean {
  const appConfig = params.runtime?.appConfig ?? params.req?.config;
  const capabilities = appConfig?.endpoints?.[EModelEndpoint.agents]?.capabilities ?? [];
  return new Set(capabilities).has(AgentCapabilities.subagents);
}

/** Pure seam used by regression tests and future upstream-sync audits. */
export function needsDBMV1DirectSubagentTrigger(
  params: InitializeAgentParams,
  config: InitializedAgent,
): boolean {
  return (
    params.runtime != null &&
    params.isInitialAgent === true &&
    hasSubagentCapability(params) &&
    directSubagentIds(config).length > 0 &&
    !hasRealSubagentGraph(config)
  );
}

function addDirectSubagentTrigger(config: InitializedAgent): void {
  const ids = directSubagentIds(config);
  const firstId = ids[0];
  if (!firstId || !config.subagents) {
    return;
  }
  const trigger = {
    type: DBM_DIRECT_SUBAGENT_TRIGGER_TYPE,
    name: 'DBM direct subagent compatibility trigger',
    description: 'Internal trigger removed before graph resolution.',
    agent_ids: [firstId],
    edges: [],
    entry_agent_id: firstId,
    result_agent_id: firstId,
  } as AgentSubagentGraph;
  config.subagents = {
    ...config.subagents,
    graphs: [...(config.subagents.graphs ?? []), trigger],
  };
}

function stripDirectSubagentTriggers(configs: GraphSubagentHostConfig[]): void {
  for (const config of configs) {
    if (!config.subagents?.graphs?.length) {
      continue;
    }
    config.subagents = {
      ...config.subagents,
      graphs: config.subagents.graphs.filter(
        (graph) => graph.type !== DBM_DIRECT_SUBAGENT_TRIGGER_TYPE,
      ),
    };
  }
}

/**
 * Package-level initializeAgent override. For normal LibreChat/JWT execution it
 * is byte-for-byte behavior-equivalent to upstream. Only the initial transport-
 * free /v1 root gets the temporary discovery trigger, and only when the admin
 * subagents capability is enabled.
 */
export async function initializeAgent(
  params: InitializeAgentParams,
  db?: InitializeAgentDbMethods,
): Promise<InitializedAgent> {
  const config = await initializeBaseAgent(params, db);
  if (needsDBMV1DirectSubagentTrigger(params, config)) {
    addDirectSubagentTrigger(config);
  }
  return config;
}

function collectKnownConfigs(roots: DBMSubagentHost[]): DBMSubagentHost[] {
  const collected = new Map<string, DBMSubagentHost>();
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    const config = queue[index];
    if (!config?.id || collected.has(config.id)) {
      continue;
    }
    collected.set(config.id, config);
    for (const child of config.subagentAgentConfigs ?? []) {
      queue.push(child);
    }
    for (const graph of config.subagentGraphConfigs ?? []) {
      for (const member of graph.memberConfigs ?? []) {
        queue.push(member as DBMSubagentHost);
      }
    }
  }
  return Array.from(collected.values());
}

function mergeMCPAuthMaps(
  current: Record<string, Record<string, string>> | undefined,
  configs: DBMSubagentHost[],
): Record<string, Record<string, string>> | undefined {
  let merged = current ? { ...current } : undefined;
  for (const config of configs) {
    if (!config.userMCPAuthMap) {
      continue;
    }
    merged = { ...merged, ...config.userMCPAuthMap };
  }
  return merged;
}

/**
 * Resolves direct `agent_ids` with the same REMOTE_AGENT + VIEW boundary that
 * upstream discovery uses for /v1 handoffs/graph members. This intentionally
 * initializes through the latest upstream initializer so skills, MCP auth,
 * code environments, memory tools, background tools, content filters and all
 * other current runtime behavior stay inherited rather than forked.
 */
async function resolveDirectSubagentTrees(
  params: ResolveSubagentGraphsParams,
  deps: DiscoverConnectedAgentsDeps,
  roots: DBMSubagentHost[],
): Promise<void> {
  const known = new Map<string, DBMSubagentHost>();
  for (const config of collectKnownConfigs(roots)) {
    known.set(config.id, config);
  }
  const rawAgents = new Map<string, Agent | null>();
  const skipped = new Set<string>();
  const deepestResolvedDepth = new Map<string, number>();
  const primary = roots[0];
  if (!primary) {
    return;
  }

  const markSkipped = (agentId: string): void => {
    if (!skipped.has(agentId)) {
      skipped.add(agentId);
      deps.onAgentSkipped?.(agentId);
    }
  };

  const getRawAgent = async (agentId: string): Promise<Agent | null> => {
    if (rawAgents.has(agentId)) {
      return rawAgents.get(agentId) ?? null;
    }
    const agent = await deps.getAgent({ id: agentId });
    rawAgents.set(agentId, agent);
    return agent;
  };

  const loadAgent = async (agentId: string): Promise<DBMSubagentHost | null> => {
    const existing = known.get(agentId);
    if (existing) {
      return existing;
    }
    if (skipped.has(agentId)) {
      return null;
    }

    try {
      const agent = await getRawAgent(agentId);
      if (!agent) {
        logger.warn(`[dbm-v1-subagents] Agent ${agentId} not found, skipping`);
        markSkipped(agentId);
        return null;
      }

      const userId = params.req.user?.id;
      if (!userId) {
        markSkipped(agentId);
        return null;
      }
      const hasAccess = await deps.checkPermission({
        userId,
        role: params.req.user?.role,
        resourceType: params.resourceType ?? ResourceType.AGENT,
        resourceId: agent._id,
        requiredPermission: PermissionBits.VIEW,
      });
      if (!hasAccess) {
        logger.warn(`[dbm-v1-subagents] Caller lacks VIEW access to agent ${agentId}, skipping`);
        markSkipped(agentId);
        return null;
      }

      const validateAgentModel = deps.validateAgentModel ?? validateBaseAgentModel;
      const validation = await validateAgentModel({
        req: params.req,
        res: params.res,
        agent,
        modelsConfig: params.modelsConfig,
        logViolation: deps.logViolation,
      });
      if (!validation.isValid) {
        throw new Error(validation.error?.message);
      }

      const scopedSkillIds = params.computeAccessibleSkillIds?.(agent);
      const initializeReferencedAgent = deps.initializeAgent ?? initializeBaseAgent;
      const config = (await initializeReferencedAgent(
        {
          req: params.req,
          res: params.res,
          agent,
          loadTools: params.loadTools,
          requestFiles: params.requestFiles,
          conversationId: params.conversationId,
          parentMessageId: params.parentMessageId,
          requestBody: params.requestBody,
          endpointOption: {
            ...(params.endpointOption ?? {}),
            endpoint: EModelEndpoint.agents,
          },
          allowedProviders: params.allowedProviders,
          accessibleSkillIds: scopedSkillIds,
          skillAuthoringAvailable: params.computeSkillAuthoringAvailable?.(agent, scopedSkillIds),
          skillStates: params.skillStates,
          defaultActiveOnShare: params.defaultActiveOnShare,
          codeEnvAvailable: params.codeEnvAvailable,
          backgroundToolsAvailable: params.backgroundToolsAvailable,
          toolIntentsAvailable: params.toolIntentsAvailable,
          statefulSessionsAvailable: params.statefulSessionsAvailable,
          allowedStatefulCodeEnvironments: params.allowedStatefulCodeEnvironments,
          memoryAvailable: params.memoryAvailable,
        },
        deps.db,
      )) as DBMSubagentHost;
      known.set(agentId, config);
      deps.onAgentInitialized?.(agentId, agent, config);
      return config;
    } catch (error) {
      if (isFatalAgentInitializationError(error)) {
        throw error;
      }
      logger.error(`[dbm-v1-subagents] Error processing agent ${agentId}:`, error);
      markSkipped(agentId);
      return null;
    }
  };

  const pending = roots.map((config) => ({ config, depth: 0 }));
  for (let index = 0; index < pending.length; index++) {
    const { config, depth } = pending[index];
    if (!config?.id) {
      continue;
    }
    const previousDepth = deepestResolvedDepth.get(config.id);
    if (previousDepth != null && previousDepth >= depth) {
      continue;
    }
    deepestResolvedDepth.set(config.id, depth);

    const ids = directSubagentIds(config).filter((id) => id !== config.id);
    if (ids.length > 0 && depth >= MAX_SUBAGENT_DEPTH) {
      logger.warn('[dbm-v1-subagents] Subagent graph depth limit exceeded', {
        agentId: config.id,
        primaryAgentId: primary.id,
        depth,
        maxSubagentDepth: MAX_SUBAGENT_DEPTH,
        childCount: ids.length,
      });
      throw new Error(
        `Subagent graph exceeds the maximum depth of ${MAX_SUBAGENT_DEPTH} at agent ${config.id}.`,
      );
    }

    const resolved: DBMSubagentHost[] = [];
    for (const agentId of ids) {
      if (skipped.has(agentId)) {
        continue;
      }
      if (!known.has(agentId) && known.size >= MAX_SUBAGENT_GRAPH_NODES) {
        throw new Error(
          `Subagent graph exceeds the maximum of ${MAX_SUBAGENT_GRAPH_NODES} agents at ${agentId}.`,
        );
      }
      const child = await loadAgent(agentId);
      if (!child) {
        continue;
      }
      resolved.push(child);
      const childDepth = depth + 1;
      const previousChildDepth = deepestResolvedDepth.get(child.id);
      if (previousChildDepth == null || previousChildDepth < childDepth) {
        pending.push({ config: child, depth: childDepth });
      }
    }
    config.subagentAgentConfigs = resolved;
  }
}

/**
 * Package-level resolveSubagentGraphs override for the OpenAI-compatible
 * controllers. Real LibreChat graph teams are always resolved by upstream.
 * DBM then fills direct `agent_ids`, and the loop repeats only when mixed
 * topologies expose additional graph-team members or direct descendants.
 */
export async function resolveSubagentGraphs(
  params: ResolveSubagentGraphsParams,
  deps: DiscoverConnectedAgentsDeps,
): Promise<Record<string, Record<string, string>> | undefined> {
  const roots = params.rootConfigs as DBMSubagentHost[];
  stripDirectSubagentTriggers(roots);

  let authMap: Record<string, Record<string, string>> | undefined;
  let previousKnownCount = -1;
  for (let iteration = 0; iteration <= MAX_SUBAGENT_DEPTH; iteration++) {
    const before = collectKnownConfigs(roots);
    if (before.length === previousKnownCount) {
      break;
    }
    previousKnownCount = before.length;

    const graphAuth = await resolveBaseSubagentGraphs(
      { ...params, rootConfigs: before },
      deps,
    );
    authMap = graphAuth ? { ...authMap, ...graphAuth } : authMap;

    const afterGraphs = collectKnownConfigs(roots);
    await resolveDirectSubagentTrees(params, deps, afterGraphs);
    const afterDirect = collectKnownConfigs(roots);
    authMap = mergeMCPAuthMaps(authMap, afterDirect);

    if (afterDirect.length === before.length) {
      /** One final graph pass is needed for a just-loaded direct child that owns
       * a saved team; otherwise a stable direct count could hide new graph members. */
      const finalGraphAuth = await resolveBaseSubagentGraphs(
        { ...params, rootConfigs: afterDirect },
        deps,
      );
      authMap = finalGraphAuth ? { ...authMap, ...finalGraphAuth } : authMap;
      authMap = mergeMCPAuthMaps(authMap, collectKnownConfigs(roots));
      break;
    }
  }

  return authMap;
}

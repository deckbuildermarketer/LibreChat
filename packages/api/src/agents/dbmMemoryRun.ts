import { logger } from '@librechat/data-schemas';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import { createRun as createBaseRun } from './run';
import {
  extractDBMMemory,
  formatDBMMemoryForInjection,
  getDBMMemoryAliases,
  isDBMMemoryEnabled,
  isDBMMemoryInjectionEnabled,
  isDBMMemoryRecallEnabled,
  isDBMMemoryWriteEnabled,
  recallDBMMemory,
  type DBMMemoryAlias,
  type DBMMemoryContext,
} from '~/memory/dbmGateway';

type CreateRunOptions = Parameters<typeof createBaseRun>[0];
type ReachableAgent = CreateRunOptions['agents'][number] & {
  additional_instructions?: string;
  subagentAgentConfigs?: ReachableAgent[];
};

type ModelEndHandler = {
  handle: (...args: unknown[]) => unknown;
};

type RunSnapshot = {
  getRunMessages?: () => BaseMessage[] | undefined;
};

const DEFAULT_MAX_AGENTS_PER_RUN = 8;

function maxAgentsPerRun(): number {
  const parsed = Number(process.env.DBM_MEMORY_MAX_AGENTS_PER_RUN);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_AGENTS_PER_RUN;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part == null || typeof part !== 'object') {
        return '';
      }
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') {
        return record.text;
      }
      if (typeof record.content === 'string') {
        return record.content;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function messageType(message: BaseMessage): string {
  try {
    return message._getType?.() ?? '';
  } catch {
    return '';
  }
}

export function getDBMMemoryQuery(messages?: BaseMessage[]): string {
  if (!messages?.length) {
    return '';
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (messageType(message) !== 'human') {
      continue;
    }
    const text = contentToText(message.content);
    if (text) {
      return text;
    }
  }
  return '';
}

export function getDBMMemoryAssistantOutput(messages?: BaseMessage[]): string {
  if (!messages?.length) {
    return '';
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (messageType(message) !== 'ai') {
      continue;
    }
    const text = contentToText(message.content);
    if (text) {
      return text;
    }
  }
  return '';
}

function collectReachableAgents(agents: CreateRunOptions['agents']): ReachableAgent[] {
  const result: ReachableAgent[] = [];
  const visited = new Set<string>();
  const pending = [...(agents as ReachableAgent[])];
  for (let index = 0; index < pending.length; index++) {
    const agent = pending[index];
    if (!agent?.id || visited.has(agent.id)) {
      continue;
    }
    visited.add(agent.id);
    result.push(agent);
    for (const child of agent.subagentAgentConfigs ?? []) {
      pending.push(child);
    }
  }
  return result;
}

/**
 * Selects aliases in reachable-agent order, not gateway-return order.
 * This guarantees the root agent is considered first and then follows the
 * actual graph traversal when DBM_MEMORY_MAX_AGENTS_PER_RUN applies a cap.
 */
export function selectDBMMemoryAliases(
  agents: Array<{ id?: string }>,
  aliases: DBMMemoryAlias[],
  limit = DEFAULT_MAX_AGENTS_PER_RUN,
): DBMMemoryAlias[] {
  const aliasByAgentId = new Map(aliases.map((alias) => [alias.librechatAgentId, alias]));
  const selected: DBMMemoryAlias[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    if (!agent.id || seen.has(agent.id)) {
      continue;
    }
    const alias = aliasByAgentId.get(agent.id);
    if (!alias) {
      continue;
    }
    seen.add(agent.id);
    selected.push(alias);
    if (selected.length >= Math.max(1, limit)) {
      break;
    }
  }
  return selected;
}

function buildMemoryContext(options: CreateRunOptions): DBMMemoryContext {
  return {
    userId: options.user?.id?.toString(),
    tenantId: options.tenantId ?? options.user?.tenantId?.toString(),
    conversationId: options.requestBody?.conversationId,
    runId: options.runId,
  };
}

function appendMemoryInstruction(agent: ReachableAgent, memory: string): () => void {
  const previous = agent.additional_instructions;
  agent.additional_instructions = [previous ?? '', memory].filter(Boolean).join('\n\n').trim();
  return () => {
    agent.additional_instructions = previous;
  };
}

function recordProducingAgent(activeAgentIds: Set<string>, args: unknown[]): void {
  const metadata =
    args[2] != null && typeof args[2] === 'object'
      ? (args[2] as Record<string, unknown>)
      : undefined;
  const graph =
    args[3] != null && typeof args[3] === 'object'
      ? (args[3] as { getAgentContext?: (metadata?: unknown) => unknown })
      : undefined;
  try {
    const context = graph?.getAgentContext?.(metadata) as { agentId?: unknown } | undefined;
    if (typeof context?.agentId === 'string') {
      activeAgentIds.add(context.agentId);
      return;
    }
  } catch {
    // Fail open: telemetry must never affect a model run.
  }
  const metadataAgentId = metadata?.agentId ?? metadata?.agent_id;
  if (typeof metadataAgentId === 'string') {
    activeAgentIds.add(metadataAgentId);
  }
}

function wrapModelEndHandler(
  customHandlers: CreateRunOptions['customHandlers'],
  activeAgentIds: Set<string>,
): CreateRunOptions['customHandlers'] {
  if (customHandlers == null || typeof customHandlers !== 'object') {
    return customHandlers;
  }
  const handlers = customHandlers as Record<string, unknown>;
  const current = handlers.on_chat_model_end;
  if (current == null || typeof current !== 'object') {
    return customHandlers;
  }
  const handler = current as ModelEndHandler;
  if (typeof handler.handle !== 'function') {
    return customHandlers;
  }
  const originalHandle = handler.handle.bind(handler);
  const wrapped: ModelEndHandler = {
    ...handler,
    handle: (...args: unknown[]) => {
      recordProducingAgent(activeAgentIds, args);
      return originalHandle(...args);
    },
  };
  return {
    ...handlers,
    on_chat_model_end: wrapped,
  } as CreateRunOptions['customHandlers'];
}

async function prepareMemory(options: CreateRunOptions): Promise<{
  aliasesByAgentId: Map<string, DBMMemoryAlias>;
  restore: Array<() => void>;
}> {
  const aliasesByAgentId = new Map<string, DBMMemoryAlias>();
  const restore: Array<() => void> = [];
  if (!isDBMMemoryRecallEnabled() && !isDBMMemoryWriteEnabled()) {
    return { aliasesByAgentId, restore };
  }

  const reachableAgents = collectReachableAgents(options.agents);
  const reachableById = new Map(reachableAgents.map((agent) => [agent.id, agent]));
  const aliases = await getDBMMemoryAliases();
  const selected = selectDBMMemoryAliases(reachableAgents, aliases, maxAgentsPerRun());
  for (const alias of selected) {
    aliasesByAgentId.set(alias.librechatAgentId, alias);
  }

  if (!isDBMMemoryRecallEnabled()) {
    return { aliasesByAgentId, restore };
  }

  const query = getDBMMemoryQuery(options.messages);
  if (!query) {
    return { aliasesByAgentId, restore };
  }

  const context = buildMemoryContext(options);
  await Promise.all(
    selected.map(async (alias) => {
      const result = await recallDBMMemory({ alias, query, context });
      if (!result) {
        return;
      }
      logger.debug('[DBM Memory] recall completed', {
        agentId: alias.librechatAgentId,
        memoryKey: alias.memoryKey,
        memories: result.memories.length,
        shadow: !isDBMMemoryInjectionEnabled(),
      });
      if (!isDBMMemoryInjectionEnabled()) {
        return;
      }
      const instruction = formatDBMMemoryForInjection(result);
      const agent = reachableById.get(alias.librechatAgentId);
      if (instruction && agent) {
        restore.push(appendMemoryInstruction(agent, instruction));
      }
    }),
  );

  return { aliasesByAgentId, restore };
}

function scheduleExtraction({
  run,
  options,
  query,
  activeAgentIds,
  aliasesByAgentId,
}: {
  run: RunSnapshot;
  options: CreateRunOptions;
  query: string;
  activeAgentIds: Set<string>;
  aliasesByAgentId: Map<string, DBMMemoryAlias>;
}): void {
  if (!isDBMMemoryWriteEnabled() || !query) {
    return;
  }
  const output = getDBMMemoryAssistantOutput(run.getRunMessages?.());
  if (!output) {
    return;
  }
  const context = buildMemoryContext(options);
  const targets = Array.from(activeAgentIds)
    .map((agentId) => aliasesByAgentId.get(agentId))
    .filter((alias): alias is DBMMemoryAlias => !!alias);
  if (targets.length === 0) {
    return;
  }

  void Promise.allSettled(
    targets.map((alias) => extractDBMMemory({ alias, input: query, output, context })),
  ).then((results) => {
    const rejected = results.filter((result) => result.status === 'rejected').length;
    if (rejected > 0) {
      logger.warn('[DBM Memory] one or more asynchronous extraction jobs failed', { rejected });
    }
  });
}

/**
 * DBM wrapper around LibreChat's canonical createRun.
 *
 * Design constraints:
 * - DBM memory is completely fail-open.
 * - With DBM_MEMORY_ENABLED=false, behavior is the canonical createRun path.
 * - Retrieved memory is appended only to request-scoped additional_instructions.
 * - Original agent objects are restored immediately after graph construction.
 * - Post-run extraction is fire-and-forget and only targets aliased agents that
 *   actually produced a model result during this run (root is a fallback).
 */
export async function createRun(options: CreateRunOptions) {
  if (!isDBMMemoryEnabled()) {
    return createBaseRun(options);
  }

  const query = getDBMMemoryQuery(options.messages);
  const activeAgentIds = new Set<string>();
  if (options.agents[0]?.id) {
    activeAgentIds.add(options.agents[0].id);
  }

  let aliasesByAgentId = new Map<string, DBMMemoryAlias>();
  let restore: Array<() => void> = [];
  try {
    const prepared = await prepareMemory(options);
    aliasesByAgentId = prepared.aliasesByAgentId;
    restore = prepared.restore;
  } catch (error) {
    logger.warn('[DBM Memory] preparation failed; continuing without external memory', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const wrappedOptions: CreateRunOptions = {
    ...options,
    customHandlers: wrapModelEndHandler(options.customHandlers, activeAgentIds),
  };

  let run: Awaited<ReturnType<typeof createBaseRun>>;
  try {
    run = await createBaseRun(wrappedOptions);
  } finally {
    for (const restoreAgent of restore) {
      restoreAgent();
    }
  }

  if (!isDBMMemoryWriteEnabled()) {
    return run;
  }

  const mutableRun = run as typeof run & {
    processStream: (...args: Parameters<typeof run.processStream>) => ReturnType<typeof run.processStream>;
  };
  const originalProcessStream = run.processStream.bind(run);
  let extractionScheduled = false;
  mutableRun.processStream = (async (...args: Parameters<typeof run.processStream>) => {
    const result = await originalProcessStream(...args);
    if (!extractionScheduled) {
      extractionScheduled = true;
      scheduleExtraction({
        run: run as unknown as RunSnapshot,
        options,
        query,
        activeAgentIds,
        aliasesByAgentId,
      });
    }
    return result;
  }) as typeof mutableRun.processStream;

  return run;
}

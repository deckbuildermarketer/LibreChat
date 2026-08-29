'use strict';

const path = require('path');
const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');
const {
  AccessRoleIds,
  Constants,
  PrincipalType,
  ResourceType,
} = require('librechat-data-provider');
const { buildBlueprint } = require('./blueprint');

require('module-alias')({ base: path.resolve(__dirname, '..', '..', 'api') });

const connect = require('../connect');
const db = require('~/models');
const { grantPermission } = require('~/server/services/PermissionService');

const { User } = createModels(mongoose);

const parseArgs = (argv) => ({
  dryRun: argv.includes('--dry-run'),
  json: argv.includes('--json'),
});

const compact = (value) => {
  if (Array.isArray(value)) return value.map(compact);
  if (value == null || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    result[key] = compact(item);
  }
  return result;
};

const agentSearch = (id, owner) => ({
  id,
  ...(owner.tenantId ? { tenantId: owner.tenantId } : {}),
});

const buildAgentData = (definition, owner) =>
  compact({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    instructions: definition.instructions,
    provider: definition.provider,
    model: definition.model,
    model_parameters: definition.model_parameters,
    category: definition.category,
    recursion_limit: definition.recursion_limit,
    tools: definition.tools,
    mcpServerNames: definition.mcpServerNames,
    skills: definition.skills,
    skills_enabled: definition.skills_enabled,
    memory_scope: definition.memory_scope,
    subagents: definition.subagents,
    edges: definition.edges,
    conversation_starters: definition.conversation_starters || [],
    author: owner._id,
    authorName: owner.name || owner.username || owner.email,
    tenantId: owner.tenantId,
    is_promoted: false,
  });

const buildUpdateData = (definition) =>
  compact({
    name: definition.name,
    description: definition.description,
    instructions: definition.instructions,
    provider: definition.provider,
    model: definition.model,
    model_parameters: definition.model_parameters,
    category: definition.category,
    recursion_limit: definition.recursion_limit,
    tools: definition.tools,
    mcpServerNames: definition.mcpServerNames,
    skills: definition.skills,
    skills_enabled: definition.skills_enabled,
    memory_scope: definition.memory_scope,
    subagents: definition.subagents,
    edges: definition.edges,
    conversation_starters: definition.conversation_starters || [],
    is_promoted: false,
  });

const ensureOwnerPermissions = async (agent, ownerId) => {
  await Promise.all([
    grantPermission({
      principalType: PrincipalType.USER,
      principalId: ownerId,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_OWNER,
      grantedBy: ownerId,
    }),
    grantPermission({
      principalType: PrincipalType.USER,
      principalId: ownerId,
      resourceType: ResourceType.REMOTE_AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
      grantedBy: ownerId,
    }),
  ]);
};

const upsertAgent = async ({ definition, owner }) => {
  const search = agentSearch(definition.id, owner);
  const existing = await db.getAgent(search);
  const ownerId = owner._id.toString();

  if (existing) {
    const existingAuthor = existing.author?.toString?.() || String(existing.author || '');
    if (existingAuthor && existingAuthor !== ownerId) {
      throw new Error(
        `Refusing to take over ${definition.id}: it is owned by a different LibreChat user`,
      );
    }

    const updated = await db.updateAgent(search, buildUpdateData(definition), {
      updatingUserId: ownerId,
    });
    if (!updated) throw new Error(`Failed to update ${definition.id}`);
    await ensureOwnerPermissions(updated, ownerId);
    return { id: definition.id, name: definition.name, action: 'updated' };
  }

  const created = await db.createAgent(buildAgentData(definition, owner));
  await ensureOwnerPermissions(created, ownerId);
  return { id: definition.id, name: definition.name, action: 'created' };
};

const validateBlueprint = (blueprint) => {
  const ids = blueprint.allAgents.map((agent) => agent.id);
  if (new Set(ids).size !== ids.length) throw new Error('Executive blueprint contains duplicate IDs');
  if (blueprint.specialists.length !== 9) throw new Error('Executive council must contain 9 specialists');
  const expected = new Set(blueprint.specialists.map((agent) => agent.id));
  const actual = new Set(blueprint.executive.subagents?.agent_ids || []);
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
    throw new Error('Executive subagent roster does not match the specialist roster');
  }
  for (const specialist of blueprint.specialists) {
    if (specialist.subagents?.enabled) {
      throw new Error(`Specialist ${specialist.id} must not recursively spawn the executive council`);
    }
  }
};

const summarizeBlueprint = (blueprint) => ({
  ownerEmail: blueprint.ownerEmail || null,
  executive: {
    id: blueprint.executive.id,
    provider: blueprint.executive.provider,
    model: blueprint.executive.model,
    tools: blueprint.executive.tools,
    mcpServerNames: blueprint.executive.mcpServerNames,
    specialistCount: blueprint.executive.subagents.agent_ids.length,
  },
  specialists: blueprint.specialists.map((agent) => ({
    key: agent.key,
    id: agent.id,
    provider: agent.provider,
    model: agent.model,
    tools: agent.tools,
    mcpServerNames: agent.mcpServerNames,
  })),
});

const provision = async ({ env = process.env, dryRun = false } = {}) => {
  const blueprint = buildBlueprint(env, { mcpDelimiter: Constants.mcp_delimiter });
  validateBlueprint(blueprint);

  if (dryRun) {
    return { dryRun: true, blueprint: summarizeBlueprint(blueprint), changes: [] };
  }

  if (!blueprint.ownerEmail) {
    throw new Error('DBM_EXECUTIVE_OWNER_EMAIL is required when provisioning');
  }

  await connect();
  const owner = await User.findOne({ email: blueprint.ownerEmail.trim().toLowerCase() });
  if (!owner) {
    throw new Error(`LibreChat user not found for DBM_EXECUTIVE_OWNER_EMAIL=${blueprint.ownerEmail}`);
  }

  const changes = [];
  // Specialists are created first so the Executive never points at missing children.
  for (const specialist of blueprint.specialists) {
    changes.push(await upsertAgent({ definition: specialist, owner }));
  }
  changes.push(await upsertAgent({ definition: blueprint.executive, owner }));

  return {
    dryRun: false,
    owner: owner.email,
    executiveId: blueprint.executive.id,
    changes,
  };
};

module.exports = {
  buildAgentData,
  buildUpdateData,
  parseArgs,
  provision,
  summarizeBlueprint,
  validateBlueprint,
};

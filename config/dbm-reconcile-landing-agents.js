const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');
const db = require('~/models');
const { Agent } = require('~/db/models');
const mongoose = require('mongoose');

const CONTENT_ID = 'agent_HzCrIyRmdU8-zsTzIGGNM';
const DELIVERY_ID = 'agent_BQUZvpQzOBWna39mbf_ML';
const SCOUT_ID = String(process.env.DBM_SCOUT_AGENT_ID || '').trim();

const CONTENT_SKILLS = [
  'dbm-landing-page-copy',
  'dbm-landing-page-production',
];

const DELIVERY_SKILLS = [
  'dbm-workspace-operator',
  'dbm-wordpress-blog-production',
  'dbm-wordpress-project-production',
  'dbm-wordpress-city-production',
  'dbm-wordpress-service-production',
  'dbm-wordpress-media-production',
  'dbm-wordpress-production-qa',
  'dbm-landing-page-deployment',
];

const CONTENT_FORBIDDEN_SKILLS = [
  'dbm-wordpress-blog-production',
  'dbm-wordpress-project-production',
  'dbm-wordpress-city-production',
  'dbm-wordpress-service-production',
  'dbm-wordpress-media-production',
  'dbm-wordpress-production-qa',
  'dbm-landing-page-deployment',
];

const DELIVERY_FORBIDDEN_SKILLS = [
  'dbm-landing-page-copy',
  'dbm-landing-page-production',
];

const DESIGN_SERVER = 'dbm-wordpress-design';
const PRODUCTION_SERVER = 'dbm-wordpress';

const DESIGN_TOOLS = [
  'sys__server__sys_mcp_dbm-wordpress-design',
  'list_clients_mcp_dbm-wordpress-design',
  'get_client_profile_mcp_dbm-wordpress-design',
  'wp_get_site_profile_mcp_dbm-wordpress-design',
  'wp_get_landing_page_context_mcp_dbm-wordpress-design',
  'wp_get_reference_post_mcp_dbm-wordpress-design',
  'wp_search_media_mcp_dbm-wordpress-design',
];

const PRODUCTION_TOOLS = [
  'sys__server__sys_mcp_dbm-wordpress',
  'list_clients_mcp_dbm-wordpress',
  'get_client_profile_mcp_dbm-wordpress',
  'wp_get_site_profile_mcp_dbm-wordpress',
  'wp_get_landing_page_context_mcp_dbm-wordpress',
  'wp_create_landing_page_draft_mcp_dbm-wordpress',
  'wp_update_landing_page_draft_mcp_dbm-wordpress',
  'wp_validate_landing_page_draft_mcp_dbm-wordpress',
  'wp_visual_qa_landing_page_mcp_dbm-wordpress',
  'wp_get_content_model_mcp_dbm-wordpress',
  'wp_get_reference_post_mcp_dbm-wordpress',
  'wp_get_available_shortcodes_mcp_dbm-wordpress',
  'wp_get_taxonomy_terms_mcp_dbm-wordpress',
  'wp_search_media_mcp_dbm-wordpress',
  'wp_upload_drive_image_mcp_dbm-wordpress',
  'wp_create_draft_mcp_dbm-wordpress',
  'wp_update_draft_mcp_dbm-wordpress',
  'wp_validate_draft_mcp_dbm-wordpress',
];

function readInstruction(filename) {
  return fs.readFileSync(path.join(__dirname, 'dbm-agent-instructions', filename), 'utf8').trim();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function withoutServerTools(tools, serverName) {
  const suffix = `_mcp_${serverName}`;
  return (tools || []).filter((tool) => !String(tool).endsWith(suffix));
}

async function skillMapByName(names) {
  const collection = mongoose.connection.db.collection('skills');
  const docs = await collection.find({ name: { $in: unique(names) } }).project({ _id: 1, name: 1 }).toArray();
  return new Map(docs.map((doc) => [doc.name, String(doc._id)]));
}

function requireSkills(map, names) {
  const missing = unique(names).filter((name) => !map.has(name));
  if (missing.length) {
    throw new Error(`Required synced DBM skills are missing: ${missing.join(', ')}`);
  }
}

function reconcileSkillIds(existingIds, desiredNames, forbiddenNames, skillMap) {
  const forbiddenIds = new Set(forbiddenNames.map((name) => skillMap.get(name)).filter(Boolean));
  const kept = (existingIds || []).map(String).filter((id) => !forbiddenIds.has(id));
  return unique([...kept, ...desiredNames.map((name) => skillMap.get(name))]);
}

function reconcileServers(existing, removeNames, addName) {
  const remove = new Set(removeNames);
  return unique([...(existing || []).filter((name) => !remove.has(name)), addName]);
}

async function updateAgentExact(agent, changes) {
  const updated = await db.updateAgent(
    { id: agent.id, _id: agent._id, updatedAt: agent.updatedAt },
    changes,
    { updatingUserId: String(agent.author), forceVersion: true },
  );
  if (!updated) throw new Error(`Concurrent or missing agent update: ${agent.name} (${agent.id})`);
  return updated;
}

async function main() {
  if (process.env.DBM_AGENT_RECONCILE_APPLY !== 'true') {
    throw new Error('DBM_AGENT_RECONCILE_APPLY must equal true for this one-time reconciliation.');
  }
  if (!SCOUT_ID) throw new Error('DBM_SCOUT_AGENT_ID is missing.');

  await connect();

  const targetIds = [SCOUT_ID, CONTENT_ID, DELIVERY_ID];
  const agents = await Agent.find({ id: { $in: targetIds } }).lean();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const missingAgents = targetIds.filter((id) => !byId.has(id));
  if (missingAgents.length) throw new Error(`Required active agents not found: ${missingAgents.join(', ')}`);

  const scout = byId.get(SCOUT_ID);
  const content = byId.get(CONTENT_ID);
  const delivery = byId.get(DELIVERY_ID);

  const allSkillNames = unique([
    ...CONTENT_SKILLS,
    ...DELIVERY_SKILLS,
    ...CONTENT_FORBIDDEN_SKILLS,
    ...DELIVERY_FORBIDDEN_SKILLS,
  ]);
  const skillMap = await skillMapByName(allSkillNames);
  requireSkills(skillMap, [...CONTENT_SKILLS, ...DELIVERY_SKILLS]);

  const contentTools = unique([
    ...withoutServerTools(withoutServerTools(content.tools, PRODUCTION_SERVER), DESIGN_SERVER),
    ...DESIGN_TOOLS,
  ]);
  const deliveryTools = unique([
    ...withoutServerTools(withoutServerTools(delivery.tools, DESIGN_SERVER), PRODUCTION_SERVER),
    ...PRODUCTION_TOOLS,
  ]);

  const contentSkills = reconcileSkillIds(
    content.skills,
    CONTENT_SKILLS,
    CONTENT_FORBIDDEN_SKILLS,
    skillMap,
  );
  const deliverySkills = reconcileSkillIds(
    delivery.skills,
    DELIVERY_SKILLS,
    DELIVERY_FORBIDDEN_SKILLS,
    skillMap,
  );

  const scoutUpdated = await updateAgentExact(scout, {
    instructions: readInstruction('SCOUT.md'),
  });

  const contentUpdated = await updateAgentExact(content, {
    instructions: readInstruction('D_CONTENT_STUDIO_DIRECTOR.md'),
    tools: contentTools,
    mcpServerNames: reconcileServers(
      content.mcpServerNames,
      [PRODUCTION_SERVER, DESIGN_SERVER],
      DESIGN_SERVER,
    ),
    skills: contentSkills,
    skills_enabled: true,
  });

  const deliveryUpdated = await updateAgentExact(delivery, {
    instructions: readInstruction('D_DELIVERY_OPERATIONS_DIRECTOR.md'),
    tools: deliveryTools,
    mcpServerNames: reconcileServers(
      delivery.mcpServerNames,
      [DESIGN_SERVER, PRODUCTION_SERVER],
      PRODUCTION_SERVER,
    ),
    skills: deliverySkills,
    skills_enabled: true,
  });

  const verifyAgents = await Agent.find({ id: { $in: targetIds } })
    .select('id name tools skills skills_enabled mcpServerNames instructions updatedAt')
    .lean();
  const verify = new Map(verifyAgents.map((agent) => [agent.id, agent]));

  const vContent = verify.get(CONTENT_ID);
  const vDelivery = verify.get(DELIVERY_ID);
  const vScout = verify.get(SCOUT_ID);

  const assertions = {
    scout_instructions_synced:
      vScout?.instructions?.trim() === readInstruction('SCOUT.md'),
    content_instructions_synced:
      vContent?.instructions?.trim() === readInstruction('D_CONTENT_STUDIO_DIRECTOR.md'),
    delivery_instructions_synced:
      vDelivery?.instructions?.trim() === readInstruction('D_DELIVERY_OPERATIONS_DIRECTOR.md'),
    content_has_design_server:
      vContent?.mcpServerNames?.includes(DESIGN_SERVER) &&
      DESIGN_TOOLS.every((tool) => vContent?.tools?.includes(tool)),
    content_has_no_production_server:
      !vContent?.mcpServerNames?.includes(PRODUCTION_SERVER) &&
      !(vContent?.tools || []).some((tool) => String(tool).endsWith(`_mcp_${PRODUCTION_SERVER}`)),
    delivery_has_production_server:
      vDelivery?.mcpServerNames?.includes(PRODUCTION_SERVER) &&
      PRODUCTION_TOOLS.every((tool) => vDelivery?.tools?.includes(tool)),
    delivery_has_no_design_server:
      !vDelivery?.mcpServerNames?.includes(DESIGN_SERVER) &&
      !(vDelivery?.tools || []).some((tool) => String(tool).endsWith(`_mcp_${DESIGN_SERVER}`)),
    content_skills:
      CONTENT_SKILLS.every((name) => vContent?.skills?.map(String).includes(skillMap.get(name))),
    delivery_skills:
      DELIVERY_SKILLS.every((name) => vDelivery?.skills?.map(String).includes(skillMap.get(name))),
  };

  const failed = Object.entries(assertions).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) throw new Error(`Post-reconciliation verification failed: ${failed.join(', ')}`);

  console.log('[DBM_AGENT_RECONCILE]' + JSON.stringify({
    ok: true,
    scout: { id: scoutUpdated.id, name: scoutUpdated.name },
    content: {
      id: contentUpdated.id,
      name: contentUpdated.name,
      mcpServerNames: vContent.mcpServerNames,
      landingSkills: CONTENT_SKILLS,
      preservedSkillCount: (vContent.skills || []).length,
    },
    delivery: {
      id: deliveryUpdated.id,
      name: deliveryUpdated.name,
      mcpServerNames: vDelivery.mcpServerNames,
      wordpressSkills: DELIVERY_SKILLS,
      preservedSkillCount: (vDelivery.skills || []).length,
    },
    assertions,
  }));

  await mongoose.connection.close();
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('[DBM_AGENT_RECONCILE_ERROR]', error?.stack || error);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });

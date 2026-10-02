const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');
const db = require('~/models');
const { Agent } = require('~/db/models');
const mongoose = require('mongoose');

const CONTENT_NAME = 'D: Content Studio Director';
const WEBSITE_NAME = 'D: Website Production Director';
const DELIVERY_NAME = 'D: Delivery Operations Director';

const CONTENT_SKILLS = [
  'dbm-landing-page-copy',
  'dbm-landing-page-production',
];

const WORDPRESS_SKILLS = [
  'dbm-wordpress-blog-production',
  'dbm-wordpress-project-production',
  'dbm-wordpress-city-production',
  'dbm-wordpress-service-production',
  'dbm-wordpress-media-production',
  'dbm-wordpress-production-qa',
  'dbm-landing-page-deployment',
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

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function withoutServerTools(tools, serverName) {
  const suffix = `_mcp_${serverName}`;
  return (tools || []).filter((tool) => !String(tool).endsWith(suffix));
}

function removeServers(existing, names) {
  const remove = new Set(names);
  return unique((existing || []).filter((name) => !remove.has(name)));
}

function addServer(existing, name) {
  return unique([...(existing || []), name]);
}

async function exactAgentByName(name) {
  const matches = await Agent.find({ name }).lean();
  if (matches.length !== 1) {
    const candidates = matches.map((agent) => ({
      id: agent.id,
      name: agent.name,
      updatedAt: agent.updatedAt,
    }));
    throw new Error(`Expected exactly one active agent named "${name}", found ${matches.length}: ${JSON.stringify(candidates)}`);
  }
  return matches[0];
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

  await connect();

  const [content, website, delivery] = await Promise.all([
    exactAgentByName(CONTENT_NAME),
    exactAgentByName(WEBSITE_NAME),
    exactAgentByName(DELIVERY_NAME),
  ]);

  const allSkillNames = unique([...CONTENT_SKILLS, ...WORDPRESS_SKILLS]);
  const skillMap = await skillMapByName(allSkillNames);
  requireSkills(skillMap, allSkillNames);

  const contentTools = unique([
    ...withoutServerTools(withoutServerTools(content.tools, PRODUCTION_SERVER), DESIGN_SERVER),
    ...DESIGN_TOOLS,
  ]);

  const websiteTools = unique([
    ...withoutServerTools(withoutServerTools(website.tools, DESIGN_SERVER), PRODUCTION_SERVER),
    ...PRODUCTION_TOOLS,
  ]);

  const deliveryTools = withoutServerTools(
    withoutServerTools(delivery.tools, DESIGN_SERVER),
    PRODUCTION_SERVER,
  );

  const contentSkills = reconcileSkillIds(
    content.skills,
    CONTENT_SKILLS,
    WORDPRESS_SKILLS,
    skillMap,
  );

  const websiteSkills = reconcileSkillIds(
    website.skills,
    WORDPRESS_SKILLS,
    CONTENT_SKILLS,
    skillMap,
  );

  const deliverySkills = reconcileSkillIds(
    delivery.skills,
    [],
    WORDPRESS_SKILLS,
    skillMap,
  );

  await updateAgentExact(content, {
    tools: contentTools,
    mcpServerNames: addServer(removeServers(content.mcpServerNames, [DESIGN_SERVER, PRODUCTION_SERVER]), DESIGN_SERVER),
    skills: contentSkills,
    skills_enabled: true,
  });

  await updateAgentExact(website, {
    tools: websiteTools,
    mcpServerNames: addServer(removeServers(website.mcpServerNames, [DESIGN_SERVER, PRODUCTION_SERVER]), PRODUCTION_SERVER),
    skills: websiteSkills,
    skills_enabled: true,
  });

  await updateAgentExact(delivery, {
    tools: deliveryTools,
    mcpServerNames: removeServers(delivery.mcpServerNames, [DESIGN_SERVER, PRODUCTION_SERVER]),
    skills: deliverySkills,
    skills_enabled: true,
  });

  const verifyAgents = await Agent.find({ id: { $in: [content.id, website.id, delivery.id] } })
    .select('id name tools skills skills_enabled mcpServerNames updatedAt')
    .lean();
  const verify = new Map(verifyAgents.map((agent) => [agent.id, agent]));
  const vContent = verify.get(content.id);
  const vWebsite = verify.get(website.id);
  const vDelivery = verify.get(delivery.id);

  const contentSkillIds = new Set((vContent?.skills || []).map(String));
  const websiteSkillIds = new Set((vWebsite?.skills || []).map(String));
  const deliverySkillIds = new Set((vDelivery?.skills || []).map(String));

  const assertions = {
    content_has_design_server:
      vContent?.mcpServerNames?.includes(DESIGN_SERVER) &&
      DESIGN_TOOLS.every((tool) => vContent?.tools?.includes(tool)),
    content_has_no_production_server:
      !vContent?.mcpServerNames?.includes(PRODUCTION_SERVER) &&
      !(vContent?.tools || []).some((tool) => String(tool).endsWith(`_mcp_${PRODUCTION_SERVER}`)),
    content_has_content_landing_skills:
      CONTENT_SKILLS.every((name) => contentSkillIds.has(skillMap.get(name))),
    content_has_no_wordpress_production_skills:
      WORDPRESS_SKILLS.every((name) => !contentSkillIds.has(skillMap.get(name))),

    website_has_production_server:
      vWebsite?.mcpServerNames?.includes(PRODUCTION_SERVER) &&
      PRODUCTION_TOOLS.every((tool) => vWebsite?.tools?.includes(tool)),
    website_has_no_design_server:
      !vWebsite?.mcpServerNames?.includes(DESIGN_SERVER) &&
      !(vWebsite?.tools || []).some((tool) => String(tool).endsWith(`_mcp_${DESIGN_SERVER}`)),
    website_has_wordpress_skills:
      WORDPRESS_SKILLS.every((name) => websiteSkillIds.has(skillMap.get(name))),
    website_has_no_content_landing_skills:
      CONTENT_SKILLS.every((name) => !websiteSkillIds.has(skillMap.get(name))),

    delivery_has_no_wordpress_servers:
      !vDelivery?.mcpServerNames?.includes(DESIGN_SERVER) &&
      !vDelivery?.mcpServerNames?.includes(PRODUCTION_SERVER) &&
      !(vDelivery?.tools || []).some((tool) =>
        String(tool).endsWith(`_mcp_${DESIGN_SERVER}`) ||
        String(tool).endsWith(`_mcp_${PRODUCTION_SERVER}`)
      ),
    delivery_has_no_wordpress_skills:
      WORDPRESS_SKILLS.every((name) => !deliverySkillIds.has(skillMap.get(name))),
  };

  const failed = Object.entries(assertions).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) {
    throw new Error(`Post-reconciliation verification failed: ${failed.join(', ')}`);
  }

  console.log('[DBM_WEBSITE_BINDING_RECONCILE]' + JSON.stringify({
    ok: true,
    content: {
      id: content.id,
      name: content.name,
      mcpServerNames: vContent.mcpServerNames,
      skillCount: (vContent.skills || []).length,
    },
    website: {
      id: website.id,
      name: website.name,
      mcpServerNames: vWebsite.mcpServerNames,
      wordpressSkills: WORDPRESS_SKILLS,
      skillCount: (vWebsite.skills || []).length,
    },
    delivery: {
      id: delivery.id,
      name: delivery.name,
      mcpServerNames: vDelivery.mcpServerNames,
      skillCount: (vDelivery.skills || []).length,
    },
    assertions,
  }));

  await mongoose.connection.close();
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('[DBM_WEBSITE_BINDING_RECONCILE_ERROR]', error?.stack || error);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });

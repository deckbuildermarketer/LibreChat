const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');
const mongoose = require('mongoose');
const { Agent } = require('~/db/models');

const TARGETS = [
  'agent_HzCrIyRmdU8-zsTzIGGNM',
  'agent_BQUZvpQzOBWna39mbf_ML',
];

async function main() {
  await connect();
  const agents = await Agent.find({ id: { $in: TARGETS } })
    .select('id name tools skills skills_enabled skill_authoring_enabled skills_scope mcpServerNames updatedAt')
    .lean();

  const db = mongoose.connection.db;
  const landingSkills = db
    ? await db.collection('skills')
        .find({ name: { $in: ['dbm-landing-page-copy', 'dbm-landing-page-production', 'dbm-landing-page-deployment'] } })
        .project({ _id: 1, name: 1, source: 1, updatedAt: 1 })
        .toArray()
    : [];

  const result = {
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      tools: agent.tools ?? [],
      mcpServerNames: agent.mcpServerNames ?? [],
      skills: agent.skills ?? [],
      skills_enabled: agent.skills_enabled,
      skill_authoring_enabled: agent.skill_authoring_enabled,
      skills_scope: agent.skills_scope,
      updatedAt: agent.updatedAt,
    })),
    landingSkills: landingSkills.map((skill) => ({
      id: String(skill._id),
      name: skill.name,
      source: skill.source,
      updatedAt: skill.updatedAt,
    })),
  };

  console.log('[DBM_AGENT_AUDIT]' + JSON.stringify(result));
  await mongoose.connection.close();
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('[DBM_AGENT_AUDIT_ERROR]', error?.stack || error);
  process.exit(1);
});

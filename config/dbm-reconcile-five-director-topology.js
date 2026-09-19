const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');
const db = require('~/models');
const { Agent } = require('~/db/models');
const mongoose = require('mongoose');

const IDS = {
  scout: 'agent_d-Q_-2dKqhlE1T-zJXuS7',
  marketing: 'agent_Om6097sLPWDShJxbv6T81',
  content: 'agent_HzCrIyRmdU8-zsTzIGGNM',
  website: 'agent_M3Iw3bDzDLcoVuWsl9ABU',
  delivery: 'agent_BQUZvpQzOBWna39mbf_ML',
  bi: 'agent_DvwPJLC98JUU8G5FXITQh',
};

const DIRECTOR_IDS = [
  IDS.marketing,
  IDS.content,
  IDS.website,
  IDS.delivery,
  IDS.bi,
];

const OVERRIDES = {
  scout: `## DBM FIVE-DIRECTOR ROUTING OVERRIDE — ACTIVE

This section supersedes any older instruction that says Scout has four Directors or that Website Production does not exist.

Your direct Director children are exactly:
- D: Marketing Growth Director
- D: Content Studio Director
- D: Website Production Director
- D: Delivery Operations Director
- D: Business Intelligence Director

Routing:
- current-client marketing diagnosis/strategy -> Marketing Growth;
- new or revised website copy/design/build packet -> Content Studio;
- approved WordPress implementation, including landing/thank-you Draft placement and browser QA -> Website Production;
- GHL and other supported non-WordPress persistent operations -> Delivery Operations;
- DBM internal platform/Scout/LibreChat/MCP/Railway work -> Business Intelligence.

For WordPress work, do not route persistence to Delivery Operations. Website Production is the sole WordPress implementation owner.`,
  master: `## DBM FIVE-DIRECTOR ROUTING OVERRIDE — ACTIVE

This section supersedes any older four-Director or Delivery-owned WordPress routing language.

Your direct Director children are exactly:
- D: Marketing Growth Director
- D: Content Studio Director
- D: Website Production Director
- D: Delivery Operations Director
- D: Business Intelligence Director

WordPress implementation belongs to Website Production. Content Studio owns substantive website copy/design. Delivery Operations owns supported non-WordPress persistence.`,
  content: `## WORDPRESS HANDOFF OVERRIDE — ACTIVE

This section supersedes any older instruction that hands WordPress persistence to Delivery Operations.

Content Studio remains read-only.
- WordPress approved artifacts and LANDING_PAGE_BUILD_PACKET outputs -> D: Website Production Director.
- GHL or another supported non-WordPress persistent destination -> D: Delivery Operations Director.
- Do not call dbm-wordpress or perform WordPress mutation.
- Real-browser WordPress visual QA belongs to Website Production.`,
  website: `## ELEMENTOR FULL-WIDTH WORDPRESS OVERRIDE — ACTIVE

This section is mandatory for DBM WordPress landing and thank-you production.

Website Production is the sole WordPress implementation owner. WordPress writes remain Draft-only and never publish.

All DBM client websites in this production system use Elementor. For every DBM landing page and matching thank-you page:
- use Elementor Full Width (elementor_header_footer);
- preserve the existing site header and footer;
- never use Elementor Canvas (elementor_canvas);
- never silently fall back to a constrained theme/default template when Elementor Full Width should be available;
- verify the stored page template during read-back;
- treat missing Elementor Full Width as an implementation/configuration defect;
- require structural validation and real-browser responsive QA before ready_for_review=true;
- make only bounded implementation-level fixes; substantive copy/design changes return to Content Studio.`,
  delivery: `## WORDPRESS OWNERSHIP OVERRIDE — ACTIVE

This section supersedes any older instruction assigning WordPress production to Delivery Operations.

Delivery Operations does not own WordPress production.
- Do not call dbm-wordpress or dbm-wordpress-design.
- Do not create, update, validate, or visually QA WordPress Drafts.
- WordPress implementation -> D: Website Production Director.
- GHL/non-WordPress persistence remains capability- and authorization-driven.`,
};

function appendOverride(existing, override) {
  const source = String(existing || '').trim();
  const marker = override.split('\n')[0];
  if (source.includes(marker)) return source;
  return source ? `${source}\n\n${override}` : override;
}

async function oneAgent(query, label) {
  const matches = await Agent.find(query).lean();
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${label}; found ${matches.length}: ${JSON.stringify(
        matches.map((agent) => ({ id: agent.id, name: agent.name, updatedAt: agent.updatedAt })),
      )}`,
    );
  }
  return matches[0];
}

async function updateAgentExact(agent, changes) {
  const updated = await db.updateAgent(
    { id: agent.id, _id: agent._id, updatedAt: agent.updatedAt },
    changes,
    { updatingUserId: String(agent.author), forceVersion: true },
  );
  if (!updated) {
    throw new Error(`Concurrent or missing agent update: ${agent.name} (${agent.id})`);
  }
  return updated;
}

function nextSubagents(existing) {
  const current = existing && typeof existing === 'object' ? existing : {};
  return {
    ...current,
    enabled: true,
    allowSelf: false,
    agent_ids: [...DIRECTOR_IDS],
  };
}

function sameIds(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((id, index) => id === expected[index]);
}

async function main() {
  if (process.env.DBM_TOPOLOGY_RECONCILE_APPLY !== 'true') {
    throw new Error(
      'DBM_TOPOLOGY_RECONCILE_APPLY must equal true for this one-time reconciliation.',
    );
  }

  await connect();

  const [scout, master, contentAgent, website, delivery] = await Promise.all([
    oneAgent({ id: IDS.scout }, 'Scout'),
    oneAgent({ name: /DBM Master/i }, 'DBM Master agent'),
    oneAgent({ id: IDS.content }, 'Content Studio Director'),
    oneAgent({ id: IDS.website }, 'Website Production Director'),
    oneAgent({ id: IDS.delivery }, 'Delivery Operations Director'),
  ]);

  await updateAgentExact(scout, {
    subagents: nextSubagents(scout.subagents),
    instructions: appendOverride(scout.instructions, OVERRIDES.scout),
  });
  await updateAgentExact(master, {
    subagents: nextSubagents(master.subagents),
    instructions: appendOverride(master.instructions, OVERRIDES.master),
  });
  await updateAgentExact(contentAgent, {
    instructions: appendOverride(contentAgent.instructions, OVERRIDES.content),
  });
  await updateAgentExact(website, {
    instructions: appendOverride(website.instructions, OVERRIDES.website),
  });
  await updateAgentExact(delivery, {
    instructions: appendOverride(delivery.instructions, OVERRIDES.delivery),
  });

  const verifyDocs = await Agent.find({
    id: { $in: [IDS.scout, master.id, IDS.content, IDS.website, IDS.delivery] },
  })
    .select('id name subagents instructions updatedAt')
    .lean();
  const verify = new Map(verifyDocs.map((agent) => [agent.id, agent]));

  const vScout = verify.get(IDS.scout);
  const vMaster = verify.get(master.id);
  const vContent = verify.get(IDS.content);
  const vWebsite = verify.get(IDS.website);
  const vDelivery = verify.get(IDS.delivery);

  const assertions = {
    scout_subagents_enabled: vScout?.subagents?.enabled === true,
    scout_self_spawn_disabled: vScout?.subagents?.allowSelf === false,
    scout_has_exact_five_directors: sameIds(vScout?.subagents?.agent_ids, DIRECTOR_IDS),
    master_subagents_enabled: vMaster?.subagents?.enabled === true,
    master_self_spawn_disabled: vMaster?.subagents?.allowSelf === false,
    master_has_exact_five_directors: sameIds(vMaster?.subagents?.agent_ids, DIRECTOR_IDS),
    scout_instruction_override:
      String(vScout?.instructions || '').includes('DBM FIVE-DIRECTOR ROUTING OVERRIDE — ACTIVE'),
    master_instruction_override:
      String(vMaster?.instructions || '').includes('DBM FIVE-DIRECTOR ROUTING OVERRIDE — ACTIVE'),
    content_wordpress_handoff_override:
      String(vContent?.instructions || '').includes('WORDPRESS HANDOFF OVERRIDE — ACTIVE'),
    website_elementor_full_width_override:
      String(vWebsite?.instructions || '').includes(
        'ELEMENTOR FULL-WIDTH WORDPRESS OVERRIDE — ACTIVE',
      ) &&
      String(vWebsite?.instructions || '').includes('elementor_header_footer') &&
      String(vWebsite?.instructions || '').includes('elementor_canvas'),
    delivery_wordpress_boundary_override:
      String(vDelivery?.instructions || '').includes('WORDPRESS OWNERSHIP OVERRIDE — ACTIVE'),
  };

  const failed = Object.entries(assertions)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (failed.length) {
    throw new Error(`DBM topology verification failed: ${failed.join(', ')}`);
  }

  console.log(
    '[DBM_FIVE_DIRECTOR_TOPOLOGY_RECONCILE]' +
      JSON.stringify({
        ok: true,
        scout: {
          id: vScout.id,
          name: vScout.name,
          subagents: vScout.subagents,
        },
        master: {
          id: vMaster.id,
          name: vMaster.name,
          subagents: vMaster.subagents,
        },
        website: {
          id: vWebsite.id,
          name: vWebsite.name,
          elementorFullWidthInstruction: true,
        },
        assertions,
      }),
  );

  await mongoose.connection.close();
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('[DBM_FIVE_DIRECTOR_TOPOLOGY_RECONCILE_ERROR]', error?.stack || error);
    try {
      await mongoose.connection.close();
    } catch {}
    process.exit(1);
  });

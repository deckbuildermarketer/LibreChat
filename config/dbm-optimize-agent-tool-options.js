const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const crypto = require('crypto');
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

const HOT_TOOLS = new Set([
  // Scout: keep the most common Slack read/write loop immediately visible.
  'read_channel_mcp_slack',
  'read_thread_mcp_slack',
  'search_public_and_private_mcp_slack',

  // Marketing director: common routing + top-line performance reads.
  'get_client_profile_mcp_dbm-marketing',
  'list_clients_mcp_dbm-marketing',
  'get_marketing_data_availability_mcp_dbm-marketing',
  'get_marketing_performance_snapshot_mcp_dbm-marketing',
  'get_gsc_search_performance_mcp_dbm-marketing',
  'get_ga4_report_mcp_dbm-marketing',
  'get_google_ads_summary_mcp_dbm-marketing',

  // Content director.
  'get_client_profile_mcp_dbm-knowledge',
  'list_clients_mcp_dbm-knowledge',
  'search_client_docs_mcp_dbm-knowledge',
  'get_client_profile_mcp_dbm-wordpress-design',
  'wp_get_landing_page_context_mcp_dbm-wordpress-design',
  'wp_get_site_profile_mcp_dbm-wordpress-design',
  'wp_get_reference_post_mcp_dbm-wordpress-design',
  'wp_search_media_mcp_dbm-wordpress-design',

  // Website director.
  'get_client_profile_mcp_dbm-wordpress',
  'list_clients_mcp_dbm-wordpress',
  'wp_get_landing_page_context_mcp_dbm-wordpress',
  'wp_get_site_profile_mcp_dbm-wordpress',
  'wp_get_content_model_mcp_dbm-wordpress',
  'wp_get_reference_post_mcp_dbm-wordpress',
  'wp_search_media_mcp_dbm-wordpress',

  // Delivery director.
  'get_client_profile_mcp_dbm-clickup-action',
  'list_clients_mcp_dbm-clickup-action',
  'get_clickup_client_overview_mcp_dbm-clickup-action',
  'list_clickup_tasks_mcp_dbm-clickup-action',
  'get_clickup_task_mcp_dbm-clickup-action',
  'get_clickup_task_by_url_mcp_dbm-clickup-action',

  // BI director: cross-system routing + top-line reads.
  'get_client_profile_mcp_dbm-marketing',
  'get_client_profile_mcp_dbm-knowledge',
  'get_client_profile_mcp_dbm-clickup-action',
  'list_clients_mcp_dbm-marketing',
  'list_clients_mcp_dbm-knowledge',
  'get_marketing_performance_snapshot_mcp_dbm-marketing',
  'get_clickup_client_overview_mcp_dbm-clickup-action',
  'get_dbm_facts_mcp_dbm-knowledge',
  'search_dbm_knowledge_mcp_dbm-knowledge',
]);

function isMcpTool(name) {
  return typeof name === 'string' && (name.includes('_mcp_') || name.startsWith('sys__server__'));
}

function isSystemTool(name) {
  return name.startsWith('sys__server__');
}

function toolBase(name, server) {
  const suffix = `_mcp_${server}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function isReadPrefix(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function isReadOnlyTool(name) {
  if (!isMcpTool(name) || isSystemTool(name)) {
    return false;
  }

  if (name.endsWith('_mcp_dataforseo')) {
    return true;
  }
  if (name.endsWith('_mcp_dbm-marketing')) {
    return true;
  }
  if (name.endsWith('_mcp_dbm-knowledge')) {
    return true;
  }
  if (name.endsWith('_mcp_dbm-wordpress-design')) {
    const base = toolBase(name, 'dbm-wordpress-design');
    return isReadPrefix(base, ['get_', 'list_', 'wp_get_', 'wp_search_']);
  }
  if (name.endsWith('_mcp_dbm-wordpress')) {
    const base = toolBase(name, 'dbm-wordpress');
    return isReadPrefix(base, ['get_', 'list_', 'wp_get_', 'wp_search_', 'wp_validate_', 'wp_visual_qa_']);
  }
  if (name.endsWith('_mcp_dbm-clickup-action')) {
    const base = toolBase(name, 'dbm-clickup-action');
    return isReadPrefix(base, ['calculate_', 'discover_', 'get_', 'list_', 'search_']);
  }
  if (name.endsWith('_mcp_google-drive')) {
    const base = toolBase(name, 'google-drive');
    return isReadPrefix(base, ['download_', 'get_', 'list_', 'read_', 'search_']);
  }
  if (name.endsWith('_mcp_google-docs')) {
    return toolBase(name, 'google-docs') === 'read_doc';
  }
  if (name.endsWith('_mcp_google-sheets')) {
    const base = toolBase(name, 'google-sheets');
    return isReadPrefix(base, ['get_', 'read_', 'list_']);
  }
  if (name.endsWith('_mcp_google-slides')) {
    return toolBase(name, 'google-slides') === 'read_presentation';
  }
  if (name.endsWith('_mcp_google-calendar')) {
    const base = toolBase(name, 'google-calendar');
    return isReadPrefix(base, ['get_', 'list_', 'search_', 'suggest_']);
  }
  if (name.endsWith('_mcp_slack')) {
    const base = toolBase(name, 'slack');
    return isReadPrefix(base, ['get_', 'list_', 'read_', 'search_', 'slack_get_', 'slack_list_', 'slack_read_', 'slack_search_']);
  }

  return false;
}


/**
 * Programmatic tool calling is restricted to read-only, non-metered/internal
 * tools. DataForSEO remains direct-only because code loops can fan out paid
 * requests much faster than a normal tool-turn sequence.
 */
function isPtcEligibleTool(name) {
  return isReadOnlyTool(name) && !name.endsWith('_mcp_dataforseo');
}

/**
 * Background execution is opt-in only for clearly slow, idempotent reads.
 * Fast lookups stay synchronous so the continuation engine is reserved for
 * work where it actually reduces wall-clock latency.
 */
function isBackgroundEligibleTool(name) {
  if (!isReadOnlyTool(name)) {
    return false;
  }
  if (name.endsWith('_mcp_dataforseo')) {
    return true;
  }
  if (name.endsWith('_mcp_dbm-wordpress')) {
    const base = toolBase(name, 'dbm-wordpress');
    return base.startsWith('wp_visual_qa_');
  }
  return false;
}

function mergeManagedOptions(current, name) {
  const next = { ...(current || {}) };
  const readOnly = isReadOnlyTool(name);
  const ptcEligible = isPtcEligibleTool(name);
  const backgroundEligible = isBackgroundEligibleTool(name);
  const hot = HOT_TOOLS.has(name);

  if (hot) {
    delete next.defer_loading;
  } else {
    next.defer_loading = true;
  }

  // PTC is read-only and avoids metered DataForSEO fan-out. Mutations always
  // remain direct-only, even if a future model becomes more aggressive.
  next.allowed_callers = ptcEligible ? ['direct', 'code_execution'] : ['direct'];

  // Only clearly slow/idempotent reads can detach into the continuation engine.
  next.run_in_background = backgroundEligible;

  // Intent labels improve observability without changing execution semantics.
  next.describe_intent = true;

  return { next, readOnly, ptcEligible, backgroundEligible, hot };
}

function rollbackManagedOptions(current) {
  const next = { ...(current || {}) };
  delete next.defer_loading;
  delete next.allowed_callers;
  delete next.run_in_background;
  delete next.describe_intent;
  return next;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

async function main() {
  const mode = process.argv.includes('--apply')
    ? 'apply'
    : process.argv.includes('--rollback')
      ? 'rollback'
      : 'dry-run';

  await connect();

  const agents = await Agent.find({ id: { $in: Object.values(TARGETS) } })
    .select('id name tools tool_options updatedAt')
    .lean();

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const operations = [];
  const summary = {};

  for (const [role, id] of Object.entries(TARGETS)) {
    const agent = byId.get(id);
    if (!agent) {
      throw new Error(`Required DBM agent not found: ${role} (${id})`);
    }

    const currentOptions = { ...(agent.tool_options || {}) };
    const nextOptions = { ...currentOptions };
    let mcpTools = 0;
    let deferred = 0;
    let hot = 0;
    let ptcReadOnly = 0;
    let directOnly = 0;
    let backgroundEligible = 0;

    for (const name of agent.tools || []) {
      if (!isMcpTool(name)) continue;
      mcpTools += 1;

      if (mode === 'rollback') {
        const rolledBack = rollbackManagedOptions(nextOptions[name]);
        if (Object.keys(rolledBack).length === 0) {
          delete nextOptions[name];
        } else {
          nextOptions[name] = rolledBack;
        }
        continue;
      }

      const managed = mergeManagedOptions(nextOptions[name], name);
      nextOptions[name] = managed.next;
      if (managed.hot) hot += 1;
      else deferred += 1;
      if (managed.ptcEligible) {
        ptcReadOnly += 1;
      }
      if (managed.backgroundEligible) {
        backgroundEligible += 1;
      }
      if (!managed.ptcEligible) {
        directOnly += 1;
      }
    }

    const changed = JSON.stringify(currentOptions) !== JSON.stringify(nextOptions);
    summary[role] = {
      id,
      name: agent.name,
      mcpTools,
      hot,
      deferred,
      ptcReadOnly,
      directOnly,
      backgroundEligible,
      beforeHash: stableHash(currentOptions),
      afterHash: stableHash(nextOptions),
      changed,
    };

    if (changed && mode !== 'dry-run') {
      operations.push({
        updateOne: {
          filter: { id },
          update: { $set: { tool_options: nextOptions } },
        },
      });
    }
  }

  if (operations.length > 0) {
    const result = await Agent.bulkWrite(operations, { ordered: true });
    console.log(
      '[DBM_AGENT_TOOL_OPTIONS_WRITE]' +
        JSON.stringify({
          mode,
          matched: result.matchedCount,
          modified: result.modifiedCount,
        }),
    );
  }

  console.log('[DBM_AGENT_TOOL_OPTIONS_RESULT]' + JSON.stringify({ ok: true, mode, summary }));

  // This is a one-shot Railway pre-deploy process. Exit directly rather than
  // closing the shared Mongoose connection while auto-index promises may still
  // be settling in the background.
  process.exit(0);
}

main().catch((error) => {
  console.error('[DBM_AGENT_TOOL_OPTIONS_ERROR]', error?.stack || error);
  process.exit(1);
});

# DBM LibreChat v0.8.8 Stable Upgrade Notes

## Release boundary

This upgrade is intentionally pinned to the exact upstream LibreChat `v0.8.8` tag commit:

`e8f3be08623663d4ad7f7241e693c94469b63bb0`

No upstream commit after that tag is part of this release branch.

The production branch before this upgrade is preserved at:

`backup/secondary-before-v0.8.8-stable-2026-10-02`

## DBM customization preservation

The DBM production branch and upstream stable branch were compared from their common base.
DBM changed 37 files after that common base. Upstream v0.8.8 changed only two of those same files:
`.env.example` and `Dockerfile`.

The resolved upgrade branch therefore uses the exact upstream stable tree as its base, reapplies the
35 non-overlapping DBM files unchanged, and manually reconciles the two overlaps.

Preserved DBM behavior includes:

- nested Remote `/v1` direct-subagent discovery and permission checks;
- production subagent graph limits;
- strict native memory behavior and DBM memory safeguards;
- MCP result compaction and Drive guard;
- DBM Skills sync behavior;
- model-bound content protections;
- five-Director topology and landing-agent reconciliation;
- Railway persistence bootstrap and frontend build fail-fast checks.

## GPT-6.1 Sol

LibreChat v0.8.8 adds native `gpt-6.1-sol` support. Point releases inherit the corresponding GPT-6
family limits, pricing, reasoning behavior, and Responses routing unless an explicit release-specific
entry exists.

DBM keeps its curated OpenAI model catalog and adds `gpt-6.1-sol` without restoring retired GPT-5
entries.

Existing agents are not automatically migrated from `gpt-6-sol` to `gpt-6.1-sol` by this upgrade.
That should be a separate, reversible model rollout after production validation.

## Agent Management API and a DBM Agents MCP

LibreChat v0.8.8 exposes a beta Agent Management API under `/api/agents/v1`. The OpenAPI contract
supports Agent create/list/get/update/delete, Agent file upload/list/delete, and Skill list/get/update
plus Skill file reads/writes.

Management authentication is intentionally separate from normal Agent inference. It requires an OIDC
machine client configured under `endpoints.agents.managementApi.auth`. Each allowed client is bound
server-side to an existing LibreChat `userId` and `tenantId`, so the bound user's role, Agent/Skill
ACLs, provider restrictions, tool grants, file limits, and tenant isolation still apply.

For DBM, the recommended integration is a separate Railway service named, for example,
`dbm-agents-mcp`. It should be a thin MCP facade over the official Agent Management API rather than
writing to MongoDB directly.

Recommended first tool surface:

- read-only by default: `list_agents`, `get_agent`, `list_agent_files`, `list_skills`,
  `get_skill`, and topology/tool summaries;
- guarded writes for an administrative operator only: `update_agent`, `attach_skill`,
  `update_skill_file`, and controlled Agent file operations;
- no unrestricted delete tool in the first production version;
- explicit allowlist of DBM-owned Agents;
- post-write read-back verification and audit logging;
- tool approval for mutations.

This keeps the MCP service independently deployable inside the same Railway environment while using
LibreChat's supported management boundary and authorization model.

## Agent Plugins

Agent Plugins are experimental in v0.8.8. They bundle deployment Skills, MCP server declarations,
and optional command hooks into startup-loaded filesystem packages.

DBM should adopt them incrementally:

1. First pilot: package a small set of DBM Skills plus one read-only integration; do not enable hooks.
2. Keep secrets out of plugin files. Plugin MCP configuration does not expand arbitrary host
   environment variables.
3. Keep existing Railway MCP services as independent services. Existing `librechat.yaml` MCP
   definitions should remain authoritative during the pilot; they take precedence over a plugin MCP
   server with the same name.
4. Leave `DEPLOYMENT_PLUGIN_HOOKS` disabled initially. Command hooks execute trusted code on the
   LibreChat host and are not a sandbox.
5. Promote plugin packages only after staging tests cover startup, Skill discovery, MCP connectivity,
   authorization, subagents, and rollback.

For DBM's current architecture, plugins are best treated as a versioned capability-distribution layer,
not as a replacement for Railway-hosted MCP services.

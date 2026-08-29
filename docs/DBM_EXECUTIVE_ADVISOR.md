# DBM Executive Advisor

DBM Executive Advisor is a native LibreChat executive council designed for April's daily work at Deck Builder Marketers. It is not a second agent platform. It uses LibreChat's existing Agent runtime, subagents, MCP authorization, DBM memory integration, permissions, and provider routing.

The design is inspired by the executive-council pattern in SenteLabsAI/OpenExecutive (Apache-2.0), but the prompts and provisioning implementation in this repository are DBM-specific and independently written.

## What gets provisioned

The provisioner creates ten deterministic LibreChat agents:

- `agent_dbm_executive_advisor` — DBM Executive Advisor
- `agent_dbm_executive_cso` — Chief Strategy Officer
- `agent_dbm_executive_cfo` — Chief Financial Officer
- `agent_dbm_executive_coo` — Chief Operating Officer
- `agent_dbm_executive_cmo` — Chief Marketing Officer
- `agent_dbm_executive_cpo` — Chief Product Officer / Offers
- `agent_dbm_executive_chro` — Chief People Officer
- `agent_dbm_executive_gc` — General Counsel
- `agent_dbm_executive_board` — Executive Communications Director
- `agent_dbm_executive_cro` — Chief Revenue Officer

Only the Executive can spawn the council. Specialists do not recursively spawn other council members. This keeps fan-out bounded and makes the Executive the single synthesis layer.

The command is idempotent: rerunning it updates the same agents instead of creating duplicates. It refuses to take over one of these deterministic IDs if the record is already owned by another LibreChat user.

## Required LibreChat capability

The Agents endpoint must have the `subagents` capability enabled. DBM's current customized LibreChat runtime already supports saved-agent subagents; do not fall back to deprecated `agent_ids` chains.

If you want the Executive to use DBM memory or other native tools, those capabilities must also be enabled in the deployment as they are for any other LibreChat agent.

## Railway environment variables

### Required for provisioning

```env
DBM_EXECUTIVE_OWNER_EMAIL="april-librechat-email@example.com"
DBM_EXECUTIVE_PROVIDER="<LibreChat provider id>"
DBM_EXECUTIVE_MODEL="<model slug exposed by that provider>"
```

`DBM_EXECUTIVE_OWNER_EMAIL` must match April's existing LibreChat account exactly.

Use the exact provider identifier and model slug already accepted by the LibreChat Agent Builder. This deliberately avoids hard-coding a vendor or a model release into the executive system.

### Optional model tiers

The base model is always a valid fallback. These overrides let expensive reasoning stay concentrated on high-value work while lower-cost models handle routine specialist analysis.

```env
DBM_EXECUTIVE_REASONING_PROVIDER="<provider id>"
DBM_EXECUTIVE_REASONING_MODEL="<strong reasoning model>"
DBM_EXECUTIVE_FAST_PROVIDER="<provider id>"
DBM_EXECUTIVE_FAST_MODEL="<fast/low-cost model>"
```

Reasoning tier: Executive, CSO, CFO, General Counsel, Executive Communications, CRO.

Fast tier: COO, CMO, CPO, CHRO.

### OpenAI Responses API

When the selected OpenAI model should run through LibreChat's Responses API path:

```env
DBM_EXECUTIVE_USE_RESPONSES_API="true"
```

Tier-specific overrides are also supported:

```env
DBM_EXECUTIVE_REASONING_USE_RESPONSES_API="true"
DBM_EXECUTIVE_FAST_USE_RESPONSES_API="true"
```

For a GLM/Z.ai custom OpenAI-compatible endpoint, normally leave the Responses API flags false unless that configured LibreChat endpoint explicitly uses and supports the same path.

## Tools and MCP

The system fails closed: it receives no MCP server merely because that server exists in LibreChat. Attach only the business systems that the Executive should be allowed to read/use.

### Native or exact tool IDs

Comma-separated exact LibreChat tool IDs:

```env
DBM_EXECUTIVE_TOOLS="memory,web_search"
DBM_EXECUTIVE_CRO_TOOLS="<optional exact tool ids>"
DBM_EXECUTIVE_CMO_TOOLS="<optional exact tool ids>"
```

Any specialist supports the same pattern:

```text
DBM_EXECUTIVE_<ROLE>_TOOLS
```

Valid role keys are `EXECUTIVE`, `CSO`, `CFO`, `COO`, `CMO`, `CPO`, `CHRO`, `GC`, `BOARD`, and `CRO`.

### Whole MCP servers

For DBM's Railway-hosted MCP services, use the exact normalized MCP server names that LibreChat uses in tool keys:

```env
DBM_EXECUTIVE_MCP_SERVERS="<shared-read-server-1>,<shared-read-server-2>"
DBM_EXECUTIVE_CRO_MCP_SERVERS="<crm-or-sales-server>,<meeting-intelligence-server>"
DBM_EXECUTIVE_CMO_MCP_SERVERS="<analytics-server>,<ads-server>"
DBM_EXECUTIVE_CFO_MCP_SERVERS="<finance-or-warehouse-server>"
DBM_EXECUTIVE_COO_MCP_SERVERS="<project-management-server>"
```

The provisioner stores LibreChat's supported per-server runtime wildcard in the form:

```text
mcp_all_mcp_<server-name>
```

This lets request-scoped MCP servers resolve their actual tool catalog at chat runtime instead of baking a stale list into the agent.

Prefer role-specific server grants over putting every MCP on `DBM_EXECUTIVE_MCP_SERVERS`. The global variable is intentionally inherited by every council member.

## Skills

Skills are fail-closed. If no allowlist is configured, `skills_enabled` is false rather than exposing the entire catalog accidentally.

```env
DBM_EXECUTIVE_SKILLS="<shared-skill-id>"
DBM_EXECUTIVE_EXECUTIVE_SKILLS="<April voice/writing skill id>"
DBM_EXECUTIVE_CRO_SKILLS="<sales skill id>"
```

Use persisted/external LibreChat skill IDs, not display labels.

## Provision in Railway

Run a validation-only pass first:

```bash
node config/provision-dbm-executive.js --dry-run
```

For machine-readable output:

```bash
node config/provision-dbm-executive.js --dry-run --json
```

Apply the configuration:

```bash
node config/provision-dbm-executive.js
```

The command:

1. validates the council topology and model configuration;
2. resolves April's existing LibreChat user by email;
3. creates or updates all nine specialists first;
4. grants April normal Agent and Remote Agent owner permissions;
5. creates or updates the Executive last, after every child exists;
6. wires the Executive's `subagents.agent_ids` to the nine stable specialist IDs.

This is appropriate as a Railway one-off command after deployment. It does not need to run as a permanent service.

## Safety model

The prompts follow these operational boundaries:

- search/read/analyze: autonomous when the connected tool permits it;
- drafting: autonomous;
- sending external messages: explicit approval immediately before the write;
- CRM/client-record mutation: explicit approval;
- external calendar invitations: explicit approval;
- permission/sharing changes: explicit approval;
- deletes, publishing, financial commitments, or legal commitments: explicit approval.

The prompt is not the security boundary. LibreChat MCP ACLs, user permissions, client isolation, and native human-in-the-loop tool approvals remain authoritative.

## April daily behavior

For open-ended requests such as "What should I focus on today?" the Executive is instructed to produce an Executive Brief containing:

1. the top 1-3 priorities by business impact;
2. the revenue/client opportunity that deserves attention now;
3. the biggest blocker, risk, or decision;
4. concrete next actions with owner/role and timing;
5. the small set of metrics/facts to watch.

The Executive is explicitly prohibited from fabricating current DBM state. When a statement depends on current pipeline, meetings, campaigns, clients, tasks, or finances, it must use connected data or label the uncertainty.

## Revenue behavior

Revenue questions route to the CRO by default. The CRO diagnoses this system before asking for more volume:

```text
ICP -> signal/list quality -> offer -> outreach/demand -> response -> qualification
    -> meeting -> proposal -> close -> onboarding -> retention -> expansion/referral
```

The Executive adds CMO, CFO, CSO, COO, or CPO only when the decision crosses those domains. This prevents expensive all-council fan-out on routine sales questions.

## Smoke tests after provisioning

From April's LibreChat account, open `DBM Executive Advisor` and test:

1. `What should I focus on today to move DBM forward?`
2. `Give me three concrete ways to create more qualified pipeline this week. Use live data if you have it and tell me exactly what you checked.`
3. `Review our current sales pipeline and identify the largest revenue leak.`
4. `Pressure-test raising our service pricing. Consult finance, revenue, and strategy as needed.`
5. `Draft a follow-up to this prospect, but do not send it.`
6. Ask it to perform a consequential external write and verify the approval boundary before execution.

For tests 2-3, an answer that invents current numbers is a failure. If the required MCP is not attached or authorized, the correct behavior is to say that the live state could not be verified and identify the missing source.

## Automated test

The blueprint has a config-level regression test:

```bash
npm run test:config -- dbm-executive/blueprint.spec.js --runInBand
```

It verifies council size/topology, model-tier fallback, MCP wildcard construction, fail-closed skills, April daily behavior, sales routing, evidence requirements, and approval language.

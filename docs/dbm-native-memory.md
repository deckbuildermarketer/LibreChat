# DBM Native LibreChat Memory

## Status

DBM Chat uses LibreChat's native user-memory implementation as the only active personal memory layer.

The previous DBM mem0 gateway integration was removed from the LibreChat runtime on 2026-09-22. The Railway mem0 service should be retained temporarily as a rollback/data-export source, but DBM Chat must not call it once this migration is deployed.

## Why

LibreChat now provides first-party memory storage, personalization UI, automatic memory maintenance, per-user persistence, memory tools for agents, and optional agent-scoped partitions. Keeping a second external mem0 recall/extraction layer duplicates context, increases latency and token usage, and makes memory behavior harder to reason about.

## Runtime configuration

The production LibreChat configuration already enables native memory with personalization, a 10,000-token memory budget, restricted memory keys, and DBM-specific memory-agent instructions.

The memory agent must store only durable user-specific facts and preferences. Client facts, platform state, deployment state, credentials, secrets, temporary task state, transcripts, and authorization decisions must stay outside user memory.

## Railway cutover

On DBM Chat, these legacy variables are no longer required by the application runtime and should remain disabled during the rollback window:

- DBM_MEMORY_ENABLED
- DBM_MEMORY_RECALL_ENABLED
- DBM_MEMORY_INJECTION_ENABLED
- DBM_MEMORY_WRITE_ENABLED
- DBM_MEMORY_GATEWAY_URL
- DBM_MEMORY_GATEWAY_API_KEY
- DBM_MEMORY_TIMEOUT_MS

Do not delete the mem0 service or its backing data until the native-memory deployment has passed production validation and any required historical memory export has been completed.

## Rollback

The pre-upgrade branch is:

`backup/secondary-before-upstream-2026-09-22`

Restoring that branch plus the previous DBM_MEMORY_* settings restores the previous gateway-based behavior.

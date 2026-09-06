# DBM Memory rollout

Initial Railway variables for shadow mode:

```env
DBM_MEMORY_ENABLED=true
DBM_MEMORY_RECALL_ENABLED=true
DBM_MEMORY_INJECTION_ENABLED=false
DBM_MEMORY_WRITE_ENABLED=false
DBM_MEMORY_TIMEOUT_MS=2500
DBM_MEMORY_ALIAS_CACHE_TTL_MS=300000
DBM_MEMORY_RECALL_LIMIT=8
DBM_MEMORY_MAX_INJECTED_CHARS=6000
```

The DBM Memory integration is fail-open. Gateway outages must never prevent a LibreChat agent run.

PRE-RUN recall is root-agent-only. LibreChat does not search memories for every reachable subagent simply because that subagent exists in the graph. The Gateway receives both `agentId` (the LibreChat agent ID used to resolve the alias) and the stable `memoryKey`.

A normal Gateway recall may produce separate Mem0 SEARCH operations for user scope and agent scope. For Scout, the expected entities are the current `librechat:<user>` entity and `agent:scout`; `agent:undefined` is never expected.

Deployment must use the repository Dockerfile. The Dockerfile intentionally fails the image build if `npm run frontend` fails or if `/app/client/dist/index.html` is missing.

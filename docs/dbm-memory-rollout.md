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
DBM_MEMORY_MAX_AGENTS_PER_RUN=8
DBM_MEMORY_MAX_INJECTED_CHARS=6000
```

The DBM Memory integration is fail-open. Gateway outages must never prevent a LibreChat agent run.

Deployment must use the repository Dockerfile. The Dockerfile intentionally fails the image build if `npm run frontend` fails or if `/app/client/dist/index.html` is missing.

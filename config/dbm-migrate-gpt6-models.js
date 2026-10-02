const path = require('path');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const MODEL_KEY_RE = /^(?:model|modelName|model_name)$/i;
const GPT5_TEXT_RE = /^(openai\/)?gpt-5(?:[.-].*)?$/i;
const SPECIALIZED_RE = /(?:image|search-api|realtime|audio|transcribe|tts)/i;
const SOL_TIER_RE = /(?:terra|sol|pro|codex|thinking|reasoning)/i;
const NATIVE_OPENAI_ENDPOINTS = new Set(['openai', 'openAI']);

function mapGpt5Model(value) {
  if (typeof value !== 'string' || !GPT5_TEXT_RE.test(value)) return null;
  const prefix = value.toLowerCase().startsWith('openai/') ? 'openai/' : '';
  const bare = prefix ? value.slice(prefix.length) : value;
  if (SPECIALIZED_RE.test(bare)) return null;
  return `${prefix}${SOL_TIER_RE.test(bare) ? 'gpt-6-sol' : 'gpt-6-luna'}`;
}

function normalizeReasoningContainer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const next = { ...value };
  if (next.reasoning_effort === 'minimal') next.reasoning_effort = 'low';
  if (next.reasoning && typeof next.reasoning === 'object' && !Array.isArray(next.reasoning)) {
    next.reasoning = { ...next.reasoning };
    if (next.reasoning.effort === 'minimal') next.reasoning.effort = 'low';
  }
  return next;
}

function migrateNestedModelFields(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = migrateNestedModelFields(item);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };

  let changed = false;
  const next = { ...value };
  for (const [key, child] of Object.entries(value)) {
    if (MODEL_KEY_RE.test(key) && typeof child === 'string') {
      const mapped = mapGpt5Model(child);
      if (mapped) {
        next[key] = mapped;
        changed = true;
        continue;
      }
    }
    const nested = migrateNestedModelFields(child);
    if (nested.changed) {
      next[key] = nested.value;
      changed = true;
    }
  }
  return { value: changed ? next : value, changed };
}

function migrateAgentSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { value: snapshot, changed: false };
  }

  let changed = false;
  const next = { ...snapshot };
  const mapped = mapGpt5Model(snapshot.model);
  if (mapped) {
    next.model = mapped;
    changed = true;
  }

  if (snapshot.model_parameters && typeof snapshot.model_parameters === 'object') {
    const migrated = migrateNestedModelFields(snapshot.model_parameters);
    let params = normalizeReasoningContainer(migrated.value);
    const nativeOpenAI = NATIVE_OPENAI_ENDPOINTS.has(String(snapshot.provider || ''));
    if (nativeOpenAI && (mapped || /^gpt-6-(?:sol|luna)(?:$|-)/i.test(String(next.model || '')))) {
      params = { ...(params || {}), useResponsesApi: true };
    }
    if (migrated.changed || JSON.stringify(params) !== JSON.stringify(snapshot.model_parameters)) {
      next.model_parameters = params;
      changed = true;
    }
  } else if (
    NATIVE_OPENAI_ENDPOINTS.has(String(snapshot.provider || '')) &&
    /^gpt-6-(?:sol|luna)(?:$|-)/i.test(String(next.model || ''))
  ) {
    next.model_parameters = { useResponsesApi: true };
    changed = true;
  }

  return { value: changed ? next : snapshot, changed };
}

function migrateConversationLike(doc) {
  const mapped = mapGpt5Model(doc.model);
  if (!mapped) return null;

  const set = { model: mapped };
  if (NATIVE_OPENAI_ENDPOINTS.has(String(doc.endpoint || ''))) {
    set.useResponsesApi = true;
  }
  if (doc.reasoning_effort === 'minimal') {
    set.reasoning_effort = 'low';
  }
  return set;
}

async function migrateAgents(db, summary) {
  const collection = db.collection('agents');
  const cursor = collection.find(
    {},
    { projection: { id: 1, name: 1, provider: 1, model: 1, model_parameters: 1, versions: 1 } },
  );

  for await (const doc of cursor) {
    const active = migrateAgentSnapshot(doc);
    let versionsChanged = false;
    let versions = doc.versions;
    if (Array.isArray(doc.versions)) {
      versions = doc.versions.map((version) => {
        const result = migrateAgentSnapshot(version);
        versionsChanged ||= result.changed;
        return result.value;
      });
    }

    if (!active.changed && !versionsChanged) continue;
    summary.agents.matched += 1;

    const set = {};
    if (active.changed) {
      if (active.value.model !== doc.model) set.model = active.value.model;
      if (active.value.model_parameters !== doc.model_parameters) {
        set.model_parameters = active.value.model_parameters;
      }
    }
    if (versionsChanged) set.versions = versions;

    if (APPLY) {
      await collection.updateOne({ _id: doc._id }, { $set: set });
      summary.agents.updated += 1;
    }

    summary.details.push({
      collection: 'agents',
      id: doc.id || String(doc._id),
      name: doc.name,
      from: doc.model,
      to: set.model || doc.model,
      versionsChanged,
    });
  }
}

async function migrateConversationCollection(db, collectionName, summaryKey, summary) {
  const collection = db.collection(collectionName);
  const cursor = collection.find(
    { model: { $regex: '^(?:openai/)?gpt-5', $options: 'i' } },
    { projection: { model: 1, endpoint: 1, reasoning_effort: 1, title: 1, presetId: 1, conversationId: 1 } },
  );

  for await (const doc of cursor) {
    const set = migrateConversationLike(doc);
    if (!set) {
      summary[summaryKey].specializedSkipped += 1;
      continue;
    }
    summary[summaryKey].matched += 1;
    if (APPLY) {
      await collection.updateOne({ _id: doc._id }, { $set: set });
      summary[summaryKey].updated += 1;
    }
  }
}

async function verifyNoMappableLegacyModels(db) {
  const remaining = { agents: 0, presets: 0, conversations: 0 };

  const agentCursor = db
    .collection('agents')
    .find({}, { projection: { model: 1, model_parameters: 1, versions: 1 } });
  for await (const doc of agentCursor) {
    const serialized = JSON.stringify({
      model: doc.model,
      model_parameters: doc.model_parameters,
      versions: doc.versions,
    });
    const candidates = serialized.match(/(?:openai\/)?gpt-5[^"\\,}\]]*/gi) || [];
    if (candidates.some((candidate) => mapGpt5Model(candidate.trim()))) {
      remaining.agents += 1;
    }
  }

  for (const [collectionName, key] of [
    ['presets', 'presets'],
    ['conversations', 'conversations'],
  ]) {
    const cursor = db
      .collection(collectionName)
      .find({ model: { $regex: '^(?:openai/)?gpt-5', $options: 'i' } }, { projection: { model: 1 } });
    for await (const doc of cursor) {
      if (mapGpt5Model(doc.model)) remaining[key] += 1;
    }
  }

  return remaining;
}

async function main() {
  await connect();
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection is unavailable.');

  const summary = {
    apply: APPLY,
    mapping: {
      standard: 'GPT-5.x -> gpt-6-luna',
      highTier: 'GPT-5.x Terra/Sol/Pro/Codex/Thinking -> gpt-6-sol',
      nativeOpenAI: 'force useResponsesApi=true for migrated GPT-6 Sol/Luna records',
    },
    agents: { matched: 0, updated: 0 },
    presets: { matched: 0, updated: 0, specializedSkipped: 0 },
    conversations: { matched: 0, updated: 0, specializedSkipped: 0 },
    details: [],
  };

  await migrateAgents(db, summary);
  await migrateConversationCollection(db, 'presets', 'presets', summary);
  await migrateConversationCollection(db, 'conversations', 'conversations', summary);

  const remaining = await verifyNoMappableLegacyModels(db);
  summary.remainingMappable = remaining;

  console.log('[DBM_GPT6_MODEL_MIGRATION]' + JSON.stringify(summary));

  if (APPLY && Object.values(remaining).some((count) => count > 0)) {
    throw new Error(`GPT-6 migration verification failed: ${JSON.stringify(remaining)}`);
  }
}

main()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[DBM_GPT6_MODEL_MIGRATION_ERROR]', error?.stack || error);
    try {
      await mongoose.connection.close();
    } catch {}
    process.exit(1);
  });

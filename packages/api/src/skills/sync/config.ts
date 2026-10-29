function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Restore the authoring spelling of a root path before revalidating resolved AppConfig.
 * The public schema accepts '.' and normalizes it to ''. Keep its rejection of
 * blank authored paths; only this internal validation boundary accepts that output.
 */
export function normalizeSkillSyncConfigPathsForValidation(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.github) || !Array.isArray(raw.github.sources)) {
    return raw;
  }
  return {
    ...raw,
    github: {
      ...raw.github,
      sources: raw.github.sources.map((source: unknown) => {
        if (!isRecord(source) || !Array.isArray(source.paths)) {
          return source;
        }
        return {
          ...source,
          paths: source.paths.map((path: unknown) => (path === '' ? '.' : path)),
        };
      }),
    },
  };
}

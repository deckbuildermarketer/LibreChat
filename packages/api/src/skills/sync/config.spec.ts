import { skillSyncConfigSchema } from 'librechat-data-provider';
import { normalizeSkillSyncConfigPathsForValidation } from './config';

const configWithPaths = (paths: unknown[]) => ({
  github: {
    enabled: true,
    sources: [
      {
        id: 'root-skills',
        owner: 'LibreChat',
        repo: 'skills',
        paths,
        token: '${GITHUB_SKILLS_TOKEN}',
      },
    ],
  },
});

describe('resolved skill-sync root paths', () => {
  it('round-trips the actual schema output repeatedly without mutating scope or credentials', () => {
    const parsed = skillSyncConfigSchema.parse(configWithPaths(['.', 'marketing']));
    const original = JSON.stringify(parsed);
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = skillSyncConfigSchema.parse(
        normalizeSkillSyncConfigPathsForValidation(parsed),
      );
      expect(result).toEqual(parsed);
    }
    expect(JSON.stringify(parsed)).toBe(original);
    expect(parsed?.github?.sources[0].paths).toEqual(['', 'marketing']);
  });

  it.each(['  ', '../private', '/marketing/../private', 'marketing\\private'])(
    'keeps rejecting unsafe or blank authored paths: %p',
    (path) => {
      expect(
        skillSyncConfigSchema.safeParse(
          normalizeSkillSyncConfigPathsForValidation(configWithPaths([path])),
        ).success,
      ).toBe(false);
    },
  );

  it('keeps the public authoring schema rejection of an empty path', () => {
    expect(skillSyncConfigSchema.safeParse(configWithPaths([''])).success).toBe(false);
  });

  it.each([null, [], 'root', { github: { sources: 'invalid' } }, configWithPaths([null])])(
    'does not repair malformed configuration: %p',
    (input) => {
      expect(
        skillSyncConfigSchema.safeParse(normalizeSkillSyncConfigPathsForValidation(input)).success,
      ).toBe(false);
    },
  );
});

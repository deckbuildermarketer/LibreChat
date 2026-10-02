/**
 * DBM fork-specific subagent runtime limits.
 *
 * Only production uses DBM's larger Director -> Program -> Client delegation
 * budget. CI, tests, and development retain LibreChat's upstream defaults so
 * upstream boundary checks remain valid and local development stays aligned
 * with upstream safety limits.
 */
const useDBMProductionLimits =
  typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';

export const MAX_SUBAGENT_DEPTH = useDBMProductionLimits ? 10 : 5;
export const MAX_SUBAGENT_GRAPH_NODES = useDBMProductionLimits ? 300 : 50;
export const MAX_SUBAGENT_RUN_CONFIGS = useDBMProductionLimits ? 300 : 100;

/**
 * DBM fork-specific subagent runtime limits.
 *
 * Production keeps DBM's larger Director -> Program -> Client delegation
 * budget. Test mode deliberately retains LibreChat's upstream defaults so the
 * upstream boundary tests remain valid and future upstream syncs do not need
 * invasive edits to their large test suites.
 */
const useUpstreamTestLimits =
  typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';

export const MAX_SUBAGENT_DEPTH = useUpstreamTestLimits ? 5 : 10;
export const MAX_SUBAGENT_GRAPH_NODES = useUpstreamTestLimits ? 50 : 300;
export const MAX_SUBAGENT_RUN_CONFIGS = useUpstreamTestLimits ? 100 : 300;

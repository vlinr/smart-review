/**
 * Whether static rule findings should be passed to AI as context hints.
 * `includeStaticHints` is the primary flag; `useStaticHints` remains as a backward-compatible alias.
 */
export function shouldIncludeStaticHints(config = {}) {
  const ai = config?.ai || config || {};
  return ai.includeStaticHints === true || ai.useStaticHints === true;
}

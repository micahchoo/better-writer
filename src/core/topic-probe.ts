/**
 * Topic probes: a small fixed list of content-level prompts for when the
 * writer is stuck on WHAT to say, or when a seed question cannot be reshaped
 * against the window (see agent_sketch.md — these live in the agent, not the
 * seed bank). Verbatim from agent_sketch.md.
 */
export const TOPIC_PROBES: readonly string[] = [
 'What is actually at stake here?',
 'What is the strongest counter-position?',
 'What would a reader not yet know need to be told first?',
 'What changed between the start of this passage and its end?',
 'What does the speaker want here, and what stands in the way?',
 'What is this passage really about, in one plain sentence?',
];

/**
 * Deterministic probe pick: index = textWindow.length % TOPIC_PROBES.length.
 * Deliberately deterministic (not random) so the same window always yields
 * the same probe — stable across retries and unit-testable — while the
 * modulo spreads short windows evenly across the list.
 */
export function topicProbe(textWindow: string): string {
 return TOPIC_PROBES[textWindow.length % TOPIC_PROBES.length];
}

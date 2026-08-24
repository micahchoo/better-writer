// Lexicon derivations for the deterministic-window-metrics targeting experiment.
//
// Vocabulary is organized by craft-topic pools, whose names double as the
// ground-truth topic strings used by the orchestrator fixtures
// (scripts/experiment/fixtures.ts). Each axis maps to one or more pools; each
// pool is a case-insensitive, regex-safe keyword list (literal words/short
// phrases; apostrophes and internal spaces are literal).
//
// A seed is a lexical hit when ANY keyword of the queried pool appears in
// seed.question (with seed.source.quote consulted as a tiebreak field).
//
// Deliberate bias: recall over precision. We would rather over-match a topic
// pool than starve the treated arm, because pullTreated falls back to a
// uniform draw when the matched pool is small. The match counts in the
// comments were measured against the full 1709-seed bank (seeds/bank.jsonl);
// arms.test.ts recomputes them at runtime and prints the per-axis table.

export const AXES = [
  'dialogue',
  'rhythm',
  'hedge',
  'filter-word',
  'nominal',
  'opening-position',
  'closing-position',
] as const

export type Axis = (typeof AXES)[number]

// topic pool -> keyword list (pool names match fixture trueTopics vocabulary)
export const TOPIC_POOLS: Record<string, string[]> = {
  // dialogue — spoken-interaction vocabulary (313 seeds)
  dialogue: [
    'dialogue', 'dialog', 'speak', 'speaking', 'speech', 'said', 'says',
    'saying', 'quotation', 'quoted', 'conversation', 'talk', 'talking',
    'voice', 'line of dialogue', 'overheard', 'chat', 'exchange',
  ],
  // character — characters and their portrayal (650 seeds)
  character: [
    'character', 'characters', "character's", 'person', 'people',
    'protagonist', "protagonist's", 'hero', 'characterization', 'portray',
    'cast of',
  ],
  // sentence-rhythm-wordchoice — rhythm, word choice, hedging/filler (537 seeds)
  'sentence-rhythm-wordchoice': [
    // rhythm / sentence structure
    'sentence', 'sentences', 'rhythm', 'vary your sentence', 'vary the',
    'variation', 'pace', 'pacing', 'cadence', 'flow', 'staccato', 'fragment',
    'run-on', 'parallel', 'periodic', 'cumulative', 'syntax', 'prose rhythm',
    'rhythmic',
    // word choice
    'word', 'words', 'word choice', 'diction', 'precise', 'concrete word',
    'strong verb', 'verbs', 'noun', 'nouns', 'adjective', 'adjectives',
    'specificity', 'exact', 'evocative', 'plain',
    // hedging / filler / weak words
    'hedge', 'hedging', 'weaken', 'weakening', 'weak', 'filler', 'vague',
    'vagueness', 'adverb', 'adverbs', 'intensifier', 'qualifier', 'just',
    'very', 'really', 'quite', 'actually', 'suddenly', 'literally', 'truly',
    'extremely', 'somewhat', 'sort of', 'kind of', 'passive',
  ],
  // revision-cut-process — cutting and revision (211 seeds)
  'revision-cut-process': [
    'cut', 'cutting', 'cuts', 'revise', 'revising', 'revision', 'trim',
    'tighten', 'tightening', 'delete', 'remove', 'condense', 'streamline',
    'eliminate', 'reduce', 'prune', 'slash', 'boil down',
  ],
  // show-tell-dramatize — showing vs telling (614 seeds)
  'show-tell-dramatize': [
    'show', 'tell', 'showing', 'telling', 'dramatize', 'dramatizing',
    'dramatized', 'dramatic', 'scene', 'scenes', 'imply', 'implied',
    'suggest', 'suggests', 'suggesting', 'inference', 'infer', 'concrete',
    'sensory', 'reveal', 'revealing', 'specific detail', 'details', 'anchor',
    'ground the reader',
  ],
  // pov-narrator-tense — point of view and tense (189 seeds)
  'pov-narrator-tense': [
    'point of view', 'pov', 'perspective', 'narrator', 'narrate', 'narrated',
    'narration', 'tense', 'past tense', 'present tense', 'first person',
    'third person', 'second person', 'limited', 'omniscient', 'viewpoint',
    'reliable narrator', 'unreliable',
  ],
  // opening-beginning (184 seeds)
  'opening-beginning': [
    'opening', 'begin', 'begins', 'beginning', 'start', 'starts', 'started',
    'starting', 'first line', 'first sentence', 'first paragraph',
    'first page', 'hook', 'introduce', 'introduction', 'outset', 'way in',
    'open with', 'get going', 'launch',
  ],
  // ending-closing (74 seeds)
  'ending-closing': [
    'ending', 'ends', 'ending of', 'final', 'conclusion', 'conclude',
    'resolve', 'resolution', 'last line', 'last sentence', 'last paragraph',
    'wrap up', 'payoff', 'denouement', 'close the', 'closes',
    'land the ending', 'tie up', 'closure',
  ],
  // scene-setting — setting / landscape / description craft (379 seeds)
  'scene-setting': [
    // setting / place
    'setting', 'settings', 'place', 'places', 'location', 'locale',
    'where the', 'set in', 'space', 'room', 'interior', 'exterior',
    // landscape / built environment
    'landscape', 'scenery', 'terrain', 'geography', 'land', 'field',
    'fields', 'street', 'road', 'buildings', 'house', 'weather', 'light',
    'time of day', 'season',
    // description craft
    'describe', 'describing', 'description', 'depict', 'depicting',
    'evoke', 'evoking', 'sensory detail', 'visual', 'image', 'imagery',
    'physical detail', 'exposition', 'establish the setting',
    // mood / sense of place
    'mood', 'ambience', 'ambiance', 'sense of place',
  ],
}

// axis -> topic pools it draws from
export const AXIS_POOLS: Record<Axis, string[]> = {
  dialogue: ['dialogue', 'character'],
  rhythm: ['sentence-rhythm-wordchoice', 'revision-cut-process'],
  hedge: ['sentence-rhythm-wordchoice', 'revision-cut-process'],
  nominal: ['sentence-rhythm-wordchoice', 'revision-cut-process'],
  'filter-word': ['show-tell-dramatize', 'pov-narrator-tense'],
  'opening-position': ['opening-beginning'],
  'closing-position': ['ending-closing'],
}

// axis -> flattened keyword list (the exported lexicon map)
export const LEXICONS: Record<Axis, string[]> = Object.fromEntries(
  AXES.map((axis) => [axis, AXIS_POOLS[axis].flatMap((pool) => TOPIC_POOLS[pool])]),
) as Record<Axis, string[]>

/**
 * Labeled fixture windows for the ruler-targeting A/B experiment.
 * Ground truth by construction: each passage was written to exhibit one
 * dominant craft axis (or none, for CONTROL entries). Orchestrator-owned;
 * both experiment arms draw seeds against these.
 */

export interface Fixture {
	name: string;
	genre: string;
	/** Raw window text exactly as buildAskWindow would produce it. */
	window: string;
	/** Axes the rulers are expected to flag (scoring targets). */
	expectedFlags: string[];
	/** True craft topics, named in ArmsBuilder lexicon vocabulary. */
	trueTopics: string[];
	/** Intervention the passage structurally calls for (verb-alignment scoring). */
	impliedVerbs: string[];
	positionContext?: { sectionBlockCount: number; blockIndexInSection: number };
}

export const FIXTURES: Fixture[] = [
	{
		name: 'dialogue-scene',
		genre: 'fiction',
		window:
			'"You said you\'d be here at six," Marta said.\n\n"I know what I said."\n\n"That\'s not an answer."\n\n"It\'s the only one I have tonight." He turned his glass a quarter turn on the bar and watched the ring it left. "Ask me again tomorrow."\n\n"Tomorrow you\'ll have another only answer." She picked up her coat. "Your brother called, by the way. He wants the money by Friday."\n\n"Of course he does."\n\n"Don\'t \'of course\' me. What did you promise him?"\n\n"Nothing I can explain over a drink."\n\n"Then explain it somewhere else." She left the coat on the stool.',
		expectedFlags: ['dialogue'],
		trueTopics: ['dialogue', 'character'],
		impliedVerbs: ['elaborate', 'rewrite'],
	},
	{
		name: 'hedge-criticism',
		genre: 'creative-nonfiction',
		window:
			'I think that maybe the whole experience was perhaps somewhat formative, or at least it might have been in some ways. It could be argued that moving to the city probably changed how I saw things, though I suppose it\'s possible I\'m overstating it. There were, more or less, a number of moments that seemed sort of significant, and looking back I guess they kind of were, relatively speaking. It\'s hard to say for sure, honestly, whether any given day actually mattered, but I do feel like something shifted, maybe. The winter was pretty cold, presumably colder than usual, and I remember thinking that this might possibly be the thing people meant when they talked about growing up.',
		expectedFlags: ['hedge', 'rhythm'],
		trueTopics: ['sentence-rhythm-wordchoice', 'revision-cut-process'],
		impliedVerbs: ['cut', 'rephrase'],
	},
	{
		name: 'nominalized-essay',
		genre: 'essay',
		window:
			'The implementation of the policy resulted in the elimination of ambiguity regarding the allocation of resources. An examination of the documentation reveals the utilization of inconsistent terminology across departments, and the standardization of definitions would facilitate improvement in interdepartmental communication. Recognition of this divergence is a prerequisite for the construction of a durable resolution. The continuation of the present arrangement carries the likelihood of deterioration in morale, and its prevention requires the establishment of clearer expectations. Observation of comparable organizations suggests that simplification produces elevation of output, though confirmation awaits the completion of additional measurement.',
		expectedFlags: ['nominal', 'rhythm'],
		trueTopics: ['sentence-rhythm-wordchoice', 'revision-cut-process'],
		impliedVerbs: ['rephrase', 'rewrite'],
	},
	{
		name: 'filter-word-telling',
		genre: 'fiction',
		window:
			'I felt the cold seep through my jacket as I walked toward the shed. I noticed that the door was open, and I realized someone had been there. I heard a noise from inside, so I wondered whether I should go in. I watched the shadows move along the wall, and I sensed that something was wrong. When I stepped inside, I saw the tools scattered on the floor. I felt my heart begin to race, and I knew that whoever did this had left in a hurry. I remembered the latch being broken last spring, and I wondered if Dad would notice it too.',
		expectedFlags: ['filter-word'],
		trueTopics: ['show-tell-dramatize', 'pov-narrator-tense'],
		impliedVerbs: ['rewrite', 'elaborate'],
	},
	{
		name: 'flat-rhythm',
		genre: 'fiction',
		window:
			'The harbor was busy in the morning. Boats left the dock at first light. The fishermen carried their gear down the pier. Gulls circled above the water. The market opened at seven. Vendors arranged their fish on beds of ice. Tourists arrived around nine. They photographed the boats and bought coffee. By noon the sun sat high over the bay. The tide pulled back from the seawall. Children chased crabs along the rocks. The afternoon boats returned at four. Their holds were mostly full.',
		expectedFlags: ['rhythm'],
		trueTopics: ['sentence-rhythm-wordchoice', 'revision-cut-process'],
		impliedVerbs: ['cut', 'rewrite'],
	},
	{
		name: 'control-memoir-sensory',
		genre: 'memoir',
		window:
			'Grandmother measured nothing. Flour came up to the second knuckle of her middle finger, salt to the curve of her palm, and she pressed her thumb into the dough to read it like weather. Her kitchen faced east, so the mornings arrived as one long slab of light across the counter, dust hanging in it like a held breath. I sat on the stool with my chin level with the flour bin and watched her wrists do the work hands normally would. Years later, measuring cups in my own kitchen, I still catch myself flattening the sugar with a forefinger and wondering whose gesture I borrowed.',
		expectedFlags: [],
		trueTopics: ['character'],
		impliedVerbs: [],
	},
	{
		name: 'opening-paragraph',
		genre: 'fiction',
		window:
			'The letter arrived on a Tuesday, which mattered because Tuesdays were when the town burned its trash. Ruth collected it from the box in her nightgown, slit it with a paring knife at the kitchen table, and read it twice before the kettle screamed. Outside, black smoke stood up from the barrel behind the Hendricks place, perfectly straight, as if drawn with a rule. Nobody in Callahan had received a letter with a Washington postmark since the war, and this one was hand-addressed. She put it under the sugar tin and did not tell Wren until after supper.',
		expectedFlags: ['opening-position'],
		trueTopics: ['opening-beginning'],
		impliedVerbs: ['concept-form', 'elaborate'],
		positionContext: { sectionBlockCount: 6, blockIndexInSection: 0 },
	},
	{
		name: 'closing-paragraph',
		genre: 'creative-nonfiction',
		window:
			'In the end I kept neither the letters nor the photographs, which surprises people who know the story. But those objects belonged to the version of us that needed proof, and I no longer did. What stayed was smaller and harder to lose: the habit of checking the sky before crossing the bridge, the way I still count exits in any room, the reflex of gratitude that arrives unbidden when a phone rings and it isn\'t bad news. My brother says you don\'t get over a thing like that, you just get farther from it. He\'s been right about almost everything else, so I let him have this too.',
		expectedFlags: ['closing-position'],
		trueTopics: ['ending-closing'],
		impliedVerbs: ['transition', 'elaborate'],
		positionContext: { sectionBlockCount: 5, blockIndexInSection: 4 },
	},
	{
		name: 'markdown-cluttered',
		genre: 'essay',
		window:
			'# Field Notes from the Rim Trail\n\nThe [trail map](https://example.com/rim-trail-full-map-with-elevations-and-water-stops-updated-seasonally) marks three water sources between the trailhead and the saddle, though by late August the first has reliably become a `dry_basin` mud pan cracked like old glaze. We counted switchbacks instead of miles — forty-one, by Elena\'s tally, each one lifting the desert another notch. See ![switchback photo](https://example.com/img/switchbacks-aerial-drone-shot.jpg) for the view we kept failing to photograph well.\n\n*Note:* distances below are **approximate**, gathered from a phone that gave up at altitude.\n\n> Everyone promises the saddle is close. Everyone is lying kindly.',
		expectedFlags: [],
		trueTopics: ['character'],
		impliedVerbs: [],
	},
	{
		name: 'control-description',
		genre: 'fiction',
		window:
			'The house had settled unevenly over its hundred years, so the floors rolled like slow water toward the kitchen. Wallpaper in the front room showed a pattern of faded birds, printed sometime before the wars, peeling at the corners where generations of radiators had breathed on it. In summer the screen door clapped all day with the comings and goings of cousins. Beneath the stairwell a door opened onto a closet that smelled of cedar and pencil shavings, and inside it, on the top shelf, sat the shoebox nobody was supposed to find.',
		expectedFlags: [],
		trueTopics: ['scene-setting'],
		impliedVerbs: [],
	},
];

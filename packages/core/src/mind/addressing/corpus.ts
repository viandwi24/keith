// A labelled transcript corpus for the addressing detector (phase 5, S-6), over the Tony / Pepper /
// Rhodey cast. Test-only.
//
// `by` is the rule pass's verdict. `addressed` is the truth. Lines the rules can't decide are
// `by: 'unsure'`: small talk between humans (truth false, so "unsure = not addressed" is right)
// and genuinely ambiguous lines (truth true or false), which only the classifier can get right.

import type { AddressingVerdict } from '../types.ts'
import type { Speaker } from './testing.ts'

export type CorpusLine = {
  id: string
  /** Current participants; the whole cast by default. */
  participants?: string[]
  /** Visible messages before the input, oldest first. */
  recent: [Speaker, string][]
  author: Exclude<Speaker, 'keith'>
  text: string
  /** The rule pass's verdict. */
  by: AddressingVerdict['by']
  /** Whether the line is addressed to the Mind (the truth). */
  addressed: boolean
}

export const CORPUS: CorpusLine[] = [
  // The Mind's name, as a word, in any letter case
  {
    id: 'name-leading',
    recent: [],
    author: 'tony',
    text: "Keith, what's the weather over Malibu?",
    by: 'name',
    addressed: true,
  },
  {
    id: 'name-hey',
    recent: [],
    author: 'pepper',
    text: 'hey keith can you book a table for three',
    by: 'name',
    addressed: true,
  },
  {
    id: 'name-at',
    recent: [['tony', 'we need the flight plan']],
    author: 'rhodey',
    text: '@keith pull up the flight plan',
    by: 'name',
    addressed: true,
  },
  {
    id: 'name-shout',
    recent: [],
    author: 'tony',
    text: 'KEITH. Status report.',
    by: 'name',
    addressed: true,
  },
  {
    id: 'name-thanks',
    recent: [['keith', 'The jet is fuelled.']],
    author: 'pepper',
    text: 'Thanks Keith!',
    by: 'name',
    addressed: true,
  },
  {
    id: 'name-possessive',
    recent: [['rhodey', 'these numbers look wrong']],
    author: 'tony',
    text: "Pull up Keith's numbers from yesterday",
    by: 'name',
    addressed: true,
  },
  {
    id: 'name-mixed-case',
    recent: [],
    author: 'rhodey',
    text: 'kEiTh are you there',
    by: 'name',
    addressed: true,
  },
  {
    id: 'name-wins-over-other',
    recent: [],
    author: 'tony',
    text: 'Rhodey, ask Keith for the coordinates',
    by: 'name',
    addressed: true,
  },
  {
    id: 'name-mid-sentence',
    recent: [['pepper', 'who has the guest list?']],
    author: 'rhodey',
    text: 'I think keith has it, right keith?',
    by: 'name',
    addressed: true,
  },

  // Another human named first
  {
    id: 'other-comma',
    recent: [['keith', 'Here is the summary.']],
    author: 'tony',
    text: 'Pepper, can you send me the contract?',
    by: 'other_human',
    addressed: false,
  },
  {
    id: 'other-colon',
    recent: [],
    author: 'pepper',
    text: 'Rhodey: ETA?',
    by: 'other_human',
    addressed: false,
  },
  {
    id: 'other-at',
    recent: [['keith', 'Anything else?']],
    author: 'rhodey',
    text: '@tony you there?',
    by: 'other_human',
    addressed: false,
  },
  {
    id: 'other-hey',
    recent: [],
    author: 'tony',
    text: 'hey Pepper, dinner tonight?',
    by: 'other_human',
    addressed: false,
  },
  {
    id: 'other-dash',
    recent: [],
    author: 'pepper',
    text: 'tony - the board meeting moved to 3',
    by: 'other_human',
    addressed: false,
  },
  {
    id: 'other-after-mind-question',
    recent: [
      ['tony', 'Keith, plan a route to Nevada'],
      ['keith', 'Should I avoid the storm over Reno?'],
    ],
    author: 'rhodey',
    text: 'Tony, your call.',
    by: 'other_human',
    addressed: false,
  },
  {
    id: 'other-lowercase',
    recent: [['keith', 'Done.']],
    author: 'tony',
    text: 'rhodey! you made it?',
    by: 'other_human',
    addressed: false,
  },

  // A reply to the Mind's question (D6: the latest message is the Mind's and ended with "?")
  {
    id: 'reply-short',
    recent: [
      ['tony', 'Keith, book the jet.'],
      ['keith', 'For how many people?'],
    ],
    author: 'tony',
    text: 'Three.',
    by: 'reply',
    addressed: true,
  },
  {
    id: 'reply-other-author',
    recent: [['keith', 'Do you want the report now or after the meeting?']],
    author: 'pepper',
    text: 'After the meeting, please',
    by: 'reply',
    addressed: true,
  },
  {
    id: 'reply-yes',
    recent: [['keith', 'Should I add Rhodey to the booking?']],
    author: 'rhodey',
    text: 'yes',
    by: 'reply',
    addressed: true,
  },
  {
    id: 'reply-quoted',
    recent: [['keith', 'Did you mean "Mark 50?"']],
    author: 'tony',
    text: 'yeah that one',
    by: 'reply',
    addressed: true,
  },
  {
    id: 'reply-go-ahead',
    recent: [
      ['pepper', 'the deck is ready'],
      ['keith', 'Shall I send it to the whole team?'],
    ],
    author: 'rhodey',
    text: 'sure go ahead',
    by: 'reply',
    addressed: true,
  },

  // An open question while the Mind is in the conversation
  {
    id: 'question-follow-up',
    recent: [
      ['tony', 'Keith, status of the suit'],
      ['keith', 'The suit is at 80% charge.'],
    ],
    author: 'tony',
    text: "How long until it's full?",
    by: 'question',
    addressed: true,
  },
  {
    id: 'question-third-back',
    recent: [
      ['keith', 'Flight booked.'],
      ['pepper', 'nice'],
      ['rhodey', 'finally'],
    ],
    author: 'tony',
    text: 'what time do we land',
    by: 'question',
    addressed: true,
  },
  {
    id: 'question-aux-opening',
    recent: [
      ['keith', 'Here are three options.'],
      ['tony', 'hmm'],
    ],
    author: 'pepper',
    text: 'can you compare the prices',
    by: 'question',
    addressed: true,
  },
  {
    id: 'question-mark-only',
    recent: [['keith', 'The drones are back at base.']],
    author: 'rhodey',
    text: 'all of them?',
    by: 'question',
    addressed: true,
  },

  // Small talk between humans: the rules can't tell, and "unsure" (not addressed) is right
  {
    id: 'talk-same',
    recent: [
      ['tony', 'Anyone hungry?'],
      ['pepper', 'Starving'],
    ],
    author: 'rhodey',
    text: 'Same here',
    by: 'unsure',
    addressed: false,
  },
  {
    id: 'talk-brutal',
    recent: [['pepper', 'that meeting was brutal']],
    author: 'tony',
    text: 'tell me about it',
    by: 'unsure',
    addressed: false,
  },
  {
    id: 'talk-safe-flight',
    recent: [['rhodey', 'Landing in 10']],
    author: 'pepper',
    text: 'Safe flight!',
    by: 'unsure',
    addressed: false,
  },
  { id: 'talk-lol', recent: [], author: 'tony', text: 'lol', by: 'unsure', addressed: false },
  {
    id: 'talk-question-no-mind',
    recent: [['tony', "who's bringing the drinks?"]],
    author: 'rhodey',
    text: 'Who do you think?',
    by: 'unsure',
    addressed: false,
  },
  {
    id: 'talk-mind-long-ago',
    recent: [
      ['keith', 'Here is the agenda.'],
      ['tony', 'item 3 again'],
      ['pepper', 'every single week'],
      ['rhodey', 'classic'],
    ],
    author: 'pepper',
    text: 'haha yes',
    by: 'unsure',
    addressed: false,
  },
  {
    id: 'talk-keithley',
    recent: [['rhodey', 'the meter reads zero']],
    author: 'tony',
    text: 'The Keithley meter is broken again',
    by: 'unsure',
    addressed: false,
  },
  {
    id: 'talk-keithian',
    recent: [],
    author: 'rhodey',
    text: 'keithian philosophy is overrated',
    by: 'unsure',
    addressed: false,
  },
  {
    id: 'talk-named-statement',
    recent: [['keith', 'The car is outside.']],
    author: 'pepper',
    text: 'Rhodey is late again',
    by: 'unsure',
    addressed: false,
  },
  {
    id: 'talk-names-in-question',
    recent: [['keith', 'Done.']],
    author: 'tony',
    text: 'Is Rhodey coming too?',
    by: 'unsure',
    addressed: false,
  },

  // Ambiguous: only the classifier can tell
  {
    id: 'ambiguous-ack',
    recent: [['keith', 'The jet is booked for 9 am.']],
    author: 'tony',
    text: 'great',
    by: 'unsure',
    addressed: false,
  },
  {
    id: 'ambiguous-order-after-human',
    recent: [
      ['keith', 'Should I book it?'],
      ['pepper', 'Tony, you decide'],
    ],
    author: 'tony',
    text: 'Book it',
    by: 'unsure',
    addressed: true,
  },
  {
    id: 'ambiguous-do-it',
    recent: [['keith', 'I can reroute the drones.']],
    author: 'tony',
    text: 'do it now',
    by: 'unsure',
    addressed: true,
  },
  {
    id: 'ambiguous-question-mind-long-ago',
    recent: [
      ['keith', 'Booked.'],
      ['tony', 'cool'],
      ['pepper', 'ok'],
      ['rhodey', 'lol'],
    ],
    author: 'tony',
    text: 'what time is it in Tokyo?',
    by: 'unsure',
    addressed: true,
  },
  {
    id: 'ambiguous-and-tomorrow',
    recent: [['keith', 'The forecast shows rain at noon.']],
    author: 'rhodey',
    text: 'and tomorrow',
    by: 'unsure',
    addressed: true,
  },
  {
    id: 'ambiguous-remind',
    recent: [],
    author: 'tony',
    text: 'remind me to call the lawyers at 5',
    by: 'unsure',
    addressed: true,
  },
  {
    id: 'ambiguous-find',
    recent: [['pepper', 'we need a venue']],
    author: 'tony',
    text: 'find us a quiet place near the office',
    by: 'unsure',
    addressed: true,
  },
  {
    id: 'ambiguous-second-one',
    recent: [['keith', 'I found two venues.']],
    author: 'pepper',
    text: 'the second one looks good',
    by: 'unsure',
    addressed: true,
  },

  // One human left in the group: everything is addressed (D14)
  {
    id: 'single-after-leaving',
    participants: ['Tony'],
    recent: [
      ['pepper', 'bye all'],
      ['rhodey', 'later'],
    ],
    author: 'tony',
    text: 'ok, and the fuel',
    by: 'single_human',
    addressed: true,
  },
  {
    id: 'single-small-talk',
    participants: ['Pepper'],
    recent: [],
    author: 'pepper',
    text: 'lol',
    by: 'single_human',
    addressed: true,
  },
  {
    id: 'single-names-other',
    participants: ['Rhodey'],
    recent: [['tony', 'gotta run']],
    author: 'rhodey',
    text: 'Tony, wait!',
    by: 'single_human',
    addressed: true,
  },
]

// A known-good config and draft. The self-test and the tests prove the gate
// passes this and catches every broken shape made from it.
import { DEFAULTS } from './config.mjs';

export const FIXTURE_CONFIG_RAW = {
  schema: 'search-loop-config-v1',
  site: 'example.com',
  base_url: 'https://example.com',
  site_name: 'Example Planner',
  audience: 'busy founders who plan their week with a simple system',
  voice: 'plain, warm, direct; short sentences; no hype',
  topics: ['weekly planning', 'daily planning routine'],
  action: { label: 'Get the Example Planner', url: '/download' },
  allowed_link_targets: ['https://example.com'],
  output: { dir: 'questions', format: 'dir-index', url_prefix: '/questions/' },
  protected_paths: ['download.html'],
  template: { og_image: { url: 'https://example.com/og.png', width: 1200, height: 630 } },
};

export function fixtureConfig(root = '/nonexistent') {
  return { ...DEFAULTS, ...FIXTURE_CONFIG_RAW, cap: { ...DEFAULTS.cap }, distinct: { ...DEFAULTS.distinct }, related: { ...DEFAULTS.related }, find: { ...DEFAULTS.find }, root, ledger_dir: 'data/search-loop' };
}

const para = (topic, n) => `${topic} works best when you keep it small and repeatable. Pick one block of time, write down the three outcomes that matter, and leave space for the work that always shows up unplanned. ` +
  `When the week goes sideways, you do not start over; you move the unfinished outcome to the next open block and keep going. A plan you can restart in two minutes is a plan you will actually use, ` +
  `and the habit of looking at it at the same time each day matters more than the tool you write it in. Section ${n} closes with one question to ask yourself before you begin the next block of work today.`;

export function fixtureDraft() {
  return {
    h1: 'How do I plan my week as a busy founder?',
    title_lead: 'How to plan your week as a founder',
    meta_description: 'Plan your week by choosing three outcomes, blocking time for each, and reviewing on Friday. A simple routine busy founders can restart in two minutes.',
    direct_answer: 'Weekly planning is a short routine where you choose the three outcomes that matter most this week, give each one a block of time on your calendar, and review what happened on Friday so next week starts from what is true rather than from a blank page.',
    sections: [1, 2, 3, 4].map((n) => ({ heading: ['What should a weekly plan include?', 'When should you plan the week?', 'What if the week falls apart?', 'How do you review the week?'][n - 1], paragraphs: [para('Weekly planning', n), para('A daily planning routine', n)], ...(n === 1 ? { bullets: ['Three outcomes for the week', 'One block of time for each', 'A Friday review'] } : {}) })),
    faq: [
      { q: 'How long should weekly planning take?', a: 'Weekly planning should take about twenty minutes once you have a routine. Look at last week, choose three outcomes, block time for each, and stop. If it takes longer, you are planning tasks instead of outcomes, and the plan will be too heavy to restart.' },
      { q: 'Is a daily plan still needed?', a: 'Yes, but it can be short. Each morning, look at the weekly outcomes, pick the one block you will protect today, and write the first action. The weekly plan sets direction, and the daily plan turns it into the next concrete thing you do.' },
      { q: 'What tool should I use?', a: 'Use the tool you already open every day, whether that is a calendar, a notebook or a notes app. The routine matters far more than the tool. Switching tools often feels productive, but it usually resets the habit you were trying to build.' },
      { q: 'What do I do after a missed week?', a: 'Do not try to catch up on everything. Look at what still matters, carry the most important outcome into this week, and drop the rest without guilt. A missed week is information about your load, not a reason to rebuild your whole system.' },
    ],
    facts: [{ claim: 'The ISO 8601 standard numbers weeks so that each week starts on a Monday.', source_url: 'https://en.wikipedia.org/wiki/ISO_week_date', source_name: 'Wikipedia', verified: true }, { claim: 'The Gregorian calendar is the most widely used civil calendar.', source_url: 'https://en.wikipedia.org/wiki/Gregorian_calendar', source_name: 'Wikipedia', verified: true }],
  };
}

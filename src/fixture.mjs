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

// Eight distinct paragraphs: a good draft never repeats a sentence (v1.7.1 keeps a repeat once only).
const PARAS = [
  'Weekly planning works best when you keep it small and repeatable. Pick one block of time on Sunday or Monday, write down the three outcomes that matter, and leave space for the work that always shows up unplanned. A short list you finish beats a long list you abandon by Wednesday, so keep each outcome concrete enough that you would know on Friday whether it happened. Write the outcomes where you will see them, such as the top of your calendar or a sticky note on the monitor, so they stay in view during the busiest days.',
  'A daily planning routine is the smaller partner of the weekly plan. Each morning you look at the three outcomes, choose the one block you will protect, and write the first action you will take inside it. Keep the daily note to a few lines; its job is to point at the next step, not to restate the whole week again. On days packed with calls, the daily note may only name one task, and that is enough to keep the week moving in the right direction.',
  'Plan the week at the same time every week, ideally before the first meeting on Monday or at the end of Friday. The exact hour matters less than keeping it fixed, because a fixed slot turns planning into a habit that survives busy weeks. Founders who travel often put the slot on the calendar as a recurring event so it moves with them. If you share a calendar with a cofounder, agree on the slot together so neither of you books over it without noticing.',
  'Mornings work for many people because the inbox has not yet set the agenda. If your mornings are taken by school runs or early calls, pick a quiet half hour later in the day instead. Protect that half hour the way you would protect a customer call, and move it rather than skip it when something urgent lands. Parents with young children often find that the evening, after bedtime, is the only calm window, and that works just as well.',
  'When the week falls apart, you do not start over. You move the unfinished outcome to the next open block and keep going. A plan you can restart in two minutes is a plan you will actually use, while a plan that needs an hour of rework after every surprise quietly stops being used by the second month. Treat the restart as part of the system rather than as a failure, because every real week includes at least one surprise.',
  'Unplanned work is normal for a founder, so build room for it on purpose. Leave at least one open block each day and treat it as a buffer for hiring questions, customer fires and investor follow-ups. If the buffer stays empty, use it for the outcome that is furthest behind instead of adding new tasks. Teams that copy this habit tend to find their own weekly meetings get shorter, since fewer issues arrive as emergencies.',
  'Review the week on Friday afternoon in about fifteen minutes. Mark each outcome as done, partly done or dropped, and write one line on why. Those short notes show patterns over a month, such as meetings that always overrun, which helps you plan the next week from what really happens rather than from hope. Keep the notes in one place, whether a document or a notebook, so you can scan several weeks at a glance before planning.',
  'End the Friday session by choosing next week\'s first outcome while the context is still fresh. That single decision makes Monday planning faster and keeps momentum across the weekend. Over time the Friday notes become a simple record of what the company worked on, which is useful when you write an investor update or a team summary. Many founders also share the chosen outcome with their team on Monday, which makes priorities clear without a long meeting.',
];
const para = (_topic, n, k) => PARAS[(n - 1) * 2 + k];

export function fixtureDraft() {
  return {
    h1: 'How do I plan my week as a busy founder?',
    title_lead: 'How to plan your week as a founder',
    meta_description: 'Plan your week by choosing three outcomes, blocking time for each, and reviewing on Friday. A simple routine busy founders can restart in two minutes.',
    direct_answer: 'Weekly planning is a short routine where you choose the three outcomes that matter most this week, give each one a block of time on your calendar, and review what happened on Friday so next week starts from what is true rather than from a blank page.',
    sections: [1, 2, 3, 4].map((n) => ({ heading: ['What should a weekly plan include?', 'When should you plan the week?', 'What if the week falls apart?', 'How do you review the week?'][n - 1], paragraphs: [para('Weekly planning', n, 0), para('A daily planning routine', n, 1)], ...(n === 1 ? { bullets: ['Three outcomes for the week', 'One block of time for each', 'A Friday review'] } : {}) })),
    faq: [
      { q: 'How long should weekly planning take?', a: 'Weekly planning should take about twenty minutes once you have a routine. Look at last week, choose three outcomes, block time for each, and stop. If it takes longer, you are planning tasks instead of outcomes, and the plan will be too heavy to restart.' },
      { q: 'Is a daily plan still needed?', a: 'Yes, but it can be short. Each morning, look at the weekly outcomes, pick the one block you will protect today, and write the first action. The weekly plan sets direction, and the daily plan turns it into the next concrete thing you do.' },
      { q: 'What tool should I use?', a: 'Use the tool you already open every day, whether that is a calendar, a notebook or a notes app. The routine matters far more than the tool. Switching tools often feels productive, but it usually resets the habit you were trying to build.' },
      { q: 'What do I do after a missed week?', a: 'Do not try to catch up on everything. Look at what still matters, carry the most important outcome into this week, and drop the rest without guilt. A missed week is information about your load, not a reason to rebuild your whole system.' },
    ],
    facts: [{ claim: 'The ISO 8601 standard numbers weeks so that each week starts on a Monday.', source_url: 'https://en.wikipedia.org/wiki/ISO_week_date', source_name: 'Wikipedia', verified: true }, { claim: 'The Gregorian calendar is the most widely used civil calendar.', source_url: 'https://en.wikipedia.org/wiki/Gregorian_calendar', source_name: 'Wikipedia', verified: true }],
  };
}

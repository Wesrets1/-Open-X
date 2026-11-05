/* ============================================================
   demo.js — offline generator

   Produces chat-completion-shaped responses so demo mode exercises
   the exact same code paths as a real endpoint, including tool calls.
   ============================================================ */

import { rng, uid } from './util.js';

/* ---------------- phrase banks ---------------- */

const POSTS = {
  flex: [
    'just hit {n} followers and honestly? i earned this 😌',
    'booked the thing. doing the thing. not telling you the thing.',
    'my {item} arrived and my entire personality has reset',
    'not to brag but i woke up before 9 today',
    'new {item}. new me. same chaos.',
  ],
  vague: [
    'some of you are not ready for this conversation',
    'i keep thinking about {topic}',
    'anyway.',
    'we don\'t talk about {topic} enough',
    'if you know you know 🤐',
  ],
  drama: [
    'the way i just found out what happened with {topic} and i am NOT okay',
    'so we\'re just going to pretend {topic} never happened?',
    'some people really think {topic} is a personality trait huh',
    'im not saying anything but im saying something about {topic}',
  ],
  wholesome: [
    'made {item} from scratch and it came out genuinely good for once',
    'small win: {topic}. that\'s it. that\'s the post.',
    'reminder that rest is productive too 🫶',
    'someone was kind to me today for no reason and i have not stopped thinking about it',
  ],
  cryptic: [
    '{n} hours of sleep and an unshakeable sense of dread. we ball.',
    'deleted the app for 40 minutes. learned nothing.',
    'everything is fine. the {item} disagrees.',
    'the {topic} was inside us all along',
  ],
  announcement: [
    'taking a break from {topic} for my mental health. do not text me.',
    'opening commissions for {item} this friday',
    'going live in an hour. be normal about it.',
  ],
  text: [
    'currently thinking about {topic} and it\'s ruining my afternoon',
    'day 3 of {topic}. no improvement. sending help.',
    '{item} update: still going',
    'unpopular opinion but {topic} is genuinely overrated',
    'the {item} situation has escalated',
    'just discovered {topic}. life changing. anyway.',
  ],
};

const DMS = {
  casual: [
    'hey, did you see the thing about {topic}?',
    'ok so i need a second opinion on {topic}',
    'you around? got a question about {item}',
    'not to be weird but your last post was actually great',
  ],
  flirty: [
    'you were on my mind today. that\'s all.',
    'we should do something dumb this weekend',
    'ok your last post?? you can\'t just do that to me',
    'i\'m not flirting. i\'m just objectively stating facts.',
  ],
  cold: [
    'we need to talk about {topic}.',
    'don\'t make this weird.',
    'interesting that you posted that.',
    'noted.',
  ],
  anxious: [
    'ok this is going to sound insane but did i do something wrong',
    'sorry i know it\'s late. are we okay?',
    'i keep rereading what i sent. sorry. ignore me.',
  ],
  playful: [
    'guess who got into a very dumb argument about {item}',
    'i have decided your brand is {topic} and you have no say',
    'rate my {item} out of ten. be honest. be cruel.',
  ],
  dramatic: [
    'i cannot BELIEVE what happened with {topic}',
    'everything is ruined. okay not everything. mostly {topic}.',
    'we are never speaking of the {item} incident again',
  ],
  apologetic: [
    'hey. i\'m sorry about {topic}. i was out of line.',
    'can we rewind? i said things about {item} that weren\'t fair.',
  ],
};

const REPLIES = [
  'this is the most important thing anyone has said today',
  'unwell. thank you.',
  'lol okay this is actually real',
  'the way i KNEW you would post this',
  'ok but genuinely? love this',
  'not you making me cry at 2am',
  'this is so {adjective} of you',
  'i\'m framing this',
  'hmm. bold.',
  'wait say more',
];

const EVENTS = [
  { kind: 'growth', title: 'Your post got picked up by a bigger account' },
  { kind: 'drama', title: 'Someone vague-posted about you' },
  { kind: 'money', title: 'A brand slid into your DMs' },
  { kind: 'mood', title: 'You accidentally went outside' },
  { kind: 'social', title: 'A new face followed you' },
  { kind: 'growth', title: 'Follower count jumped overnight' },
  { kind: 'system', title: 'The algorithm has noticed you' },
];

const TOPICS = ['the group chat', 'brunch', 'this website', 'my landlord', 'that one song',
  'the vibe', 'people who type in all caps', 'reply guy', 'the internship'];
const ITEMS = ['cold brew', 'croissant', 'package', 'vintage jacket', 'jigsaw puzzle',
  'sourdough starter', 'gym membership', 'secondhand camera'];
const ADJECTIVES = ['chaotic', 'unhinged', 'iconic', 'feral', 'soft', 'devastating'];

/* ---------------- templating ---------------- */

function fill(str) {
  return str
    .replace(/\{n\}/g, () => String(rng.int(8, 40) * 100))
    .replace(/\{topic\}/g, () => rng.pick(TOPICS))
    .replace(/\{item\}/g, () => rng.pick(ITEMS))
    .replace(/\{adjective\}/g, () => rng.pick(ADJECTIVES));
}

/* ---------------- router ---------------- */

/**
 * Given a chat-completion request, produce a plausible response.
 * Detects the request shape rather than the exact prompt, so it
 * stays resilient to prompt changes.
 */
export function demoChat(request = {}) {
  const messages = request.messages || [];
  const sys = messages.find((m) => m.role === 'system')?.content || '';
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
  const wantsJSON = request.response_format?.type === 'json_object' ||
    /json/i.test(lastUser) || /json/i.test(sys);

  const base = {
    id: 'gen-demo-' + uid('g'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model || 'demo/local',
    usage: {
      prompt_tokens: Math.round(JSON.stringify(messages).length / 4),
      completion_tokens: 60,
      total_tokens: Math.round(JSON.stringify(messages).length / 4) + 60,
      cost: 0,
    },
  };

  if (hasTools) {
    const kind = detectIntent(sys, lastUser);
    const calls = buildToolCalls(kind, lastUser, sys);
    return {
      ...base,
      choices: [{
        index: 0,
        finish_reason: calls.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: calls.length ? '' : fill(rng.pick(REPLIES)),
          tool_calls: calls.length ? calls : undefined,
        },
      }],
    };
  }

  if (wantsJSON) {
    return {
      ...base,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(buildJSON(lastUser)) } }],
    };
  }

  return {
    ...base,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: generateLine(lastUser, sys) } }],
  };
}

/* ---------------- intent detection ---------------- */

function detectIntent(sys, user) {
  const s = (sys + ' ' + user).toLowerCase();
  if (s.includes('generatetimeline') || s.includes('world tick') || s.includes('ambient')) return 'timeline';
  if (s.includes('direct message') || s.includes('dm') || s.includes('conversation')) return 'dm';
  if (s.includes('feed') || s.includes('post')) return 'feed';
  return 'reply';
}

function buildToolCalls(kind, user, sys) {
  const roster = extractRoster(sys + ' ' + user);
  const make = (name, args) => ({
    id: 'call_' + uid('c'),
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });

  if (kind === 'timeline') {
    const out = [];
    const n = rng.int(1, 2);
    for (let i = 0; i < n; i++) {
      const who = roster.length ? rng.pick(roster) : null;
      if (who && rng.chance(0.75)) {
        out.push(make('create_post', {
          author: who.id,
          text: fill(rng.pick(rng.pick(Object.values(POSTS)))),
          kind: rng.pick(['text', 'flex', 'vague', 'drama', 'wholesome', 'cryptic']),
          sentiment: Math.round(rng.float(-0.7, 0.9) * 100) / 100,
        }));
      } else if (who && rng.chance(0.5)) {
        out.push(make('send_dm', {
          from: who.id,
          text: fill(rng.pick(DMS.casual)),
          tone: 'casual',
        }));
      }
      if (rng.chance(0.5)) {
        const ev = rng.pick(EVENTS);
        out.push(make('log_event', { title: ev.title, kind: ev.kind }));
      }
    }
    return out.length ? out : [make('log_event', { title: rng.pick(EVENTS).title, kind: 'system' })];
  }

  if (kind === 'dm') {
    const who = roster[0];
    if (!who) return [];
    const tone = rng.pick(Object.keys(DMS));
    return [make('send_dm', { from: who.id, text: fill(rng.pick(DMS[tone])), tone })];
  }

  if (kind === 'feed') {
    const who = roster.length ? rng.pick(roster) : null;
    if (!who) return [];
    return [make('create_post', {
      author: who.id,
      text: fill(rng.pick(rng.pick(Object.values(POSTS)))),
      kind: rng.pick(['text', 'flex', 'vague', 'wholesome']),
      sentiment: Math.round(rng.float(-0.4, 0.9) * 100) / 100,
    })];
  }

  const who = roster.length ? rng.pick(roster) : null;
  if (!who) return [];
  return [make('send_dm', {
    from: who.id,
    text: fill(rng.pick(rng.pick(Object.values(DMS)))),
    tone: rng.pick(['casual', 'playful', 'dramatic']),
  })];
}

/** Pull {id,name} pairs out of a prompt that embedded the roster as JSON. */
function extractRoster(text) {
  const out = [];
  const seen = new Set();
  const re = /"id"\s*:\s*"([^"]{4,64})"[\s\S]{0,120}?"name"\s*:\s*"([^"]{1,60})"/g;
  let m;
  while ((m = re.exec(text))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], name: m[2] });
    if (out.length >= 8) break;
  }
  return out;
}

function generateLine(user, sys) {
  const t = (user + ' ' + sys).toLowerCase();
  if (/reply as|respond as|you are [a-z]+/i.test(t)) return fill(rng.pick(REPLIES));
  if (/caption|write a post|compose/i.test(t)) return fill(rng.pick(POSTS.text));
  return fill(rng.pick([...POSTS.text, ...REPLIES]));
}

function buildJSON(user) {
  return {
    mood: rng.pick(['content', 'restless', 'buzzing', 'low']),
    summary: fill(rng.pick(POSTS.text)),
    options: [fill(rng.pick(POSTS.text)), fill(rng.pick(POSTS.vague)), fill(rng.pick(POSTS.cryptic))],
    sentiment: Math.round(rng.float(-0.5, 0.9) * 100) / 100,
  };
}

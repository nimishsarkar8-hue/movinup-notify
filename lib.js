'use strict';
/*
 * Movin' Up notifications, phase 2: the decisions. Pure functions only (no network, no Firebase), so tests/notify.js can check
 * every rule. send.js does the reading, sending and saving around them.
 */

const WINDOW_MIN = 45;                    // a reminder goes out if its time passed less than this long ago
const STALE_MS = 48 * 3600 * 1000;        // never announce something older than this (the job was off for days, say)
const REQ_OVERLAP_MS = 10 * 60 * 1000;    // look a little behind the cursor so a slow commit is never missed
const SEEN_KEEP_MS = 3 * 24 * 3600 * 1000;

// Same defaults as PUSH_DEFAULT_PREFS in js/20p-notifications.js.
const DEFAULT_PREFS = {
  friends: true,
  challenges: true,
  water: { on: false, time: '18:00' },
  steps: { on: false, time: '19:00' },
  food: { on: false, time: '20:30' }
};
const REMINDER_IDS = ['water', 'steps', 'food'];

// Several wordings per reminder so it does not read the same every day. Picked by the day of the year.
const REMINDERS = {
  water: {
    open: 'today',
    texts: [
      { title: 'Water time', body: 'A glass of water is a quick win.' },
      { title: 'Sip, sip', body: 'Top up your water for today.' },
      { title: 'Drink up', body: 'Have you had enough water today?' }
    ]
  },
  steps: {
    open: 'today',
    texts: [
      { title: 'Steps check', body: 'A short walk could close out your steps today.' },
      { title: 'Get moving', body: 'Check how your steps are looking today.' },
      { title: 'Walk time', body: 'Every step counts. Fancy a stroll?' }
    ]
  },
  food: {
    open: 'food',
    texts: [
      { title: 'Log your food', body: 'Add what you ate today while you remember it.' },
      { title: 'Food log', body: 'Quick, log your meals before the day ends.' },
      { title: 'What did you eat?', body: 'Take a minute to log today\u2019s food.' }
    ]
  }
};

function normalizePrefs(p) {
  const out = JSON.parse(JSON.stringify(DEFAULT_PREFS));
  if (!p || typeof p !== 'object') return out;
  if (typeof p.friends === 'boolean') out.friends = p.friends;
  if (typeof p.challenges === 'boolean') out.challenges = p.challenges;
  for (const id of REMINDER_IDS) {
    const v = p[id];
    if (v && typeof v === 'object') {
      if (typeof v.on === 'boolean') out[id].on = v.on;
      if (typeof v.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) out[id].time = v.time;
    }
  }
  return out;
}

// What is the clock on the wall in this time zone? { date: 'YYYY-MM-DD', minutes: 0..1439 }, or null for a zone name we do not know.
function localParts(ms, tz) {
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    const o = {};
    for (const part of f.formatToParts(new Date(ms))) o[part.type] = part.value;
    return { date: o.year + '-' + o.month + '-' + o.day, minutes: (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10) };
  } catch (e) {
    return null;
  }
}

// Which of this person's reminders are due right now? Returns [{ id, date }] (date = the day the reminder belongs to, in their zone).
//   sent       { water: 'YYYY-MM-DD', ... } the last day each one went out
//   updatedMs  when they last changed their settings; a reminder switched on or moved to a time that had already passed
//              waits for tomorrow instead of firing late
function dueReminders(prefsIn, tz, nowMs, sent, updatedMs) {
  const prefs = normalizePrefs(prefsIn);
  const lp = localParts(nowMs, tz);
  if (!lp) return [];
  const out = [];
  for (const id of REMINDER_IDS) {
    const r = prefs[id];
    if (!r.on) continue;
    const tm = parseInt(r.time.slice(0, 2), 10) * 60 + parseInt(r.time.slice(3), 10);
    const diff = (lp.minutes - tm + 1440) % 1440;           // minutes since the reminder time, wrapping past midnight
    if (diff >= WINDOW_MIN) continue;
    const targetMs = nowMs - diff * 60000 - (nowMs % 60000);
    const date = localParts(targetMs, tz).date;
    if (sent && sent[id] === date) continue;
    if (updatedMs && updatedMs > targetMs) continue;
    out.push({ id, date });
  }
  return out;
}

function dayOfYear(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
}
function reminderMessage(id, date) {
  const r = REMINDERS[id];
  const t = r.texts[dayOfYear(date) % r.texts.length];
  return { title: t.title, body: t.body, open: r.open, tag: 'rem-' + id };
}

// ---------- route names ----------
function prettyRoute(id) {
  return String(id || '').split('-').map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ') || 'a walk';
}
function routeName(routes, id) {
  return (routes && routes[id]) || prettyRoute(id);
}

// ---------- friend requests ----------
// requests: [{ id, from, to, fromName, createdMs }] read from friendRequests since the cursor.
// seen: { 'id:createdMs': ms } what has already been announced. Returns { events, seen, cursor }.
function planFriendRequests(requests, seen, cursorMs, nowMs) {
  const events = [];
  const nextSeen = {};
  for (const k of Object.keys(seen || {})) if (nowMs - seen[k] < SEEN_KEEP_MS) nextSeen[k] = seen[k];
  let cursor = cursorMs;
  for (const r of requests) {
    const key = r.id + ':' + r.createdMs;
    if (r.createdMs > cursor) cursor = r.createdMs;
    if (nextSeen[key]) continue;
    nextSeen[key] = nowMs;
    if (nowMs - r.createdMs > STALE_MS) continue;
    events.push({
      kind: 'friend', to: [r.to],
      data: { title: 'New friend request', body: r.fromName + ' wants to be your friend.', open: 'together', tag: 'fr-' + r.from }
    });
  }
  return { events, seen: nextSeen, cursor };
}

// ---------- challenges ----------
// open: challenges now pending or active (read by status). recorded: { id: 'pending'|'active' } as of the last run, or null on the
// very first run (everything that exists is noted and nothing is announced). gone: { id: doc|null } for recorded ids that are no
// longer pending/active (finished, cancelled, or deleted). Returns { events, recorded }.
function planChallenges(open, recorded, gone, routes, nowMs) {
  const events = [];
  const next = {};
  if (recorded === null || recorded === undefined) {
    for (const c of open) next[c.id] = c.status;
    return { events, recorded: next };
  }
  const members = (c, except) => (c.uids || []).filter((u) => u !== except);
  const mk = (c, to, title, body) => events.push({ kind: 'challenge', to, data: { title, body, open: 'together', tag: 'ch-' + c.id } });
  for (const c of open) {
    next[c.id] = c.status;
    const prev = recorded[c.id];
    const name = routeName(routes, c.route);
    if (prev === undefined) {
      if (nowMs - (c.createdMs || nowMs) > STALE_MS) continue;
      if (c.status === 'pending') {
        const who = (c.names && c.names[c.creator]) || 'A friend';
        mk(c, members(c, c.creator), 'Challenge invite', who + ' invited you to walk ' + name + '.');
      } else if (c.status === 'active') {
        mk(c, members(c), 'Challenge started', name + ' is on. Time to walk!');
      }
    } else if (prev === 'pending' && c.status === 'active') {
      mk(c, members(c), 'Challenge started', name + ' is on. Time to walk!');
    }
  }
  for (const id of Object.keys(recorded)) {
    if (next[id] !== undefined) continue;
    const c = gone && gone[id];
    if (!c) continue;                                   // deleted (a cancelled invitation, say): nothing to announce
    const name = routeName(routes, c.route);
    if (c.status === 'complete') mk(c, members(c), 'Challenge complete', name + ' is done. Nice walking, everyone!');
    else if (c.status === 'cancelled') mk(c, members(c), 'Challenge called off', name + ' was called off.');
  }
  return { events, recorded: next };
}

module.exports = {
  WINDOW_MIN, STALE_MS, REQ_OVERLAP_MS, DEFAULT_PREFS, REMINDER_IDS, REMINDERS,
  normalizePrefs, localParts, dueReminders, reminderMessage, prettyRoute, routeName, planFriendRequests, planChallenges
};

'use strict';
/*
 * One pass of the sender. Everything outside the decisions (reading Firestore, calling Firebase Cloud Messaging) comes in through
 * `store` and `sender`, so tests/notify.js can run this against in-memory fakes. send.js wires up the real ones.
 *
 *   store.listDevices()              -> [{ uid, prefs, tz, tokens, updatedMs }]          pushDevices/*
 *   store.getGlobal() / setGlobal(o) -> pushState/_global (what the last run saw)
 *   store.listRequestsSince(ms)      -> [{ id, from, to, fromName, createdMs }]          friendRequests created after ms
 *   store.listOpenChallenges()       -> [{ id, creator, route, uids, names, status, createdMs }]   pending or active
 *   store.getChallenges(ids)         -> { id: doc | null }
 *   store.getUserStates(uids)        -> { uid: { sent: { water: 'YYYY-MM-DD' } } }       pushState/{uid}
 *   store.markSent(uid, { id: date })
 *   store.removeToken(uid, tokenId)
 *   sender.sendAll(messages)         -> [{ ok, code }] in the same order
 */
const L = require('./lib');

const TTL_EVENT = 24 * 3600;     // seconds a push may wait for a phone that is switched off
const TTL_REMINDER = 2 * 3600;   // a reminder that arrives much later than its time is just noise

const BAD_TOKEN = new Set([
  'messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'
]);

function tokenList(tokens) {
  return Object.keys(tokens || {})
    .filter((id) => tokens[id] && typeof tokens[id].token === 'string' && tokens[id].token)
    .map((id) => ({ id, token: tokens[id].token }));
}

async function run(store, sender, opts) {
  opts = opts || {};
  const now = opts.now != null ? opts.now : Date.now();
  const dry = !!opts.dry;
  const log = opts.log || function () {};
  const routes = opts.routes || {};

  const devices = (await store.listDevices()).map((d) => ({
    uid: d.uid, prefs: L.normalizePrefs(d.prefs), tz: d.tz || '', updatedMs: d.updatedMs || 0, tokens: tokenList(d.tokens)
  })).filter((d) => d.tokens.length);
  const byUid = new Map(devices.map((d) => [d.uid, d]));

  const global = await store.getGlobal();
  const first = !global;
  const messages = [];

  function addTo(uids, kind, data, ttl, extra) {
    for (const uid of uids) {
      const dev = byUid.get(uid);
      if (!dev) continue;
      if (kind === 'friend' && !dev.prefs.friends) continue;
      if (kind === 'challenge' && !dev.prefs.challenges) continue;
      for (const t of dev.tokens) {
        messages.push(Object.assign({ uid, tokenId: t.id, token: t.token, data, ttl, kind }, extra || {}));
      }
    }
  }

  // 1. friend requests made since the last run
  let reqs = [];
  if (!first) reqs = await store.listRequestsSince((global.reqCursorMs || now) - L.REQ_OVERLAP_MS);
  const fr = L.planFriendRequests(reqs, global && global.reqSeen, global ? (global.reqCursorMs || now) : now, now);
  for (const e of fr.events) addTo(e.to, 'friend', e.data, TTL_EVENT);

  // 2. challenges: invited, started, finished, called off
  const open = await store.listOpenChallenges();
  const recorded = global ? (global.challenges || {}) : null;
  let gone = {};
  if (recorded) {
    const missing = Object.keys(recorded).filter((id) => !open.some((c) => c.id === id));
    if (missing.length) gone = await store.getChallenges(missing);
  }
  const ch = L.planChallenges(open, recorded, gone, routes, now);
  for (const e of ch.events) addTo(e.to, 'challenge', e.data, TTL_EVENT);

  // 3. daily reminders that are due
  const withReminders = devices.filter((d) => d.tz && L.REMINDER_IDS.some((id) => d.prefs[id].on));
  const states = withReminders.length ? await store.getUserStates(withReminders.map((d) => d.uid)) : {};
  const remindersDue = [];
  for (const d of withReminders) {
    const sent = (states[d.uid] && states[d.uid].sent) || {};
    for (const r of L.dueReminders(d.prefs, d.tz, now, sent, d.updatedMs)) {
      remindersDue.push({ uid: d.uid, id: r.id, date: r.date });
      addTo([d.uid], 'reminder', Object.assign({}, L.reminderMessage(r.id, r.date)), TTL_REMINDER, { reminder: { id: r.id, date: r.date } });
    }
  }

  const summary = {
    first, devices: devices.length, friend: fr.events.length, challenge: ch.events.length, reminders: remindersDue.length,
    messages: messages.length, ok: 0, failed: 0, removed: 0, dry
  };
  log('devices ' + devices.length + ', friend requests ' + fr.events.length + ', challenge events ' + ch.events.length +
    ', reminders due ' + remindersDue.length + ', pushes ' + messages.length + (first ? ' (first run: existing challenges noted, none announced)' : ''));

  // Remember what this run saw BEFORE sending, so a crash part-way can only skip a push, never repeat one.
  const newGlobal = { reqCursorMs: now, reqSeen: fr.seen, challenges: ch.recorded, runAt: now };
  if (dry) {
    for (const m of messages) log('  would send to ' + m.uid + ': ' + m.data.title + ' / ' + m.data.body);
    return summary;
  }
  await store.setGlobal(newGlobal);

  if (!messages.length) return summary;
  const results = await sender.sendAll(messages);

  // A reminder counts as delivered when at least one phone got it, or when every failure was a dead token (nothing to retry).
  const rem = new Map();   // 'uid|id' -> { uid, id, date, ok, transient }
  const removed = new Set();
  results.forEach((res, i) => {
    const m = messages[i];
    if (res && res.ok) summary.ok++; else summary.failed++;
    const bad = !(res && res.ok) && BAD_TOKEN.has(res && res.code);
    if (bad && !removed.has(m.uid + '|' + m.tokenId)) { removed.add(m.uid + '|' + m.tokenId); }
    if (m.reminder) {
      const k = m.uid + '|' + m.reminder.id;
      const e = rem.get(k) || { uid: m.uid, id: m.reminder.id, date: m.reminder.date, ok: false, transient: false };
      if (res && res.ok) e.ok = true; else if (!bad) e.transient = true;
      rem.set(k, e);
    }
  });
  for (const key of removed) {
    const [uid, tokenId] = key.split('|');
    await store.removeToken(uid, tokenId);
    summary.removed++;
  }
  for (const e of rem.values()) {
    if (e.ok || !e.transient) {
      const o = {}; o[e.id] = e.date;
      await store.markSent(e.uid, o);
    }
  }
  log('sent ' + summary.ok + ', failed ' + summary.failed + ', dead tokens removed ' + summary.removed);
  return summary;
}

// A test push to every phone of one username (workflow_dispatch input), to prove the whole chain works.
async function ping(store, sender, username, opts) {
  opts = opts || {};
  const uid = await store.findUidByUsername(String(username || '').toLowerCase().replace(/^@/, ''));
  if (!uid) return { found: false, ok: 0, failed: 0 };
  const dev = (await store.listDevices()).find((d) => d.uid === uid);
  const toks = dev ? tokenList(dev.tokens) : [];
  const messages = toks.map((t) => ({
    uid, tokenId: t.id, token: t.token, ttl: 3600, kind: 'test',
    data: { title: 'Test from movin\u2019 up', body: 'If you can read this, notifications work.', open: 'today', tag: 'test' }
  }));
  if (!messages.length) return { found: true, phones: 0, ok: 0, failed: 0 };
  if (opts.dry) return { found: true, phones: messages.length, ok: 0, failed: 0, dry: true };
  const results = await sender.sendAll(messages);
  let ok = 0, failed = 0, removed = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i] && results[i].ok) ok++;
    else {
      failed++;
      if (BAD_TOKEN.has(results[i] && results[i].code)) { await store.removeToken(uid, messages[i].tokenId); removed++; }
    }
  }
  return { found: true, phones: messages.length, ok, failed, removed, codes: results.filter((r) => r && !r.ok).map((r) => r.code) };
}

module.exports = { run, ping, tokenList, BAD_TOKEN };

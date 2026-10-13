#!/usr/bin/env node
'use strict';
/*
 * Movin' Up notifications, phase 2: the sender. Runs on a schedule in GitHub Actions (see .github/workflows/notify.yml), reads the
 * app's Firestore with a service account and pushes through Firebase Cloud Messaging.
 *
 *   node send.js                  one normal pass
 *   node send.js --dry            read everything and print what WOULD go out; sends and saves nothing
 *   node send.js --ping <name>    send one test push to every phone signed in as that username
 *
 * The service account key comes from the FIREBASE_SERVICE_ACCOUNT environment variable (the whole JSON file as text).
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { run, ping } = require('./run');

function init() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    let key;
    try { key = JSON.parse(raw); } catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole key file, braces included.'); }
    admin.initializeApp({ credential: admin.credential.cert(key) });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp();
  } else {
    throw new Error('No credentials. Set FIREBASE_SERVICE_ACCOUNT (see README.md).');
  }
  return admin.firestore();
}

const ms = (t) => (t && typeof t.toMillis === 'function') ? t.toMillis() : 0;

function makeStore(db) {
  const FV = admin.firestore.FieldValue;
  return {
    async listDevices() {
      const snap = await db.collection('pushDevices').get();
      return snap.docs.map((d) => {
        const x = d.data();
        return { uid: d.id, prefs: x.prefs, tz: x.tz, tokens: x.tokens, updatedMs: ms(x.updatedAt) };
      });
    },
    async getGlobal() {
      const s = await db.doc('pushState/_global').get();
      return s.exists ? s.data() : null;
    },
    async setGlobal(o) { await db.doc('pushState/_global').set(o); },
    async listRequestsSince(sinceMs) {
      const snap = await db.collection('friendRequests').where('createdAt', '>', admin.firestore.Timestamp.fromMillis(Math.max(0, sinceMs))).get();
      return snap.docs.map((d) => {
        const x = d.data();
        return { id: d.id, from: x.from, to: x.to, fromName: x.fromName || 'Someone', createdMs: ms(x.createdAt) };
      }).filter((r) => r.from && r.to && r.createdMs);
    },
    async listOpenChallenges() {
      const snap = await db.collection('challenges').where('status', 'in', ['pending', 'active']).get();
      return snap.docs.map(challengeOf);
    },
    async getChallenges(ids) {
      const out = {};
      if (!ids.length) return out;
      const snaps = await db.getAll(...ids.map((id) => db.doc('challenges/' + id)));
      snaps.forEach((s, i) => { out[ids[i]] = s.exists ? challengeOf(s) : null; });
      return out;
    },
    async getUserStates(uids) {
      const out = {};
      if (!uids.length) return out;
      const snaps = await db.getAll(...uids.map((u) => db.doc('pushState/' + u)));
      snaps.forEach((s, i) => { out[uids[i]] = s.exists ? s.data() : {}; });
      return out;
    },
    async markSent(uid, o) { await db.doc('pushState/' + uid).set({ sent: o }, { merge: true }); },
    async removeToken(uid, tokenId) {
      try { await db.doc('pushDevices/' + uid).update({ ['tokens.' + tokenId]: FV.delete() }); } catch (e) { /* the document is gone */ }
    },
    async findUidByUsername(handle) {
      if (!/^[a-z0-9_]{3,20}$/.test(handle)) return null;
      const s = await db.doc('usernames/' + handle).get();
      return s.exists ? s.data().uid : null;
    }
  };
}
function challengeOf(d) {
  const x = d.data();
  return { id: d.id, creator: x.creator, route: x.route, uids: x.uids || [], names: x.names || {}, status: x.status, createdMs: ms(x.createdAt) };
}

function makeSender() {
  const messaging = admin.messaging();
  return {
    // Data-only messages: sw.js decides what to show. Up to 500 per call.
    async sendAll(messages) {
      const out = [];
      for (let i = 0; i < messages.length; i += 500) {
        const chunk = messages.slice(i, i + 500).map((m) => ({
          token: m.token,
          data: { title: String(m.data.title), body: String(m.data.body), open: String(m.data.open || 'today'), tag: String(m.data.tag || '') },
          webpush: { headers: { TTL: String(m.ttl || 86400), Urgency: 'high' } }
        }));
        const res = await messaging.sendEach(chunk);
        for (const r of res.responses) out.push({ ok: r.success, code: r.error ? r.error.code : '' });
      }
      return out;
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const pi = args.indexOf('--ping');
  const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'routes.json'), 'utf8'));
  const db = init();
  const store = makeStore(db);
  const sender = makeSender();
  if (pi !== -1) {
    const r = await ping(store, sender, args[pi + 1], { dry });
    console.log('ping:', JSON.stringify(r));
    if (!r.found) { console.error('No one has the username "' + args[pi + 1] + '".'); process.exitCode = 1; }
    else if (!r.phones) { console.error('That account has no phone with notifications turned on yet.'); process.exitCode = 1; }
    else if (!dry && r.ok === 0) process.exitCode = 1;
    return;
  }
  const summary = await run(store, sender, { dry, routes, log: console.log });
  console.log('done:', JSON.stringify(summary));
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error('FAILED:', e && e.message ? e.message : e); process.exit(1); });

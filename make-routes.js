#!/usr/bin/env node
'use strict';
// Rebuilds routes.json (route id -> display name) from the app's own catalog, so a notification says "Milford Track" and
// not "milford". Run it from the app project after the catalog changes:  node notify/make-routes.js
// (tests/notify.js fails if routes.json is out of date.)
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'js', '20g-together-routes.js');
function build() {
  const s = fs.readFileSync(src, 'utf8');
  const out = {};
  const re = /\{id: '([a-z0-9-]+)', band: '[a-z]+', name: '((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(s))) {
    out[m[1]] = m[2].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\'/g, "'");
  }
  return out;
}
if (require.main === module) {
  const routes = build();
  fs.writeFileSync(path.join(__dirname, 'routes.json'), JSON.stringify(routes, null, 2) + '\n');
  console.log('routes.json: ' + Object.keys(routes).length + ' routes');
}
module.exports = { build };

// Test helper, loaded with NODE_OPTIONS=--require so it also runs inside worker threads. Every attempt to reach a network is
// recorded in $PG_NET_LOG and refused.
const fs = require('fs'), net = require('net'), tls = require('tls'), dns = require('dns'), http = require('http'), https = require('https');
const note = what => { try { fs.appendFileSync(process.env.PG_NET_LOG, `${what}\n`); } catch { /* no log configured */ } };
const deny = what => () => { note(what); const e = new Error(`network blocked by the test: ${what}`); e.code = 'ECONNREFUSED'; throw e; };
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { const o = a[0]; if (typeof o === 'string' || (o && typeof o === 'object' && o.path)) return origConnect.apply(this, a); deny('net.Socket.connect')(); };
net.connect = net.createConnection = deny('net.connect');
tls.connect = deny('tls.connect');
dns.lookup = deny('dns.lookup'); dns.resolve = deny('dns.resolve'); if (dns.promises) { dns.promises.lookup = deny('dns.promises.lookup'); dns.promises.resolve = deny('dns.promises.resolve'); }
http.request = http.get = deny('http.request'); https.request = https.get = deny('https.request');
const reject = what => () => { note(what); const e = new Error(`network blocked by the test: ${what}`); e.code = 'ECONNREFUSED'; return Promise.reject(e); };
if (typeof globalThis.fetch === 'function') globalThis.fetch = reject('fetch');
if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = deny('WebSocket');

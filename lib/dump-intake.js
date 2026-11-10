// Database dump intake: checks a database export file given by a person and makes the sandbox's temporary copy of it.
//
//   - only a plain file (a symbolic link, a folder or a device is refused);
//   - the first bytes decide what it is: gzip (1f 8b) is unpacked as a STREAM with zlib (in a child process, so the caller stays synchronous
//     and nothing is held in memory); a UTF-16 byte-order mark (ff fe / fe ff) is refused ("export it as UTF-8"); a .crypt (encrypted
//     UpdraftPlus), a .zip or any other binary file (a NUL byte in the first 64 KB) is refused ("export a fresh, unencrypted copy");
//     plain text SQL is accepted;
//   - the size cap counts UNPACKED bytes: a small .gz that unpacks to more than the cap (a "gzip bomb") stops at the cap;
//   - the copy is created owner-only (0600) with O_EXCL, written in chunks (never a whole-file read), and removed on every failure.
// The original file is only read. Nothing here uses the network.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

class DumpRefused extends Error { constructor(msg) { super(msg); this.name = 'DumpRefused'; this.exitCode = 2; } }
const HEAD = 64 * 1024;
const CHUNK = 1 << 20;
const DEFAULT_CAP_MB = 1024;
const UNENCRYPTED = 'export a fresh, unencrypted copy';

function readHead(file, n = HEAD) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { const buf = Buffer.alloc(n); const got = fs.readSync(fd, buf, 0, n, 0); return buf.subarray(0, got); } finally { fs.closeSync(fd); }
}
// -> 'gzip' | 'utf16' | 'zip' | 'binary' | 'sql'
function sniff(head) {
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
    if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return 'utf16';
    if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)) return 'zip';
    if (head.includes(0)) return 'binary';
    return 'sql';
}
const capMessage = capMb => `the database file is larger than ${capMb} MB once unpacked (above the ${capMb} MB cap); it was not imported. Export only this site's database, or leave out large log and cache tables, and try again.`;
function refuseKind(kind, label) {
    if (kind === 'utf16') throw new DumpRefused(`${label}: this file was saved as UTF-16: export it as UTF-8`);
    if (kind === 'zip') throw new DumpRefused(`${label} is a .zip archive, not a database export: ${UNENCRYPTED} (.sql or .sql.gz)`);
    if (kind === 'binary') throw new DumpRefused(`${label} is not a plain SQL text file (it contains binary data, for example an encrypted UpdraftPlus file): ${UNENCRYPTED} (.sql or .sql.gz)`);
}
function checkPlain(src, label) {
    let st; try { st = fs.lstatSync(src); } catch { throw new DumpRefused(`${label} ${src} does not exist`); }
    if (st.isSymbolicLink() || !st.isFile()) throw new DumpRefused(`${label} ${src} is not a plain file`);
    return st;
}

// Copies plain SQL in chunks, counting bytes against the cap (the file could grow after the size check).
function copyCapped(src, dest, maxBytes) {
    const inFd = fs.openSync(src, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let outFd = null, total = 0;
    try {
        outFd = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        const buf = Buffer.alloc(CHUNK);
        for (;;) {
            const n = fs.readSync(inFd, buf, 0, buf.length, null); if (!n) break;
            total += n; if (total > maxBytes) return { ok: false, cap: true, bytes: total };
            let off = 0; while (off < n) off += fs.writeSync(outFd, buf, off, n - off);
        }
        return { ok: true, bytes: total };
    } finally { fs.closeSync(inFd); if (outFd !== null) fs.closeSync(outFd); }
}

// Unpacks a .gz in a child process (zlib streams, bounded memory). Exit codes: 0 done, 3 above the cap, 4 not a valid gzip file.
function gunzipCapped(src, dest, maxBytes) {
    const r = spawnSync(process.execPath, [__filename, '--gunzip', src, dest, String(maxBytes)], { encoding: 'utf8', timeout: 30 * 60 * 1000, env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) return { ok: false, error: String(r.error.message) };
    if (r.status === 3) return { ok: false, cap: true };
    if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim().split('\n')[0] || `the file could not be unpacked (exit ${r.status})` };
    return { ok: true, bytes: Number((r.stdout || '').trim()) || 0 };
}

// src: the person's file (only read). dest: the temporary copy, which must not exist yet. -> { bytes, gzip, source_bytes }
// Throws DumpRefused with a plain message; dest never survives a refusal.
function intake(src, dest, { maxMb = DEFAULT_CAP_MB, label = '--db-dump' } = {}) {
    const st = checkPlain(src, label);
    const maxBytes = maxMb * 1048576;
    if (/\.crypt$/i.test(src)) throw new DumpRefused(`${label} is an encrypted UpdraftPlus file (.crypt), which cannot be read: ${UNENCRYPTED}`);
    const kind = sniff(readHead(src));
    refuseKind(kind, label);
    let exists = true; try { fs.lstatSync(dest); } catch { exists = false; }
    if (exists) throw new DumpRefused(`the temporary copy ${dest} already exists: it is not overwritten`);   // and, not ours, never removed
    try {
        if (kind === 'gzip') {
            const g = gunzipCapped(src, dest, maxBytes);
            if (g.cap) throw new DumpRefused(capMessage(maxMb));
            if (!g.ok) throw new DumpRefused(`${label} looks like a .gz file but could not be unpacked (${g.error}): ${UNENCRYPTED}`);
            refuseKind(sniff(readHead(dest)), `${label} (unpacked)`);   // what is inside the .gz must be plain SQL too
            return { bytes: g.bytes, gzip: true, source_bytes: st.size };
        }
        if (st.size > maxBytes) throw new DumpRefused(capMessage(maxMb));
        const c = copyCapped(src, dest, maxBytes);
        if (c.cap) throw new DumpRefused(capMessage(maxMb));
        return { bytes: c.bytes, gzip: false, source_bytes: st.size };
    } catch (e) { try { fs.rmSync(dest, { force: true }); } catch { /* gone */ } throw e; }
}

// A file Plugin Guard wrote itself (wp db export): only the content checks and the cap, no copy.
function checkFile(file, { maxMb = DEFAULT_CAP_MB, label = 'the database export' } = {}) {
    const st = checkPlain(file, label);
    refuseKind(sniff(readHead(file)), label);
    if (st.size > maxMb * 1048576) throw new DumpRefused(capMessage(maxMb));
    return { bytes: st.size };
}

// ---- the time estimate the wizard prints before it builds a test copy (TEST-COPY-SPEC 6) ----
// The UNPACKED size of a database file, read without unpacking: a plain file is its size; a .gz records its unpacked size (modulo 4 GiB) in its
// last four bytes (RFC 1952 ISIZE), so the larger of that and the packed size is used. Only read; null when the file cannot be read.
function unpackedBytes(file) {
    let st; try { st = fs.lstatSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    let fd = null;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const h = Buffer.alloc(2), got = fs.readSync(fd, h, 0, 2, 0);
        if (got < 2 || h[0] !== 0x1f || h[1] !== 0x8b || st.size < 18) return st.size;
        const t = Buffer.alloc(4); fs.readSync(fd, t, 0, 4, st.size - 4);
        return Math.max(t.readUInt32LE(0), st.size);
    } catch { return null; } finally { if (fd !== null) fs.closeSync(fd); }
}
// The formula: one minute to start the containers, plus one minute per started 50 MB of unpacked SQL (import and anonymising), at least 2.
//   minutes = max(2, 1 + ceil(MB / 50)), MB = unpacked bytes / 1048576. An unknown size gives the minimum.
const MB_PER_MINUTE = 50, MIN_MINUTES = 2;
function estimateMinutes(bytes) {
    const mb = Number.isFinite(bytes) && bytes > 0 ? bytes / 1048576 : 0;
    return Math.max(MIN_MINUTES, 1 + Math.ceil(mb / MB_PER_MINUTE));
}
const buildNotice = minutes => `Building a test copy of your site with your database, about ${minutes} minutes.`;

// ---- child: node dump-intake.js --gunzip <src> <dest> <maxBytes>
if (require.main === module && process.argv[2] === '--gunzip') {
    const zlib = require('zlib');
    const [, , , src, dest, capArg] = process.argv;
    const cap = Number(capArg);
    let total = 0, done = false;
    const finish = code => { if (done) return; done = true; if (code !== 0) { try { fs.rmSync(dest, { force: true }); } catch { /* gone */ } } process.exitCode = code; };
    const input = fs.createReadStream(src, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0), highWaterMark: 1 << 16 });
    const gun = zlib.createGunzip();
    const out = fs.createWriteStream(dest, { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode: 0o600 });
    const fail = (code, msg) => { if (msg) process.stderr.write(msg + '\n'); input.destroy(); gun.destroy(); out.destroy(); finish(code); };
    gun.on('data', chunk => {
        total += chunk.length;
        if (total > cap) return fail(3);
        if (!out.write(chunk)) { gun.pause(); out.once('drain', () => gun.resume()); }
    });
    gun.on('end', () => out.end(() => { if (!done) { process.stdout.write(String(total)); finish(0); } }));
    gun.on('error', e => fail(4, `not a valid gzip file (${e.code || e.message})`));
    input.on('error', e => fail(4, `cannot read the file (${e.code || e.message})`));
    out.on('error', e => fail(5, `cannot write the copy (${e.code || e.message})`));
    input.pipe(gun);
}

module.exports = { unpackedBytes, estimateMinutes, buildNotice, MB_PER_MINUTE, MIN_MINUTES, intake, checkFile, sniff, readHead, DumpRefused, DEFAULT_CAP_MB, capMessage, HEAD };

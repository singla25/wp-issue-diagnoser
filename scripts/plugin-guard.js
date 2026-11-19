#!/usr/bin/env node
// plugin-guard: tell it what is wrong with a WordPress site and where the site's folder is; it analyses a COPY and says what is probably causing it.
//   plugin-guard                         asks the questions one by one
//   plugin-guard --description "..." --root <wp-content or WordPress folder> [--url <https://...> --env local|staging|live [--authorized]] [--php 8.1]
//   plugin-guard --description "..." --no-files [--url <https://...> --env local|staging|live [--authorized]] [--images a.png,b.png]   (no site folder: a weak result)
//                [--images a.png,b.png] [--log debug.log] [--sandbox] [--db-dump f.sql] [--no-replica] [--out <reports folder>] [--yes]
// Nothing is changed on the site. Exit codes: 0 done · 1 problem found that needs attention (not used) · 2 missing or bad answer · 3 a site that may not be visited.

const { parse } = require('./guard');
const HELP = `wp-issue-diagnoser: find the likely cause of a WordPress problem. Reads a copy of your site; changes nothing.

Run it with no options to be asked: what is wrong, screenshots, the website address (optional), and which WordPress folder (a list of the ones found on this computer is shown).
The site's own log is found by itself, and with an address it only asks you to confirm one guess: local, staging or live.

Options (each one answers a question; with --yes nothing is asked):
  --description "<text>"   what is wrong (required)
  --root <folder>          the wp-content folder, or the WordPress folder that contains it (required, unless --no-files)
  --no-files               you have no site files: only the description, screenshots and the address are used; the code is not looked at (cannot be used with --root, --sandbox or --db-dump; --log is allowed: the log is then the only file read)
  --url <address>          the website, to look at it from outside (optional)
  --env local|staging|live what kind of site --url is (asked as one yes/no line in a terminal; required with --url otherwise)
  --authorized             you have the owner's permission to visit a LIVE site
  --php <version>          for example 8.1 (optional)
  --images <paths>         screenshots: files or folders, separated by commas (optional)
  --log <file>             a log file instead of the one found in your site; it is read as masked text, never changed (optional). With --no-files it is the only thing read; a database export, an environment file or wp-config is refused
  --sandbox                also test in a throwaway copy in Docker (needs: ${require('../lib/hints').current().npmRun('setup-sandbox')})
  --db-dump <file>         a database export (.sql or .sql.gz): a test copy of your site is built from it when Docker works and the site is not live
  --max-size-mb <n>        size cap in MB for the site copy and for the database file once unpacked (database default 1024)
  --no-replica             never build a test copy (no database question)
  --out <folder>           where reports go (default: the package's issues folder, or ./plugin-guard-reports when that cannot be written)
  --yes                    never ask; a missing required value is an error (exit 2)
`;

async function main() {
    const o = parse(process.argv.slice(2));
    if (o.help || o._[0] === 'help') { process.stdout.write(HELP); return 0; }
    require('../lib/issue-deps').need();
    return require('../lib/wizard').run(o);
}
if (require.main === module) main().then(c => process.exit(c || 0)).catch(e => {
    console.error(`\nwp-issue-diagnoser: ${e.message}`);
    process.exit(e.exitCode || 2);
});
module.exports = { main, HELP };

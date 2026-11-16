# TEST-COPY-SPEC: testing the problem on a copy of the real site

Status: approved design, built through 6d-3 (docs/HANDOFF.md rows 47-59). Not built: 6c-3 (masking, named accounts) and 6.1 (payment test-mode keys); 6.2 (logging in the copy) is partly built. Read with docs/REPORT-SPEC.md, CLAUDE.md and docs/WORKFLOW.md (CEO protocol). Rules in those files still apply. This file adds the "test copy" (the Docker sandbox, filled with the site's own database and code).

## 1. Why

The earlier sandbox started from a blank WordPress with no database, so plugins had to be switched on from scratch and failed for reasons unrelated to the real crash (Ivory Search on a real site). A copy built from the site's own code, its database and matching versions makes a test meaningful: "with X switched off, the page loads" is a second, independent check on top of the log.

## 2. Inputs

Required for a test: the problem and screenshot or address; the site code (wp-content); a DATABASE EXPORT FILE (.sql, .sql.gz, or an UpdraftPlus database file); Docker available.
Optional: the Site Health text (wp-admin > Tools > Site Health > Info > "Copy site info to clipboard") for PHP, database and WordPress versions and the active plugin list.
Never accepted: database credentials, a remote database login or URL. A file only. An encrypted UpdraftPlus file (.crypt) cannot be read: say "export a fresh, unencrypted copy".
Without the database or Docker the tool still shows the log and code reading, clearly labelled NOT TESTED, with the list of what it needs ("a database export, the site code, Docker"). It never reads as a conclusion.

## 3. Versions (match, then say how it was found)

- WordPress version: wp-includes/version.php of the copy. Plugin and theme versions: their headers.
- Database version: the dump's header comment when present (most exports have it); the Site Health text otherwise. Use a MySQL image when the site runs MySQL (a real site: 8.0.x) and a MariaDB image when it runs MariaDB; a mismatch can break the import. VERIFY what the pinned images are today.
- PHP version, best source first: stated by the person or the Site Health text; the live page's X-Powered-By header when the server sends it (VERIFY whether the probe records response headers); a PHP handler line in .htaccess; otherwise ASSUMED. "Requires PHP" in headers is only a MINIMUM, never the version in use.
- Every result names its source: "PHP 8.2.30 (from Site Health)", "(from the response header)", "assumed 8.x because nothing stated it". Later option, not now: if the copy does not reproduce the problem, try the likely versions.
- Another image per PHP or database version is pulled once at setup (digest-pinned, as today).

## 4. Active plugins

Switch on only the plugins that are active on the real site (Site Health list, or the database's active_plugins value). Never "activate all". If the list is unknown, say so and mark the result accordingly.

## 5. User data (strict)

Real rows exist only inside the throwaway database container during the import. The tool removes the personal data it knows about (users, comments, orders and the other tables it lists) before any page loads. Tables it does not know are copied as they are and are listed in the report as not checked. With a database file the web container has no route out. A temporary copy of the file is kept with owner-only permissions and deleted afterwards, also when the run fails. By default every account is rewritten in place as a dummy (user IDs are kept, so post authors need no remapping), and one account becomes a known dummy admin with a new test password.
Always removed, whatever the person chooses: password hashes (a kept account gets a new test password), payment data, API keys, SMTP passwords, licence keys, tokens and secret-looking options.
Removed by default: users, user meta, comments (author, email, IP), WooCommerce orders and customer tables, form entries, newsletter subscribers. Masking of email-like values and IP addresses left in other tables is ASKED (section 5.2); the default answer is on.
The report may say how many rows were removed per table, never their content. Unknown plugin tables cannot be known: the report lists what was removed, masked and what could not be checked, and never promises "no personal data".

*Note: as built this differs, see HANDOFF row 65.*

The old --keep-real-data flag is retired (done in 6c-2): using it exits 2 with a one-line pointer to the question below.

### 5.1 The question (terminal, only when a database file was given)
```
Your database file contains user accounts. How should the test copy handle them?
  1) Use dummy users only (recommended). Your real users are not copied.
  2) Keep only the user accounts I name, and use dummy users for the rest.
  3) Use my real user table.
  0) Skip the test copy
```
Option 3 needs a typed word ("REAL"), not a number. With --yes or no terminal the answer is 1. Say up front: "stays on this computer, deleted afterwards, never sent anywhere". The report records "Users: dummy" or "Users: N real accounts kept" (a count, never the names), with the date and the categories kept. Personal values never appear in the report or the logs. The "always removed" list applies under every option.

### 5.2 The masking question (terminal, only when a database file was given, asked after 5.1)
```
Emails and IP addresses can also sit in comments, order notes, form entries and settings. Hide them in the test copy?
  1) Yes, replace them with dummy values (recommended)
  2) No, keep them as they are in my file
  0) Skip the test copy
```
With --yes or no terminal the answer is 1. The report records the choice. After option 2 the report says "email addresses and IP addresses that remain in other tables were not masked". Option 2 never overrides the "always removed" list.

## 6. Running it

When a database file is given, Docker works and the site is not live: build the copy without asking again, with a visible notice ("Building a test copy of your site with your database, about N minutes") and a size cap (a dump over the cap is skipped, with the reason). --no-replica switches it off. Never for --env live. Outbound traffic from the copy is limited, NOT absent: WordPress's own HTTP calls, name lookups and mail are blocked, but a raw connection to an IP address from plugin code may not be (VERIFY against the sandbox's own "what is not blocked" notice, and say so in the report). Everything is deleted afterwards.
Steps: build matching containers; import the filtered database; rewrite the site address to the private test address; mount a COPY of wp-content; switch on the active plugins; run the fidelity check; then the tests.

### 6.1 Payment problems
When the symptom is checkout or payment, the wizard asks: "Do you have TEST-MODE keys for the payment plugin? (yes / no / not sure)" and records the answer. The question says test keys only, never live keys; the tool may refuse keys that clearly look live, but it cannot recognise every gateway's format, so the rule is also in the question text. Keys are used only inside the test copy, never written to the report or the logs, and deleted afterwards. A dummy customer is fine for this.
Until a narrow gateway exception exists (a separate design with its own safety review), the report says: "Payment calls to the gateway were not tested: this needs test-mode keys and a gateway exception, not available in this version." Many payment bugs do not need the gateway (a JavaScript error on checkout, an outdated WooCommerce template override, a broken hook) and are still found.

### 6.2 No error log on the real site
When the real site has no error log, the test copy switches logging on itself, in its OWN wp-config: WP_DEBUG true, WP_DEBUG_LOG true, WP_DEBUG_DISPLAY false. It loads the pages and reads the copy's log. The real site is never changed.
- It counts only after the fidelity check (section 7) has passed, that is, the copy shows the same symptom as the real site. The report names the source ("from a test copy of your site"). When the copy did not match, the report says so and uses nothing from the copy's log.
- Without a database file or Docker, the report keeps the guided steps for the real site (backup first, then turn logging on in wp-config.php, load the page, run the report again).
- Not buildable before the test copy exists (Part 6).

## 7. Fidelity rule

First test in the copy: does it show the SAME problem as the real site (same page, same kind of status, the same fatal in the copy's own log)? Three outcomes:
- Same symptom: the copy is trusted. Switching a suspect off (default theme, plugins in halves) counts as a second independent check, worded "on a test copy of your site".
- Different symptom or none: "The test copy did not show the same problem, so nothing from it is used", with likely reasons. The cause stays "not confirmed".
- The copy could not start or could not activate plugins: "Could not test". NEVER "not reproduced".
The report adds a "How close the copy is" box: what matched (versions, active plugins, the same fatal) and what did not or is unknown. Not covered in this version (say so plainly): external services (outbound traffic is blocked), the web server layer (Apache or Nginx rules, CDN, caching), file permissions, PHP extensions of the real server, cron jobs, and the uploads folder unless included.

## 8. Report levels
1) Tested on a copy: strongest wording allowed. 2) Not tested: database, code or Docker missing, or the real site had no failing page to compare (owner decision, 6d-3); log and code reading shown, labelled NOT TESTED, with what is needed. 3) Test could not run, or did not match.
Top of the report stays plain sentences for the person who forwards it; technical detail (hooks, class names, paths, stack trace) sits underneath.

## 9. Owner decisions already made
Database as a file only; Site Health text optional with the fallback; PHP shown with its source; run the copy without asking when a database file and Docker are present; the fidelity rule as above; the user-accounts question above; keep the log and code check even with a copy; remove nothing from the sandbox yet. DECIDED later: masking is asked as a question (default answer on); the wording is "not covered in this version"; payment problems: ask for test-mode keys and record "payment gateway calls not tested" until the gateway exception exists; build order: REPORT-SPEC Parts 1 to 5 first, this as Part 6, with the read-only audit of section 10 done now.

## 10. First task (read-only, report in 20 lines)
What already exists in the sandbox code: dump import, address rewrite, the anonymise step, the pinned PHP and database images, --db-dump, --neutralise-payments, --with-uploads, --max-size-mb (--keep-real-data was retired in 6c-2). Has a REAL dump import ever run end to end (test or run)? What does anonymise remove today versus section 5? Does the probe record response headers? What does the dump header contain for UpdraftPlus and wp db export files? Then a plan, with the CEO protocol.

## 11. Acceptance example (a real site)
PHP 8.2.30, MySQL 8.0.46, WordPress 7.1.4, 24 active plugins. The copy must show "Class Elementor\Core\Schemes\Color not found ... heading.php:48"; with the default theme the page loads; the report says so, names the sources of every version, and lists the user-data handling. A wrong database or version must produce "did not match", not a conclusion.

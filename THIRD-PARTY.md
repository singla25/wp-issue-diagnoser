# Third-party components (Plugin Guard, issue mode)

Everything below runs locally and offline (apart from the Docker sandbox containers, which are described below). Versions are exact and come from `package-lock.json` (run `npm run setup:guard` to install them).
No component calls a network service at run time. Three explicit commands use the network, and only when you run them:
`npm run guard:setup-ocr` (one OCR language file), `npm run guard:setup-sandbox` (pulls the three Docker images below, by digest; `-- --repin` only asks the registry for digests) and `npm run guard:verify-knowledge` (fetches the official pages and plugin source files the knowledge files cite).

## npm packages

| Package | Version | Licence | Kind |
|---|---|---|---|
| acorn | 8.19.0 | MIT | direct |
| acorn-walk | 8.3.5 | MIT | direct |
| jpeg-js | 0.4.4 | BSD-3-Clause | direct |
| minisearch | 7.2.0 | MIT | direct |
| php-parser | 3.7.0 | BSD-3-Clause | direct |
| pixelmatch | 8.0.0 | ISC | direct |
| pngjs | 7.0.0 | MIT | direct |
| postcss | 8.5.32 | MIT | direct |
| semver | 7.8.5 | ISC | direct |
| @playwright/test | 1.64.1 | Apache-2.0 | direct (PDF reports, the page probe, browser tests; Chromium is installed by `npm run setup:guard`) |
| tesseract.js | 7.0.0 | Apache-2.0 | direct |
| bmp-js | 0.1.0 | MIT | transitive |
| idb-keyval | 6.3.0 | Apache-2.0 | transitive |
| is-url | 1.2.4 | MIT | transitive |
| nanoid | 3.3.20 | MIT | transitive |
| node-fetch | 2.7.0 | MIT | transitive |
| opencollective-postinstall | 2.0.3 | MIT | transitive |
| picocolors | 1.1.1 | ISC | transitive |
| regenerator-runtime | 0.13.11 | MIT | transitive |
| source-map-js | 1.2.2 | BSD-3-Clause | transitive |
| tesseract.js-core | 7.0.0 | Apache-2.0 | transitive |
| tr46 | 0.0.3 | MIT | transitive |
| wasm-feature-detect | 1.9.0 | Apache-2.0 | transitive |
| webidl-conversions | 3.0.1 | BSD-2-Clause | transitive |
| whatwg-url | 5.0.0 | MIT | transitive |
| playwright | 1.64.1 | Apache-2.0 | transitive |
| playwright-core | 1.64.1 | Apache-2.0 | transitive |
| zlibjs | 0.3.1 | MIT | transitive |

`jpeg-js` is needed only to decode JPEG screenshots for the OCR variants (pngjs reads PNG only).

## OCR language data

| File | SHA-256 (checked on every load) | Size | Licence | Source |
|---|---|---|---|---|
| `data/ocr/eng.traineddata` | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` | 4113088 bytes | Apache-2.0 | https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata |

The hash was pinned on the first download (trust on first download); nothing independent confirms it. It lives in `data/ocr-pin.json` and here.
The file itself is git-ignored; `npm run guard:setup-ocr` fetches it and refuses a download that does not match the pin.
The npm package `@tesseract.js-data/eng` (MIT in its package.json, no LICENSE file, data originating from the Apache-2.0 Tesseract project) was evaluated and is NOT used; see the decision in the project notes.

## Docker images (sandbox)

Official Docker Hub images, started only by `issue ... --sandbox`, referenced by content digest (a tag can move, a digest cannot) and never pulled by anything except `npm run guard:setup-sandbox`. They are not bundled in this repository.

| Role | Image | Digest | Licence of the software |
|---|---|---|---|
| WP-CLI (PHP 8.1) | `wordpress:cli-2.12.0-php8.1` | `sha256:ab5fb76caa861f32c21e1d95a057f52007f4af7130fb16a0f68874dabe0549a4` | WP-CLI MIT; PHP licence |
| WordPress + Apache + PHP 8.2 | `wordpress:7.1.3-php8.2-apache` | `sha256:2afc151e1a9bdd07eced825e44b5a7e5fc5b8fb0d1ad299d5a5bcd6c294efeb7` | WordPress GPL-2.0-or-later; PHP licence; Apache HTTP Server Apache-2.0 |
| WP-CLI (PHP 8.2) | `wordpress:cli-2.12.0-php8.2` | `sha256:a8eb972af44dd9600db6e6511b66a0c8d5300eb42bf8d3a2f7d2bbb0a95133fb` | WP-CLI MIT; PHP licence |
| WordPress + Apache + PHP 8.3 | `wordpress:7.1.3-php8.3-apache` | `sha256:8901759bfbb7ebc567dbc44a244c0d96d720d0a67c17bc4f42ec355ddba2e863` | WordPress GPL-2.0-or-later; PHP licence; Apache HTTP Server Apache-2.0 |
| WP-CLI (PHP 8.3) | `wordpress:cli-2.12.0-php8.3` | `sha256:6bcc7bb91f5157c4b915e74ee131873e99c1c1ff48f602e4a6f6cd17827305cb` | WP-CLI MIT; PHP licence |
| WordPress + Apache + PHP 8.4 | `wordpress:7.1.3-php8.4-apache` | `sha256:15140904b9d401b9de03d46792d2707ccbaa6408ddde538d7f6c09308030985f` | WordPress GPL-2.0-or-later; PHP licence; Apache HTTP Server Apache-2.0 |
| WP-CLI (PHP 8.4) | `wordpress:cli-2.12.0-php8.4` | `sha256:807d746b7122d004c3d3768d77f221acedbd17b98ffe9646a9388627a36cdbc7` | WP-CLI MIT; PHP licence |
| Database (mariadb) | `mariadb:11.8.9` | `sha256:c4124d1afa875e47f2892edf26b482fa54f796e2f342d3717a04ca091a22a9bd` | MariaDB Server GPL-2.0 |
| Database (mysql) | `mysql:8.0.46` | `sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b` | MySQL Community Server GPL-2.0 |

The digests are in `data/sandbox-images.json` (written by `guard:setup-sandbox -- --repin`). The tags and licences above are as listed on Docker Hub when they were resolved; the images contain further components with their own licences, which Docker Hub lists per image.

Docker Engine / Compose are tools you install yourself (Apache-2.0); rootless mode is recommended.

## Settings data (`data/known-settings.json`)

Hand-written facts about plugins this project does not ship: the label of a setting, where it is, and (where a primary source shows it) the stored key, with the versions it was read in. Sources: the plugins' own documentation pages (docs.wp-rocket.me, woocommerce.com, docs.litespeedtech.com, elementor.com, wordpress.org) and the plugin source at a version tag on plugins.svn.wordpress.org (Autoptimize 3.1.17, LiteSpeed Cache 7.9.2, Elementor 3.20.0 / 3.24.0 / 4.3.5, WooCommerce 11.2.1; all GPL-licensed plugins). Only short phrases are quoted as evidence; no source file or page is copied into the repository. `data/knowledge-verification.json` holds the phrases and short excerpts found. WP Rocket is a commercial plugin: only what its public documentation says is recorded.

## Not used

No generative model and no embedding model is part of this build, and none will be added to issue mode without an explicit decision. Tier 1 (`--semantic`, `all-MiniLM-L6-v2`) is planned, optional, and not installed.

## Knowledge files written by hand, and what "verified" means

`data/feature-taxonomy.json`, `data/known-conflicts.json` and `data/known-settings.json` cite official pages. `data/knowledge-verification.json` records, for 2026-10-27, the result of fetching 86 such pages
(woocommerce.com, developer.woocommerce.com, woocommerce.github.io, developer.wordpress.org, make.wordpress.org, wordpress.org, api.jquery.com, docs.wp-rocket.me, elementor.com):
for every signal or claim phrase, whether it appears in the page text and an excerpt around it. Those excerpts were read by the assistant in the session that ran the check.
- Knowledge-base entry `verified: true`: every cited page was fetched and every claim phrase was found in it. Where the entry's "causes" text goes beyond the page, `beyond_sources` says so.
- Taxonomy entry `verified: true`: every signal was found in a cited page in the form code or documentation would write it. No taxonomy entry reaches this yet; individual signals are listed in `verified_signals`.
- A plugin slug whose wordpress.org page exists is recorded as `existence_only_signals`: the slug is real, the mapping to the feature is not documented.
A phrase being on the page is not proof that the page supports the sentence written in the entry; that is what the excerpts are for.

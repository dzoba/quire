# Third-party software in Quire EPUB Reader for the web

The reader at quireapps.com/epub/ is the Quire EPUB Reader Chrome extension (version 1.0.2) with the browser-extension parts removed. It bundles the following components. Each license file is shipped next to the code it covers, under `app/vendor/foliate-js/`.

| Component | Version | License | Files | Source |
|---|---|---|---|---|
| foliate-js by John Factotum | git commit 78914aef4466eb960965702401634c2cb348e9b1 (2026-05-01) | MIT | `app/vendor/foliate-js/*.js`, license in `app/vendor/foliate-js/LICENSE` | https://github.com/johnfactotum/foliate-js |
| zip.js by Gildas Lormeau, bundled by foliate-js as `vendor/zip.js` | 2.8.22 | BSD-3-Clause | `app/vendor/foliate-js/vendor/zip.js`, license in `app/vendor/foliate-js/vendor/LICENSE-zip.js.txt` | https://github.com/gildas-lormeau/zip.js |
| fflate by Arjun Barrett, bundled by foliate-js as `vendor/fflate.js` | 0.8.2 | MIT | `app/vendor/foliate-js/vendor/fflate.js`, license in `app/vendor/foliate-js/vendor/LICENSE-fflate.txt` | https://github.com/101arrowz/fflate |

The foliate-js files are the same files the extension ships. One file is patched: `paginator.js` has two null guards that stop uncaught errors when a section's document is torn down while a resize or scroll callback is still pending. The exact diff is in `app/vendor/foliate-js/QUIRE-PATCHES.diff`, and each changed line is marked `Quire patch`. The foliate-js demo UI, its PDF.js bundle and its text-to-speech module are not shipped.

The Quire application code (`app/reader.js`, `app/library.js`, `app/lib/`, the HTML and CSS) is Quire's own. The web version removes the extension's service worker, the `chrome.*` API calls, opening books from URLs, and the link-interception and downloads settings. It stores settings, reading positions and bookmarks in `localStorage` instead of `chrome.storage.local`.

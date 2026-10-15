# Third-party software in Quire Markdown for the web

The viewer at quireapps.com/markdown/ is built from the source of the Quire Markdown Viewer Chrome extension (version 1.0.2) with the browser-extension parts removed. Its single script, `app/app.js`, is bundled with esbuild and includes the following packages. Their license comments are kept at the end of `app/app.js`, and the full license texts are in `app/licenses/`.

| Component | Version | License | License file | Source |
|---|---|---|---|---|
| marked | 18.1.0 | MIT | `app/licenses/marked.txt` | https://github.com/markedjs/marked |
| DOMPurify by Cure53 | 3.4.16 | Apache-2.0 or MPL-2.0 (dual licensed) | `app/licenses/dompurify.txt` | https://github.com/cure53/DOMPurify |
| highlight.js (common languages) | 11.12.0 | BSD-3-Clause | `app/licenses/highlight.js.txt` | https://github.com/highlightjs/highlight.js |

The packages are used unmodified. The Quire application code (`app.js`, `render.js`, `find.js`, `io.js`, `storage.js`, the stylesheet and `viewer.html`) is Quire's own. The web version removes opening documents from web links (and the code that fetched them), the extension's service worker and the `?source=` parameter. External links in documents open in a new tab.

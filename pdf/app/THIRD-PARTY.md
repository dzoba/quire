# Third-party software in Quire PDF for the web

Quire PDF bundles PDF.js 6.4.299 by the Mozilla Foundation and contributors, licensed under the Apache License 2.0. The license is kept at `app/pdfjs/LICENSE`. Bundled font and component licenses stay next to their files.

Official source: https://github.com/mozilla/pdf.js/tree/v6.4.299

Official release: https://github.com/mozilla/pdf.js/releases/tag/v6.4.299

Downloaded archive SHA-256 (as recorded for the Quire PDF Chrome extension): f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d

The PDF.js files are copied from the Quire PDF Chrome extension, which already carries these changes: `viewer.html` loads the Quire application layer and has a new title; file opening and merging go through Quire's document lifecycle; Quire replaces the save handling; page copy, cut and paste are switched off; and Quire's application styling is applied. The rendering engine is not presented as Quire's own work. PDF JavaScript, automatic model downloads and XFA support are disabled.

Changes made for the web version:

- The Content-Security-Policy in `viewer.html` allows connections only to the page's own origin (`connect-src 'self' blob: data:`), and the page is marked `noindex`.
- `viewer.mjs` ignores the `?file=` URL parameter, so the viewer never fetches a document named in a URL.
- `viewer.mjs` sends its `webviewerloaded` event to the viewer's own document instead of the embedding page.
- The "Uploading file…" label and the signature-image error that mentions the network connection are reworded in English and removed from other locales, which then fall back to English.
- The scripting sandbox (`pdf.sandbox.mjs`, `quickjs-eval.*`) is not shipped, because PDF scripts are disabled.

## pdf-lib

The single-task tool pages (compress, split, extract pages, rotate, PDF to JPG, JPG to PDF) also bundle pdf-lib 1.17.1 by Andrew Dillon, licensed under the MIT License. The file is `assets/vendor/pdf-lib/pdf-lib.esm.min.js` from the npm package `pdf-lib@1.17.1` (tarball SHA-256 a7cc1eaf12e41e612a7be581162a63b18118aefc01e90f6a1f35347b1f324a1c). The only change is that the final `//# sourceMappingURL` comment was removed, because the source map is not shipped. SHA-256 of the shipped file: a4eb247afbb2d445e4b0e2ed1e4bee9dd8c7f3a26f5965b9e11afb615d4c53f5.

Source: https://github.com/Hopding/pdf-lib/tree/v1.17.1

That build includes these packages, each under its own license, kept beside it in `assets/vendor/pdf-lib/`:

- pdf-lib 1.17.1, MIT (`LICENSE-pdf-lib.md`)
- pako 1.0.11 by Vitaly Puzrin and Andrei Tuputcyn, MIT (`LICENSE-pako.txt`)
- @pdf-lib/upng 1.0.1, a fork of UPNG.js by Photopea, MIT (`LICENSE-upng.txt`)
- @pdf-lib/standard-fonts 1.0.0, MIT (`LICENSE-standard-fonts.md`)
- tslib 1.14.1 by Microsoft, 0BSD (`LICENSE-tslib.txt`)

## PDF.js license files

These license files are kept beside their components:

- `app/pdfjs/LICENSE`
- `app/pdfjs/web/cmaps/LICENSE`
- `app/pdfjs/web/standard_fonts/LICENSE_FOXIT`
- `app/pdfjs/web/standard_fonts/LICENSE_LIBERATION`
- `app/pdfjs/web/iccs/LICENSE`
- Every `LICENSE*` file in `app/pdfjs/web/wasm/`, covering the PDF.js wrappers and the bundled QCMS, OpenJPEG and JBIG2 components.

Source maps, debugger tooling and the upstream TraceMonkey sample PDF are not included. Fonts, CMaps, color profiles, WASM and fallback code, locales, images and licenses are all served from the same site. No remotely hosted code is used.

# Third-party libraries (MailMerge Guard)

This version loads the following exact library versions via **HTTPS from jsDelivr** when the tool runs. An internet connection is needed. They are not bundled in this ZIP:

- PDF-Lib 1.17.1 (MIT): https://github.com/Hopding/pdf-lib — `https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js`
- Papa Parse 5.7.0 (MIT): https://github.com/mholt/PapaParse — `https://cdn.jsdelivr.net/npm/papaparse@5.7.0/papaparse.min.js`
- Mozilla PDF.js 5.7.284 (Apache-2.0): https://github.com/mozilla/pdf.js — `https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.mjs` and `https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.worker.mjs`

Included locally:

- JSZip 3.10.1 (MIT / GPL-3.0-or-later): https://github.com/Stuk/jszip — `vendor/jszip.min.js`, license at `vendor/JSZip-LICENSE.md`.

The runtime downloads library code from a third-party CDN. The app's own JavaScript does not intentionally upload selected PDF or CSV contents; the browser still makes requests for web assets. Do not claim the application is independently audited or guaranteed safe. Review and update dependency versions periodically.

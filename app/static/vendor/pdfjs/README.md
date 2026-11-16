# PDF.js (vendored)

The eBook reader (`app/static/js/pages/reader.js`) renders PDF books with
Mozilla's PDF.js, served from this folder so the site's `script-src 'self'`
policy holds. Apache-2.0: see `LICENSE` here, and the `LICENSE_*` files beside
the fonts and decoders for their own terms.

- Package: `pdfjs-dist@6.4.299` from npm
  (integrity `sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`).
- `pdf.min.mjs`, `pdf.worker.min.mjs`: the package's `legacy/build` (it carries
  its own polyfills; the modern build needs this year's browsers).
- `cmaps/`, `standard_fonts/`: as published, for PDFs whose fonts are not
  embedded or use CJK encodings.
- `wasm/`: only the two JavaScript decoders (JPEG 2000 and JBIG2 images). The
  reader turns WebAssembly off, so the site's policy needs no
  `'wasm-unsafe-eval'`.

Nothing here is edited. To update: `npm pack pdfjs-dist@<version>`, copy the
same files from the tarball, change the version above, and check a PDF in
the reader on dev (`node app/tests/js/reader_pdf.mjs` covers only the reader).

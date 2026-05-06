# NOTICE — Third-Party Attributions

This package contains source code derived from the following projects. All
derived files preserve attribution in their file headers; this NOTICE is the
top-level summary.

## MIT-licensed sources

### shc-web-reader — © 2023 The Commons Project (MIT)
Source: https://github.com/flexpa/shc-web-reader

Derived files in this package:
- `src/coding/coding-display.ts` — patterns from `src/lib/codes.js`
  (`getDeferringCodeRenderer`, `safeCodingDisplay`, `safeDisplaySync`).
- `src/coding/code-systems.ts` — pattern from `src/lib/codes.js:19-106`
  (CodeSystem URI registry).
- `src/staging/variable-precision-date.ts` — pattern from `src/lib/fhirUtil.js:189-230`
  (`parseDateTimePrecision`, `parseDateTime`, `PRECISION_*` constants).

The full MIT license text is reproduced in
`reference-repos/flexpa/shc-web-reader/LICENSE` (clone-time copy).

### sql-on-fhir-v2 — © 2018-2023 Nikolai Ryzhikov, Dan Gottlieb, FHIR Community,
### Health Samurai (MIT)
Source: https://github.com/FHIR/sql-on-fhir-v2

If/when `sof-js` is vendored into a server (planned, not in this commit), it
will be attributed in the consuming server's source tree. No code is currently
derived from this project in `@bio-mcp/shared`.

## Public-domain / freely-licensed code dictionaries

The hand-curated dictionary stubs under `src/coding/dicts/` use codes from:

- **LOINC®** — © 1995 Regenstrief Institute, Inc. and the LOINC Committee.
  Codes used under the LOINC license (no cost). See
  https://loinc.org/terms-of-use/. Attribution preserved in
  `src/coding/dicts/loinc-vitals.ts`.
- **ICD-10-CM** — public domain, published by CMS and CDC NCHS. See
  `src/coding/dicts/icd10-chapters.ts`.
- **RxNorm** — public domain, published by the U.S. National Library of
  Medicine. No bundled dict at this time.

**Not bundled**: SNOMED CT (CC-BY 4.0 — would require attribution propagation
to all downstream Workers; deferred until a documented attribution strategy
is in place).

# Changelog

## [Unreleased]

### Fixed

- Content finding maps case-insensitive UTF-16 offsets to full original character boundaries, including astral and expanding lowercase text; final and ordinary Greek sigma now match consistently across cases.
- Dense and oversized match ranges now return useful bounded excerpts; formatting and truncation notices remain within the output limit, and only fully represented matches are counted.
- Natural and budget-cropped excerpt edges preserve complete Unicode scalars in exact, case-insensitive, and fuzzy searches without rewriting source text or match offsets.
- Fixed two regular expressions that could freeze the process on fetched content (`source_check` clause splitting and `Link` header parsing), exponential Next.js RSC reference expansion, the data-URI sanitizer mangling code such as `data: Buffer`, fuzzy `findText` ignoring CRLF paragraph breaks, slow case-insensitive `findText`, and duplicate HTTP fetches when `http` was not the first fetch provider. RSC extraction is bounded and marks truncated output, and case folding no longer depends on the host locale.

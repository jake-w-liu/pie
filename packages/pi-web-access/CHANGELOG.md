# Changelog

## [Unreleased]

### Fixed

- Content finding maps case-insensitive UTF-16 offsets to full original character boundaries, including astral and expanding lowercase text; final and ordinary Greek sigma now match consistently across cases.
- Dense and oversized match ranges now return useful bounded excerpts; formatting and truncation notices remain within the output limit, and only fully represented matches are counted.
- Natural and budget-cropped excerpt edges preserve complete Unicode scalars in exact, case-insensitive, and fuzzy searches without rewriting source text or match offsets.

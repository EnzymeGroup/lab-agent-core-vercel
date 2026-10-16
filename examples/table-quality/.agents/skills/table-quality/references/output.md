# Output contract

profile.json keeps source SHA256, ordered headers, all rows as arrays of unmodified strings, row/column counts and per-column empty_cells, absent_cells and distinct_present counts. Distinct-present counts include literal NA and exclude empty/absent values. Ragged rows retain their original length. report.md displays missingness counts. No unit inference or label repair is allowed.

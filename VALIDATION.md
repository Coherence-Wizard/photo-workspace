# Release validation

Version 0.0.2 is the first public release; earlier version numbers were local development builds.

- TypeScript checking and production bundle build.
- Python integration tests with ExifTool: metadata read/write, read-only catalog protection, partial scan errors, recovery, undo, file operations, batch tag deletion, and direct/recursive folder browsing.
- TypeScript tests: image math, selection, hierarchy parsing, and proportional resize.
- macOS live checks cover the photo workspace, grid/preview navigation, metadata tools, and export controls.
- A large removable-drive collection (over 160,000 image files) was scanned; unreadable files are reported without discarding valid results.

Windows/Linux graphical interaction and wider RAW/color-management acceptance remain open. CI builds and integration tests do not certify every desktop workflow or camera format. Only digiKam SQLite schema 17 has been tested directly; other schemas are validated for required tables but are not certified.

See README.md for external helper requirements, metadata behavior, and privacy disclosures.

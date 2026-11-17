# Release validation

Version 0.0.4 renames the plugin to Coherence Photo and continues the desktop beta with keyboard tag submission, adjustable crop handles, clockwise rotation, and folder-only photo libraries.

Automated tests use disposable generated PNGs and a plugin-owned SQLite index. ExifTool must be installed; integration tests are skipped otherwise.

- Metadata read/write, nested tags, ratings, labels, Unicode and multiline transport.
- Partial scan errors, rebuildable indexes, query paging and folder hierarchy.
- Batch tag rename/delete, recovery, undo, conflicts, file moves and copies.
- Keyboard tag selection, comma-separated entry, empty-field Enter submission, IME guards.
- Crop movement and all eight resize handles at image boundaries, fixed ratios, and reverse-direction drawing.
- Rotation dimensions, four-turn restoration, existing crop transformation, and unchanged adjustment settings.
- Export dialog visibility and proportional resize.

CI checks Windows, macOS, and Linux. Live graphical checks are primarily on macOS; CI does not certify every native file dialog, camera format, or color profile. RAW development, high-bit-depth editing, multi-instance writing, and comprehensive screen-reader acceptance remain outside this beta's validated scope.

The previous folder index layout and key derivation are retained, preserving existing IDs and recipe/undo references. Old external-database settings no longer select a connection. Embedded metadata and compatibility namespaces remain readable by other applications.

# Release validation

Version 0.0.5 adds thumbnail keyboard controls, original-file saves with recovery, export format choices, and collapsible adjustment controls to the desktop beta with keyboard tag submission, adjustable crop handles, clockwise rotation, and folder-only photo libraries.

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

Pixel-save integration checks cover exact-byte backup restoration, metadata preservation, dimensions, source conflicts, invalid encoding, interrupted-save recovery, and partial undo. UI callback tests cover grid navigation/pagination, shortcut scoping, export controls, folder-wide saves and recipe recovery. CI uses an Intel macOS runner to avoid the observed hosted ARM capacity cancellations; local checks also run on Apple silicon.

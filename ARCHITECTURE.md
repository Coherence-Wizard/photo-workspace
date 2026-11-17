# Architecture

`src/main.ts` registers views, commands, settings, and serialized metadata batches. `src/views.ts` provides the tag/folder trees, attribute filters, thumbnail browser, preview, and inspector. New views should consume the photo/query/recipe contracts in `src/types.ts`.

`src/bridge.ts` starts the bundled Python helper for each request, using JSON over standard streams. There is no network listener. Python uses only its standard library and runs ExifTool with argument arrays and UTF-8 argument files. Child processes stop when the plugin unloads.

`src/bridge.py` scans the selected photo folder into a plugin-owned SQLite index under `local-data/folder-indexes`. Queries use read-only connections, parameter binding, bounded paging, and a temporary table for committed metadata awaiting index refresh. No external photo-application database is connected or modified. The index schema and identity remain compatible with earlier folder libraries to preserve photo IDs, recipes, and journals.

The index is a cache of file metadata. Tags, nested tags, ratings, titles, and captions are read from the files and written through ExifTool. Compatibility XMP namespaces are retained so other photo applications can read existing metadata; those namespace names do not require their originating applications. Legacy internal label names remain readable in older plugin indexes.

The write journal records original hashes, backup paths, target hashes, metadata, and batch IDs before replacement. States include prepared, committed, undo-prepared, undone, aborted, conflict, and released. Recovery compares hashes after interruptions; undo refuses to overwrite external changes or use damaged backups. File operations have their own recovery journal and retain image IDs for plugin-initiated moves. Readers commit temporary-overlay transactions before separate index writers run.

`src/image-engine.ts` decodes photos, caches thumbnails, renders image adjustments, and exports canvas pixels. `quarterTurns` is an optional recipe field for backward-compatible clockwise rotation. Odd turns exchange canvas dimensions; straighten remains a separate angle. Crop coordinates rotate with the image so existing framing is retained.

`src/crop.ts` implements bounded movement and eight-handle resizing, with normalized aspect ratios. Preview stores a separate crop draft. Pointer movement changes the draft only; Apply/Enter commits one recipe history entry, and Cancel/Escape discards it. Recipes remain separate until the user invokes Save. `src/save-edits.ts` renders full-resolution JPEG/PNG/WebP pixels and submits an expected source hash to the bridge. Pixel saves use the same prepared/committed journal protocol with a distinct record kind, full original backups, and format/dimension verification. Save receipts reconcile interrupted recipe clearing on restart; neutral recipes are skipped to avoid repeated recompression.

Tag entry uses Obsidian suggestions. Enter selects a suggestion or queues typed tags. An empty-field Enter submits queued tags; IME composition and repeated keydown are ignored. Closing the dialog restores photo-view focus. Metadata assignment and edit recipe persistence are separate flows.

`src/system.ts` handles reveal/open-with and system Trash. `src/export.ts` supports selection, filter, tag, and folder exports with conditional controls and proportional resize. Rendered JPEG/PNG/WebP metadata is normalized and stale face-region geometry removed. `src/encoding.ts` verifies the encoder MIME type and flattens JPEG transparency to white. `src/copy-original.ts` copies untouched originals and existing sidecars byte-for-byte with exclusive destination creation and rollback on collisions.

## Extension paths

- Timeline: date-group queries with shared selection and inspector.
- Faces: an explicit region/person metadata adapter; no recognition is currently implemented.
- Map: coordinate queries and explicit provider selection before using any remote map service.
- More formats and color depth: replace the renderer without silently changing existing recipe semantics.
- Vault-tag mappings: explicit mappings between Markdown tags and image metadata tags.

Settings, recipes, unused custom tags, and undo history remain plugin data. They must not be described as portable embedded image metadata. Multiple instances writing the same collection are not supported.

# Architecture

`src/main.ts` owns plugin registration, settings, operation progress, and the active photo browser. All writes pass through one serialized metadata batch. Ordinary Obsidian leaves provide the tags, filters, browser, and inspector.

`src/views.ts` renders those leaves. The browser owns its query, current selection, scroll position, preview, and edit history. Other views act on the active browser. Stable catalog and image IDs identify notes and recipes.

`src/types.ts` defines the shared photo, query, recipe, and settings contracts. Additional views should consume these contracts rather than implement a second metadata layer.

`src/bridge.ts` invokes the embedded `bridge.py` using a local Python interpreter. Requests and responses are JSON over standard streams. There is no TCP listener. Child processes are terminated on plugin unload; the write journal recovers interrupted operations on reconnect.

`src/bridge.py` contains the SQLite catalog reader, collection resolver, pending overlay queries, metadata writer, and undo journal. SQLite opens the source catalog in `mode=ro`; TEMP tables hold local overlays and `PRAGMA query_only=ON` protects subsequent queries. Queries use parameter binding for user input, an allowlist for sort columns, bounded page sizes, and visible-photo status/category predicates. The plugin never opens a write connection to the source catalog.

The initial transport launches a process per request. That avoids native Node ABI dependencies and full database copies, handles WAL correctly, and works with Python's standard library. A persistent worker or signed bundled helper can later replace this transport without changing the JSON contracts.

`src/image-engine.ts` handles local decoding, bounded concurrent thumbnail generation, a capped thumbnail URL cache, image transforms, histograms, and color adjustments. Recipes are normalized parameters. A future high-bit-depth engine can replace this implementation while maintaining versioned recipes; existing recipe semantics must not silently change.

## Future view integrations

- **Timeline:** extend catalog queries with date-group aggregates; reuse selection and inspector.
- **Faces:** read existing person/region assignments through a dedicated read adapter before adding any recognition or region-writing features. Internal recognition tables are not regular tag labels.
- **Map:** add coordinate queries, viewport filtering, and an explicit map-provider setting. Keep location processing local unless the user configures a provider.
- **MariaDB:** add a backend adapter with the same catalog/query/photo contract, secure credential storage, and connection-specific compatibility tests.
- **Vault tag mappings:** store an explicit mapping between Obsidian hashtags and photo tag paths. Do not infer identity from tag spelling.
- **Metadata profile support:** import or configure digiKam namespace read priorities. The initial writer supports digiKam tags, Lightroom hierarchical keywords, Dublin Core subjects/titles/captions, XMP ratings, digiKam labels, and the ACDSee rating compatibility field.
- **Automatic catalog refresh:** first establish a supported integration and verify concurrent behavior on each supported digiKam release. Do not bypass the journal with ad hoc SQL writes.

## Journal states

Each photo operation records a UUID, batch ID, original hash, backup path, target hash, and desired metadata before replacement. States are `prepared`, `committed`, `undo-prepared`, `undone`, `aborted`, `conflict`, and `released`. Staged metadata is written in the target directory, then replaced atomically. Recovery compares hashes to distinguish completed writes from interruptions. Undo refuses to restore over external changes and checks backup integrity first.

Cross-application filesystem writes cannot form a single transaction with digiKam's database. The visible pending overlay is intentional. Refreshing the catalog must not silently discard pending writes or resurrect removed tags.


## Photo workflow extensions

Folder mode builds a plugin-owned SQLite index using ExifTool in bounded groups. The digiKam adapter continues to open its source database read-only. Both expose the existing query/metadata contract. File operations journal path changes, preserve metadata-journal targets, and retain IDs for plugin-initiated moves in folder mode. System app launching and Trash live in `system.ts`; batch resizing/export lives in `export.ts`. Tag suggestions use Obsidian AbstractInputSuggest. Tags and vault folders have separate scroll containers.

# Photo Workspace

Browse a photo folder or digiKam collection inside Obsidian, assign hierarchical metadata tags in batches, and edit images without overwriting the originals.

**Version 0.0.2 is the first public desktop release. Community-directory availability depends on Obsidian review.**

## Included

- Photo counts beside tags and folders (including descendants); click a folder to browse its photos in the grid, and use its chevron to expand subfolders.
- Independently scrollable tags and vault folders in the left sidebar, each with expand/collapse-all controls, plus an attribute filters tab.
- Native tag suggestions while typing; right-click tags to review and apply collection-wide rename/delete, including optional subtags.
- Photo context menus in grid and preview: Open With Explorer (Finder on Mac), Open With App, Add Tag, Cut, Copy, Paste, Rename, Delete, and export.
- Preview zoom slider (10–400%) with drag-to-pan.
- Multi-select “I’m Feeling Lucky” with batch recipe undo; export selection, matching filters, a tag, or a collection folder with proportional resize.
- Paged thumbnail grid with adjustable thumbnail size, single / Cmd-Ctrl / Shift selection, and drag-and-drop assignment to tags.
- Double-click preview with fit, actual-size display, previous / next, and Escape back to the grid.
- Inspector with metadata, batch star ratings, digiKam color labels, pick labels, titles, captions, and tags.
- Filters for collection, album, text, nested tags, rating, color, pick, date, camera, lens, format, orientation, GPS presence, and untagged photos. Save reusable filters.
- Exposure, contrast, highlights, shadows, white-balance adjustments, saturation, vibrance, levels, free/fixed/custom crop, straighten, and “I’m Feeling Lucky” automatic levels.
- Persistent adjustment recipes, before/after comparison, adjustment undo/redo, and full-resolution sRGB PNG exports with metadata copied when ExifTool is available.
- XMP sidecar or embedded metadata writing, a durable per-file journal, conflict detection, and batch undo.
- Photo notes with stable catalog/image links back into the plugin.

## Requirements

- Obsidian desktop 1.8.0 or newer. Local manual testing uses macOS and Obsidian 1.15.1.
- Either a photo folder (no digiKam installation or database needed), or a local digiKam SQLite core catalog (`digikam4.db`). Schema 17 is the tested schema. The reader validates core tables and reports incompatible catalogs; it never migrates them.
- Python **3.10 or newer** with its standard `sqlite3` module. No Python packages are required.
- [ExifTool](https://exiftool.org/) for folder scans, metadata writes, metadata-preserving exports, and embedded RAW previews.
- Access to the collection's image folders. The database and image files can live outside the Obsidian vault.

On macOS, the plugin detects Homebrew / local Python installations and ExifTool bundled with digiKam when available. Windows and Linux accept explicit executable paths; no runtime downloads or installation scripts run inside the plugin. These operating systems still require live acceptance testing before a stable public release.

## Keyboard and folder browsing

While a photo view has keyboard focus, **1–5** assigns that rating to selected photos. In preview, **← / →** advances through the collection (including the next page), **T** opens Add tags, and **Escape** returns to thumbnails. Shortcuts do not run while typing into inputs. Assign custom shortcuts under **Settings → Hotkeys**, searching for **Photo Workspace**. Commands include ratings 0–5 (0 clears ratings), previous/next preview, adding tags, grid view, export, and batch automatic levels.

In the connection settings, **Include subfolders when browsing** controls folder clicks. On shows photos directly in the selected folder first, then each subfolder in alphabetical hierarchy order, separated by folder headings as you scroll. Off shows only the selected folder's own photos. Sorting applies within each folder, and additional pages load as you scroll.

Select multiple tags with **Cmd-click** (Mac) or **Ctrl-click** (Windows/Linux), or **Shift-click** a range. Right-click the selection to delete all selected tags from matching photos in one undoable batch. The review shows a distinct photo count, and you can choose whether to include subtags.

## Installation

1. Create or open the Obsidian vault you want to use for photos.
2. Copy the `photo-workspace` release folder into `<vault>/<config directory>/plugins/`. The default configuration directory is `.obsidian`.
3. Enable **Photo Workspace** under Settings → Community plugins.
4. Run **Photo Workspace: Open photo workspace** from the command palette, or click its images ribbon icon.
5. Open **Connect** and choose **Photo folder** or **Existing digiKam database**. For folder mode, choose **Use this vault** or enter a full photo-folder path, then click **Scan photos**. For digiKam mode, choose `digikam4.db` and test the connection. **Detect** can read the standard local digiKam configuration.
6. Map each collection to its actual root folder. Removable drives require an explicit mapping; a proposed path is never silently accepted.

The plugin arranges two left sidebar views, a center photo tab, and a right inspector. These are ordinary Obsidian views and can be moved or resized.

## Working without digiKam

Choose **Photo folder** in settings. Python and ExifTool are still required, but digiKam is not. The plugin creates its own local index under `local-data/folder-indexes`, reads embedded metadata, and scans the selected folder recursively. Hidden folders and symbolic links are excluded. Click Refresh/Scan after files change outside the plugin; unchanged files are skipped. If explicitly using sidecar mode, matching sidecars are included in the scan. Recipes and IDs survive moves performed through the plugin; external renames may get new IDs.

**Scan photos** reads embedded tags, ratings, labels, and properties and updates a local index. It does not change image files or create sidecars. Progress appears during scanning; a persistent green **Verified** result confirms a complete scan. Unreadable files produce a warning and a file list while valid results stay available. Completed batches are retained if a long scan is interrupted. The first scan of a large collection can take time; subsequent scans reuse unchanged files.

Tag creation accepts commas, for example `Art, Adventure, Places/Oregon/Coast`. These create three tags; assigning them writes them to selected photos.

Existing digiKam mode needs only the database and accessible image files; digiKam does not have to be running. If the plugin currently uses ExifTool bundled inside digiKam, install ExifTool separately before uninstalling digiKam.

The settings include a beginner setup guide with official download links and a **Check helpers** button. Download current stable Python from [python.org](https://www.python.org/downloads/), and follow the platform-specific [ExifTool installer instructions](https://exiftool.org/install.html). [digiKam](https://www.digikam.org/download/) is optional.

## File and tag actions

Right-click a photo in the grid or preview. **Open With Explorer** reveals it in Finder/File Explorer. **Open With App** opens the system application chooser (Linux lists registered image applications from standard `.desktop` folders and launches the selection using `gio`). Cut/Copy/Paste use the plugin's internal photo clipboard, not the operating system clipboard. Paste accepts destinations inside a mapped collection. Copies receive unique names. Rename keeps the extension; recognized sidecars follow the file. Delete asks for confirmation and uses system Trash/Recycle Bin. Restore files there and refresh; Metadata Undo is not a file-deletion undo. File operations and app choosers still need Windows/Linux live acceptance testing.

In digiKam mode, file moves use local path overrides so this plugin can keep finding the image. Rescan the affected folders in digiKam to update its database. New copies become visible in digiKam mode after that rescan. Folder mode indexes copies on refresh. digiKam may assign new IDs after external moves, so reconnecting a moved image's old recipe in digiKam mode may require manual attention.

Right-click a tag and choose Rename or Delete. The dialog shows the affected photo count before applying. These actions span the whole connected collection, not just the loaded thumbnails. Include subtags is optional; unrelated tags are preserved. Unsupported/offline files are reported individually. Metadata Undo restores successful writes. Tag suggestions show the effective tags present in photos plus locally created tags.

## Batch adjustment and export

Select multiple thumbnails, then click **I’m Feeling Lucky** to save automatic-level recipes for the selection. Original pixels stay unchanged. **Undo batch adjustment** restores the previous recipes from the last batch. This batch undo is separate from metadata undo.

Choose **Export photos…** for selected photos, all current filter matches, a tag including subtags, or a collection folder including subfolders. Destination may be a new vault-relative folder or an absolute folder elsewhere. Exports apply saved adjustments and create PNGs with metadata. The dialog only shows settings relevant to the selected photo source and resize mode. Resize can fit within a maximum width/height, use a percentage, or retain edited dimensions; aspect ratio is preserved and enlargement is off by default. Existing files are never overwritten. Exports run sequentially with progress, cancellation between photos, and per-photo errors. RAW embedded previews cannot be exported as full-resolution images. Limits: 60 megapixels and 30,000 pixels per edge.

## When changes are saved

Creating a tag only creates an available tag name. In the Add tags dialog, choosing a suggestion adds it to the pending selection; **Apply tags** writes it to the selected images immediately. Dragging photos onto a tag and assigning a star rating also write immediately when metadata writing is enabled. No export or separate save button is needed. Failed writes are reported. **Undo metadata** restores successful writes.

Image adjustments work differently: they save an editing recipe automatically. **Export copies** applies that recipe to new image files.

## Metadata and digiKam synchronization

In digiKam mode, the catalog connection is **read-only**. Metadata changes are saved to image files or XMP sidecars, then shown immediately using a local pending overlay. The plugin does not write SQL into digiKam's live database.

Metadata writing starts disabled in a normal installation. Enable it after checking your collection mappings and choosing a write destination:

- **XMP sidecar:** keeps the original photo bytes unchanged. This is optional. Choose `photo.jpg.xmp` (digiKam default) or `photo.xmp`. Shared-stem sidecars are rejected when multiple images share that filename stem.
- **Embedded (default):** supported for JPEG, PNG, TIFF, and WebP. The entire pre-write file is backed up locally for undo. RAW and other unsupported embedded writes are refused with a per-photo error; the plugin never silently falls back to sidecars. ExifTool updates metadata without re-encoding image pixels.

Existing sidecars are not automatically deleted or migrated. digiKam may still prioritize an existing sidecar over embedded metadata. Before switching destinations on a photo with pending changes, undo those changes or import them into digiKam and release the pending overlay.

For sidecars, configure digiKam to **read from XMP sidecar files**, matching your chosen sidecar filename convention. digiKam can prioritize sidecar metadata over embedded metadata; new sidecars are seeded from the image and include catalog tags and selected catalog fields. Existing sidecars preserve other metadata fields.

After writing, in digiKam use **Item → Reread Metadata From File**, or **Tools → Maintenance → Metadata Synchronizer → From files to the database**. The precise menu wording depends on digiKam version. There is no guarantee of immediate refresh in a running digiKam instance.

The plugin displays **“Metadata saved; digiKam refresh pending”** until you review and release the local overlay in connection settings. Do this only after digiKam has imported the metadata. Releasing an overlay accepts the current catalog and ends that operation's plugin undo history; it does not modify the photo files. Reloading the plugin does not lose pending changes.

If metadata changed externally while an operation is pending, further writes and undo stop for that photo instead of overwriting the other application's change. Review the photo in digiKam, reconcile its metadata, then release the pending overlay before retrying.

Batch cancellation stops between groups of five photos. Completed files remain saved and can be undone. A batch is not a cross-file database transaction; failures are reported per photo.

## Image editing

Double-click a photo. The inspector then displays adjustment controls. Draw crop rectangles on the preview, choose a fixed ratio or enter a custom width:height ratio, and use the straighten slider. Hold **Before** to compare with the original.

Recipes are stored in the vault's plugin data. They are not digiKam editing-history recipes. **Export copy** renders an 8-bit sRGB PNG into the configured vault folder, preserves photo metadata when possible, resets orientation/dimension metadata, and removes stale face-region geometry. Original image pixels are never overwritten by the editor.

Export names are made unique. Exports are not automatically inserted into digiKam's database: put the export folder in a digiKam collection and rescan if you want them cataloged.

JPEG, PNG, WebP, and browser-decodable AVIF/GIF can be previewed directly. Other formats use an available embedded JPEG preview via ExifTool. Full RAW development is not implemented; export from embedded previews is disabled. Editing exports are limited to 60 megapixels. HDR / high-bit-depth editing is not part of this release.

“I’m Feeling Lucky” applies a conservative histogram-based automatic levels adjustment with a strength control. It does not upload images or use a remote AI service.

## Data and privacy

- No accounts, analytics, telemetry, network requests, or cloud services.
- Accesses files outside the vault when you choose an external photo collection, digiKam database, helper executable, or export destination. Reads the chosen database, collection files, and optionally digiKam's local configuration; writes only requested metadata, file operations, and exports there.
- Writes requested metadata/sidecars, local indexes and journals, adjustment recipes, photo notes, and exported images. Explicit Cut/Paste, Rename, and Delete actions also move, copy, rename, or trash the selected photo files and their sidecars.
- Python and ExifTool are executed as local child processes with argument arrays; shell interpolation is not used.
- Settings and recipes use Obsidian's plugin data storage. Journal files and backups are stored under the plugin folder's `local-data` directory. Backups may contain entire original images in embedded mode. Include this directory in your backup policy and consider its size if you sync plugin folders.
- Each machine may need different executable paths and collection mappings. Multi-machine simultaneous writing is not supported. Do not sync a live SQLite catalog as a substitute for a database server.
- Uninstalling the plugin removes access to its local undo history; committed metadata remains in the photos/sidecars. Save `local-data` elsewhere if you need to retain backups.

## Development and verification

```sh
npm ci
npm run build
npm test
npm run package
```

The build embeds the Python bridge in `main.js`, so the installed plugin needs only `main.js`, `manifest.json`, and `styles.css`. At runtime it extracts the bundled bridge into `local-data/runtime` before launching Python. Python and ExifTool executables remain separate local dependencies.

Tests create disposable PNGs and a digiKam-shaped SQLite catalog. They cover read-only WAL access, hierarchy filtering, paging, labels, metadata preservation, sidecar round trips, stale catalog overlays, recovery, undo conflicts, path restrictions, and the image adjustment math. ExifTool integration tests are skipped when ExifTool is unavailable; release validation must run with it installed.

See [VALIDATION.md](VALIDATION.md) for the completed local checks and remaining acceptance tests.

## Planned extensions

See [ARCHITECTURE.md](ARCHITECTURE.md) for extension boundaries and [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) for release validation status. Timeline, map, existing face assignments, RAW development, MariaDB, automatic digiKam synchronization, and editable vault-tag mappings are not included in 0.0.2.

## Upstream references

- [digiKam database](https://docs.digikam.org/en/getting_started/database_intro.html)
- [digiKam metadata settings](https://docs.digikam.org/en/setup_application/metadata_settings.html)
- [digiKam metadata synchronizer](https://docs.digikam.org/en/maintenance_tools/maintenance_metadata.html)
- [ExifTool XMP tags](https://exiftool.org/TagNames/XMP.html)
- [Obsidian submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)

Independent community project; not affiliated with or endorsed by digiKam or Obsidian.

## Support and license

Report bugs and feature requests in [GitHub Issues](https://github.com/Coherence-Wizard/photo-workspace/issues). Include your operating system, Obsidian/plugin version, source mode, and error text. Do not upload private photos or databases. Photo Workspace is released under the [MIT License](LICENSE).

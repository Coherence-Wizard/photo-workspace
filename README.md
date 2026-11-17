# Coherence Photo

**A beta plugin, still in testing, that brings Obsidian’s local-file-first philosophy to your photo library.**

Your photos belong to you, and so should the work you put into organizing them. Coherence Photo saves tags, nested tags, and ratings directly into supported image files. The time you spend building a collection stays with the photos instead of being locked inside one program’s proprietary database. Move your folders, back them up, or open them in another application that reads the same metadata.

This simple plugin lets you work with image metadata and your existing folder system inside Obsidian. Browse thumbnails, organize photos with tags and nested tags, rate images, make basic photo edits, and export collections selected by tags, ratings, or other properties—with optional resizing.

Tagging is the primary workflow, so keyboard controls come first: use **← / →** to advance through photos, **T** to add tags, and **1–5** to assign a rating. Type a tag and press **Enter** to select or queue it. With the entry field empty, press **Enter again** to save your queued tags, then move on to the next photo. Multiple new tags can be separated by commas; use `/` for nested tags.

**Requires Obsidian desktop, Python 3.10 or newer, and ExifTool.** Install the two helpers separately; the plugin’s settings include step-by-step instructions and a **Check helpers** button. No account, cloud service, or other photo application is required.

[Install from the Obsidian Community directory](https://community.obsidian.md/plugins/photo-workspace) · [GitHub releases](https://github.com/Coherence-Wizard/photo-workspace/releases) · [Report an issue](https://github.com/Coherence-Wizard/photo-workspace/issues)

## What travels with your photos

Embedded metadata writing supports **JPEG, PNG, TIFF, and WebP**. ExifTool updates metadata without re-encoding image pixels. Nested keywords and ratings are stored in widely used XMP fields, with compatibility fields for applications that use them. Other programs differ in which fields and hierarchies they display; portability does not mean every application interprets everything identically.

The plugin maintains a **rebuildable local index** for fast browsing. Your saved tags and ratings remain in the files if you stop using the plugin. Edit recipes, saved filters, unused tag names, photo-note links, and undo backups are stored in the vault and are not portable image metadata.

Optional XMP sidecars are available for users who want them. Unsupported embedded formats report an error; the plugin never silently creates sidecars. Keep any deliberately created sidecars beside their photos. Existing sidecars are not deleted or migrated automatically, and other applications may prioritize them over embedded metadata.

Version 0.0.4 renames Photo Workspace to **Coherence Photo**. Existing settings, photo indexes, and keyboard shortcuts carry over automatically.

## Getting started

1. Install Coherence Photo from **Settings → Community plugins → Browse** and enable it.
2. Install [Python](https://www.python.org/downloads/) and [ExifTool](https://exiftool.org/install.html). Restart Obsidian afterward.
3. Open **Coherence Photo: Open photo library** from the command palette or the images ribbon icon.
4. Open **Connect**, choose **Use this vault** or enter a full photo-folder path, and click **Check helpers**, then **Scan photos**.
5. Enable **Metadata writing** when you are ready to assign tags and ratings. It starts disabled for new installations.

**Scan photos** reads existing metadata into the local index. It does not change your images. It scans subfolders, skips hidden folders and symbolic links, and reuses unchanged files on later scans. A green **Verified** result confirms a complete scan; unreadable files are listed while valid results remain available. Refresh after files are changed by other applications.

You may keep photos inside or outside the vault. Removable drives must be connected at the configured path. No Python packages are needed. The plugin does not download or install its helpers automatically.

## Organize and browse

- Independently scrollable tag and vault-folder trees, photo counts, and expand/collapse-all controls.
- Click a folder to show thumbnails. **Include subfolders when browsing** chooses direct-folder photos only or a scrolling hierarchy with folder dividers.
- Cmd/Ctrl-click or Shift-click to select multiple photos. Drag them onto a tag to assign it to every selected photo.
- Type to find existing tags. Right-click tags to rename or delete them across the collection. Select multiple tags with Cmd/Ctrl or Shift to delete them in one reviewed batch; including subtags is optional.
- Filter by tag, folder, text, rating, color or pick label, date, camera, lens, format, orientation, GPS presence, or untagged photos. Save filters for reuse.
- Resize thumbnails; double-click for preview, with a zoom slider and drag-to-pan.
- Right-click photos for **Open With Explorer** (Finder on Mac), **Open With App**, **Add Tag**, **Rotate**, **Cut**, **Copy**, **Paste**, **Rename**, **Delete**, and export.

Cut/Copy/Paste use the plugin’s internal clipboard. Paste destinations must be inside the selected photo collection. Copies get unique names. Rename retains the file extension and moves matching sidecars. Delete uses system Trash/Recycle Bin after confirmation; restore there and refresh. Metadata Undo does not restore deleted files.

## Keyboard controls

| Key | Action |
| --- | --- |
| ← / → | Previous / next photo in preview, or move the selected thumbnail |
| ↑ / ↓ | Move one thumbnail row; hold Shift with arrows to extend the selection |
| T | Open tag entry for the selection in preview or thumbnails |
| Enter in tag entry | Select/queue the typed tag; if the field is empty, save queued tags |
| 1–5 | Rate selected photos in preview or thumbnails |
| Escape | Close tag entry, cancel an active crop, or return from preview to thumbnails |
| Enter during crop | Apply the adjustable crop rectangle |
| Cmd/Ctrl+S | Save edited pixels to the previewed file, or edited files in the chosen folder in thumbnail view |
| Cmd/Ctrl+Z | Undo adjustments; when no draft remains, restore the last saved edit backup |
| Cmd/Ctrl+Shift+Z | Redo an unsaved preview adjustment |

Shortcuts do not assign ratings while you type in a text field. Set custom shortcuts under **Settings → Hotkeys**, searching for **Coherence Photo**. Commands include ratings, clearing a rating, navigation, tags, export, and automatic levels.

## When changes are saved

Choosing a tag suggestion queues it. **Apply tags**, or **Enter with an empty entry field**, writes the queued tags immediately. Drag-and-drop tags and ratings also write immediately when metadata writing is enabled. No export or additional save is needed. Failed writes are reported, and **Undo metadata** restores successful writes when the files have not changed externally.

Creating an unused tag name alone does not write metadata to photos. A batch may partly succeed; completed writes remain saved and can be undone. Cancellation stops between small groups of photos. Local backups and a journal protect metadata writes and enable recovery after interruption. Conflicting external changes are never silently overwritten.

## Basic editing and export

Adjust exposure, contrast, highlights, shadows, white balance, saturation, vibrance, levels, and straighten. **I’m Feeling Lucky** applies conservative automatic levels, including to multiple selected thumbnails. It is local processing, not a remote AI service.

**Adjust crop** displays a persistent crop rectangle with eight resize handles. Drag the center to move it, drag edges/corners to resize, or draw a new rectangle. Choose free, original, fixed, or custom ratios. Click **Apply crop** or press Enter when ready; Escape cancels. Focus a handle and use arrow keys for fine adjustment, with Shift for larger steps.

**Rotate** turns a photo 90° clockwise per click. It is available in the preview toolbar and photo context menu. Rotation, crop, and other edits initially save a recipe in the vault. **Cmd/Ctrl+S** writes the rendered result into the original **JPEG, PNG, or WebP**, keeping a recovery backup. Preview Save applies an active crop first. Thumbnail Save processes edited files throughout the selected folder, including unloaded photos, and follows the include-subfolders setting; other tag/rating filters do not narrow this folder save. Unedited files are skipped. Choose a folder before saving from an all-photos or tag-only view.

**Lucky** is in the preview toolbar. **Export copy**, **Undo**, and **Redo** are at the bottom of the left tag/folder pane. Image adjustments, color and tone, levels, and geometry can each be collapsed.

Saved edits are 8-bit sRGB; JPG is re-encoded at 95% quality and transparency is flattened to white when exporting JPG. The editor cannot write TIFF, RAW, animated formats, or other unsupported originals; export a supported copy instead. Active sidecars must be resolved before in-place saving. Backups remain under plugin local-data. Undo refuses to overwrite externally changed files. **Undo saved image edits** restores the latest saved batch (or current previewed file); it is distinct from metadata undo. Redo applies to unsaved preview adjustments.

Export selected photos, current filter matches, a tag and its subtags, or a folder and its subfolders. Resize proportionally to maximum dimensions or a percentage, or keep edited dimensions. The dialog hides irrelevant options. **Format** offers **Keep as is (original format)**, **PNG**, or **JPG**, with quality controls for JPG/WebP. Edited/resized original-format exports support JPEG, PNG, and WebP. With original dimensions and no edits, Keep as is makes a byte-for-byte copy, including formats that cannot be edited, and carries along existing unambiguous XMP sidecars. Rendered copies use **8-bit sRGB**, copy metadata when possible, normalize orientation, and remove stale face-region geometry. Existing files are not overwritten. Limits are 60 megapixels and 30,000 pixels per edge.

Full RAW development, HDR, and high-bit-depth editing are not included. Some formats use embedded JPEG previews; export from a RAW embedded preview is disabled. Batch automatic levels has its own recipe undo, separate from metadata undo.

## Data and privacy

- No analytics, telemetry, cloud uploads, or plugin network requests.
- Local filesystem access covers the photo folder, helper executables, and chosen export destinations, including locations outside the vault.
- Python and ExifTool run as local child processes with argument arrays, without shell interpolation.
- Settings and recipes use Obsidian’s plugin storage. Indexes, journals, and backups live under the plugin’s `local-data` folder. Embedded-write backups contain the original image files and can take substantial disk space.
- Keep the plugin data directory in your backups if you need edit recipes or metadata/image undo. Removing the plugin does not undo metadata already written to photos.
- Concurrent writing from multiple machines or Obsidian instances is not supported. Helper and collection paths may differ between computers.

## Beta status and upgrading

This is a desktop beta. Automated checks cover macOS, Windows, and Linux; graphical acceptance testing is primarily on macOS. More camera formats, color profiles, accessibility workflows, and cross-platform file dialogs still need testing. See [VALIDATION.md](VALIDATION.md).

Version 0.0.3 removes the former digiKam database connection. Existing folder-library indexes, photo IDs, saved recipes, and undo data are retained. If you previously connected an external database, choose the actual photo folder and scan embedded metadata; database-only tags must first be written to your files using the original application. Old database-specific recipes and undo history are retained locally but are not automatically remapped to a new folder index. Install standalone ExifTool if you were using another application's bundled copy.

## Development and support

```sh
npm ci
npm run build
npm test
npm run package
```

Release files are `main.js`, `manifest.json`, and `styles.css`. The Python helper is bundled in `main.js` and extracted locally at runtime. Python and ExifTool remain separate dependencies. Tests use generated images and disposable local indexes. ExifTool tests must run with ExifTool installed before a release.

Report bugs in [GitHub Issues](https://github.com/Coherence-Wizard/photo-workspace/issues), including OS, Obsidian/plugin version, and error text. Do not upload private photos or databases. Future timeline, faces, map, and richer export tools can use the same photo/query interface; see [ARCHITECTURE.md](ARCHITECTURE.md).

Coherence Photo is an independent community project, not an official Obsidian product. Released under the [MIT License](LICENSE).

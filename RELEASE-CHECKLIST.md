# Community release checklist

## First public release: 0.0.2

- [x] Build the reviewable JavaScript bundle and run 36 automated tests with ExifTool enabled.
- [x] Smoke-test the workspace, preview navigation, tag input, folder headings, and export controls in macOS Obsidian.
- [x] Document Python/ExifTool setup, optional digiKam, metadata destinations, filesystem access, and local subprocesses.
- [x] Publish the public source repository and tagged GitHub release with `main.js`, `manifest.json`, and `styles.css`.
- [x] Review current Obsidian developer policies and submission requirements.
- [x] Publish the official Obsidian Community listing. Automated review completed with no errors and reproduced `main.js` byte-for-byte; warnings and recommendations remain.

## Wider acceptance testing

- [ ] Live graphical smoke tests on Windows and Linux (automated tests are separate).
- [ ] Additional metadata readers and customized namespace priorities.
- [ ] More RAW pairs, sidecar conventions, read-only media, and disconnected-drive cases.
- [ ] Wide-gamut export, rotated EXIF images, transparency, and face regions.
- [ ] Interrupted writes across operating systems and multiple Obsidian instances.
- [ ] Keyboard and screen-reader coverage for every editing control.

Do not mark an operating system or camera format supported solely because a build or synthetic test passed. See VALIDATION.md for known limits and the GitHub Actions history for current automated results.

## 0.0.3 beta update

Keyboard submission, draft crop handles, clockwise rotation, folder-only sources, and a local-file-first introduction. Keep the published plugin ID stable while discussing a new display name. Check the corresponding GitHub Actions run and Community scorecard for release status.

## 0.0.4 name update

Rename the public display name to Coherence Photo. Retain the `photo-workspace` plugin ID, command IDs, view types, data paths, and repository URL for existing installations and update continuity.

# Community release checklist

The source and installable package are prepared for a beta. Public submission is a separate release milestone.

- [ ] Live smoke test on current Obsidian for macOS, Windows, and Linux.
- [ ] End-to-end import of sidecars into supported digiKam versions, including hierarchical keywords, ratings, pick labels, and color labels.
- [ ] Verify metadata namespace priorities against digiKam default and at least one customized metadata profile.
- [ ] Verify existing JPEG/RAW paired filenames, both sidecar conventions, read-only media, disconnected drives, Unicode paths, and Windows paths.
- [ ] Verify exports with wide-gamut profiles, rotated EXIF images, transparency, and face regions.
- [ ] Test interrupted write and undo on all operating systems, and multiple Obsidian instances sharing files.
- [ ] Test large collections with cold caches, long tag trees, and deep pagination.
- [ ] Confirm supported digiKam schema versions and document unsupported versions.
- [ ] Complete keyboard and screen-reader testing for selection, cropping alternatives, and tag assignment.
- [ ] Decide whether to retain external Python/ExifTool setup or ship a signed, versioned helper; document platform prerequisites.
- [ ] Publish a public source repository, support policy, and tagged GitHub release containing `main.js`, `manifest.json`, and `styles.css`.
- [ ] Recheck current Obsidian developer policies, licensing, naming, minAppVersion, and disclosure requirements.
- [ ] Submit a pull request to the official community plugin directory and resolve review feedback.

Do not mark an operating system or digiKam version supported solely because a build or synthetic test passed.

# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), versioning: [SemVer](https://semver.org/).

## [0.1.1] - 2026-10-23

### Added
- Any video format ffmpeg can read is accepted, including old `.vob` (DVD), `.mpg`, `.wmv`, `.3gp`, `.flv`.
- Anamorphic (non-square pixel) and interlaced sources are corrected on export.

## [0.1.0] - 2026-10-23

### Added
- Join up to 100 videos (MP4, MOV, M4V, AVI, MKV) into a single MP4.
- Automatic ordering by the number in the file name (`clip_1`, `clip_2`, `clip_10`); files without a number go last.
- Manual reordering: drag a row or use the ↑ / ↓ buttons; remove single files.
- Interface in Hebrew (right-to-left), Russian and English; light, dark and automatic theme; large-text mode.
- Progress bar with cancel, and "Show in folder" after export.
- "About" dialog describing every feature and nuance.
- 100% local: files are read from their original location, nothing is copied or uploaded.
- Bundled ffmpeg - nothing else to install.
- macOS (Apple Silicon) `.dmg` and Windows x64 installer.

# Social poster fonts

These unmodified fonts are bundled for the daily agenda image renderer. The
files and their SIL Open Font License notices were downloaded from the official
Google Fonts repository at the commit recorded in `manifest.json`. That manifest
pins each source URL and SHA-256 checksum.

- Barlow Condensed Bold: event identities.
- Barlow Condensed ExtraBold: the weekday.
- Instrument Sans (regular, medium and semibold variable instances): dates,
  venues and verified details.
- IBM Plex Mono (regular and medium): the time rail and page information.
- Noto Sans (condensed variable instances): Cyrillic and other event identity
  characters missing from the primary fonts.

`lib/social/agenda-images.ts` uses fontkit to measure the actual glyphs and
convert them to SVG outlines before Sharp generates the JPEG. Production has
no font download, browser, system font installation or fontconfig requirement.
Keep this directory in the runtime's `public` directory (the existing Docker
image already copies `public`). Do not replace a binary without updating its
source, checksum and corresponding license notice.

Additional script coverage is recorded separately in `fallback-manifest.json`,
including the installed system-package versions, file sizes and SHA-256 hashes.
`IPAGothic.ttf` is the first extended fallback for Japanese/CJK identities;
`Unifont.ttf` is the final fallback for mixed scripts, including Japanese with
Serbian Cyrillic. Their unchanged licenses are included as
`IPAGothic-LICENSE.txt` and `Unifont-LICENSE.txt`. Both are loaded lazily after
the preferred design face and the existing Noto Sans fallback fail glyph
coverage; no title is transliterated, truncated or skipped.

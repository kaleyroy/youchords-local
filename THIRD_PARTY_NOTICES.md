# Third-Party Notices

## @tombatossals/chords-db

The ukulele position dataset includes source positions from
[`@tombatossals/chords-db`](https://github.com/tombatossals/chords-db), version
0.5.1, plus generated YouChords voicings.

- Copyright (c) 2016 David Rubert
- License: MIT
- A copy of the license is included at
  `third_party/chords-db-LICENSE.txt`.

## NNLS Chroma and Chordino

The local companion builds NNLS Chroma 1.1 and Chordino from source under
`apps/local-companion/third_party/nnls-chroma`.

- Authors: Matthias Mauch, Chris Cannam, and contributors
- Upstream release: <https://isophonics.net/nnls-chroma>
- Source mirror used for reproducible builds:
  <https://github.com/napulen/justkeydding/tree/ebc70815fb9bc898460a02efdafcc00bc51ac0b6/nnls-chroma-1.1>
- Upstream archive identity: Mercurial node
  `ba9310bcc3fcb3c58c99d25837b6f62662666b7d`, tag `v1.1`
- License: GPL-2.0-or-later
- The upstream `COPYING`, `README`, and `CITATION` files are retained beside
  the source.

## Sonic Annotator

Docker downloads Sonic Annotator 1.7 from its official GitHub release and
verifies SHA-256 before extracting it locally.

- Project: <https://github.com/sonic-visualiser/sonic-annotator>
- License: GPL-2.0-or-later
- The binary is not committed to this repository.

## Runtime tools

The local Docker image installs these tools from their official package
sources during the user's build:

- [FFmpeg](https://ffmpeg.org/) - LGPL/GPL components according to the Debian
  package build configuration
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - The Unlicense
- [Vamp Plugin SDK](https://www.vamp-plugins.org/) - BSD-style license

Python dependency versions are pinned in
`apps/local-companion/requirements.txt`. Their respective upstream licenses
continue to apply.

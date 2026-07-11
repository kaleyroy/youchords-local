# YouChords Local Open-Source Roadmap

## Goal

Release YouChords as a self-hosted, local-first project that does not depend on
the former YouChords cloud infrastructure.

The user's computer will:

1. Download or accept an audio source.
2. Convert the audio with FFmpeg.
3. Run chord recognition locally.
4. Return the existing packed chord JSON format to the browser extension.
5. Cache results locally and delete temporary audio after processing.

## Do Not Publish the Current Repository

The current private repository is not a release candidate. Its worktree and Git
history contain infrastructure credentials, private keys, account recovery data,
proxy configuration, production logs, billing code, and internal research data.

Before any public release:

1. Revoke or rotate every credential that has ever been committed.
2. Keep this repository private as the historical archive.
3. Create a new empty public repository with no shared Git history.
4. Copy only explicitly approved source files into the new repository.
5. Run secret, dependency, and license scans before the first push.

## Proposed Architecture

```text
Browser extension
  |
  | authenticated HTTP on 127.0.0.1
  v
YouChords Local Companion
  |- job queue and progress API
  |- yt-dlp downloader
  |- FFmpeg audio conversion
  |- Chordino / NNLS Chroma chord engines
  |- tuning detection
  |- local subtitle extraction
  |- optional local speech-to-text engine
  `- local cache and temporary-file cleanup
```

### Local API

Bind only to `127.0.0.1`, never to all network interfaces.

Suggested endpoints:

- `GET /v1/health`
- `POST /v1/jobs`
- `GET /v1/jobs/{job_id}`
- `DELETE /v1/jobs/{job_id}`
- `GET /v1/results/{video_id}`

Use a random pairing token generated during setup. Store it locally in the
extension and companion. Validate video IDs, URLs, paths, body sizes, and job
limits. Process one analysis job at a time by default.

## Version 0.1: Fastest Safe Release

Use Docker Compose for the local companion. This lets the existing Linux-only
Sonic Annotator and NNLS Chroma binaries run on Windows, macOS, and Linux while
all processing remains on the user's computer.

The container should include only:

- Python 3.10 runtime
- FFmpeg
- yt-dlp
- Sonic Annotator
- NNLS Chroma / Chordino
- the minimum YouChords extraction and output-format code
- a small FastAPI service

It must not include Modal, GCP, R2, Supabase, Paddle, SES, Cloudflare, Thumbmark,
proxy rotation, production credentials, or production account data.

## Extension Changes

Create a `LocalProcessingClient` behind the same interface currently used for
`processVideo` and `getChords`.

Remove from the public edition:

- Google sign-in and account creation
- subscriptions, checkout, quotas, and billing settings
- device fingerprinting and abuse tracking
- cloud job queues and presigned downloads
- hosted analytics and support administration

Keep:

- carousel and preview UI
- R, R+, H, and H+ selection
- capo, transpose, tuning, diagrams, and instruments
- IndexedDB song cache and user edits
- playback, speed, pitch, and subtitle display controls

## Chord Pipeline

The local pipeline produces the extension's packed version 2 schema:

- Madmom DeepChroma output for Regular mode
- Chordino simple-chord output
- Chordino chord-note output
- Harmonic+ parameter pass
- tuning value and non-standard-tuning flag
- `regular`, `regularPlus`, `harmonic`, and `harmonicPlus` timelines

The Docker build downloads Madmom 0.16.1 from PyPI and verifies its SHA-256.
Madmom source is BSD licensed, while its pretrained model/data files are
CC BY-NC-SA 4.0 and therefore limited to non-commercial use. The repository does
not commit or distribute those model files or a prebuilt Madmom image.

## Subtitles

Phase 1:

- use subtitles made available by the source when permitted
- keep existing locally cached subtitles

Phase 2:

- add optional local speech-to-text, preferably a separately downloaded
  whisper.cpp model
- do not require Gemini, ElevenLabs, or a YouChords API key

## Local Storage

- Extension preferences and rendered chord data: IndexedDB / chrome.storage
- Companion cache: a user-owned data directory
- Job state: SQLite or compact JSON files
- Temporary media: an isolated temp directory with cleanup on success, failure,
  cancellation, and startup recovery
- Telemetry: disabled by default; no hosted endpoint in version 0.1

## Repository Layout

```text
youchords-local/
  apps/
    extension/
    local-companion/
  engine/
    chord-pipeline/
  packages/
    chord-format/
  docker/
  docs/
  tests/
  LICENSE
  THIRD_PARTY_NOTICES.md
  SECURITY.md
  CONTRIBUTING.md
  CODE_OF_CONDUCT.md
```

## Licensing Gate

The included Sonic Annotator and NNLS Chroma copies carry GPL version 2 terms.
Use an OSI-approved license compatible with every distributed component. The
current recommendation is `GPL-2.0-or-later`, subject to a final file-by-file
license audit.

Maintain `THIRD_PARTY_NOTICES.md` for at least:

- Sonic Annotator
- NNLS Chroma / Chordino
- Vamp SDK/runtime
- FFmpeg and its enabled codecs
- yt-dlp and bundled third-party components
- chord-position datasets
- any optional speech-to-text runtime and model

## YouTube and User Content

Support local audio files as a first-class input. For URL processing, state that
users are responsible for having permission to access and process the content.
Do not publish proxy credentials, IP-rotation automation, account cookies, or
code whose purpose is to bypass access restrictions.

## Release Gates

The first public tag is blocked until all of these pass:

- clean repository with new history
- all historical credentials revoked or rotated
- secret scan passes on worktree and Git history
- license inventory completed
- Docker image builds from source
- processing works with networking to YouChords domains blocked
- local-file and permitted URL jobs return the existing chord schema
- cancellation and temp-file cleanup are tested
- extension works without sign-in or billing
- Windows, macOS, and Linux setup instructions are verified
- no user data, production logs, or copyrighted test media is included

## Delivery Order

1. Sanitize and create the new public repository.
2. Extract the minimum local chord engine from `chord-extractor-clean`.
3. Add a direct local yt-dlp provider with no proxy or cloud storage.
4. Build the local job API and Docker Compose setup.
5. Add the extension's local processing adapter.
6. Remove hosted account and billing dependencies from the public edition.
7. Test end to end with local files, then permitted YouTube URLs.
8. Add local subtitles and optional speech-to-text.
9. Publish an alpha release and link it from the shutdown page.

# YouChords Local

YouChords is becoming a free, open-source, local-first chord recognition tool
for YouTube videos and local audio files.

> **Project status: pre-alpha.** The source is public, but the local processing
> companion is not ready yet. The legacy extension snapshot in this repository
> is provided for migration and UI development; it is not a working standalone
> release and does not connect to the former YouChords cloud service.

## The goal

The finished community edition will run chord analysis on the user's computer:

1. accept a local audio file or a permitted media URL;
2. prepare audio locally with FFmpeg and yt-dlp where appropriate;
3. run Chordino / NNLS Chroma locally;
4. return YouChords chord timelines to the browser extension;
5. cache results locally and remove temporary media safely.

No account, subscription, device fingerprinting, billing service, or hosted
YouChords backend will be required.

## What is in this repository

- `apps/extension-legacy/` - sanitized source snapshot of the former Chrome
  extension, retained as the UI and behavior reference for the local edition.
- `docs/LOCAL_FIRST_ROADMAP.md` - architecture, security, licensing, and release
  gates for the local companion.
- `docs/LEGACY_EXTENSION.md` - why the snapshot is not currently installable.
- `THIRD_PARTY_NOTICES.md` - attribution and licensing notes.

The private production backend, billing code, credentials, user data, logs,
deployment tooling, proxy infrastructure, and historical Git repository are
intentionally not included.

## Planned layout

```text
apps/
  extension/
  local-companion/
engine/
  chord-pipeline/
packages/
  chord-format/
docker/
docs/
```

## Can I install it now?

Not yet. The current snapshot still contains legacy account and cloud-facing
flows with their production identifiers replaced by local placeholders. A
working alpha will be published only after the local companion and extension
adapter pass the release gates in the roadmap.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the
[local-first roadmap](docs/LOCAL_FIRST_ROADMAP.md). Please do not submit API
keys, cookies, copyrighted media, production credentials, or bypass tooling.

## Responsible use

Users are responsible for having permission to access and process media. Local
files are a first-class input. URL support must respect applicable terms,
copyright, access controls, and local law.

## License

YouChords source in this repository is licensed under
**GPL-2.0-or-later**. See [LICENSE](LICENSE). Third-party components and datasets
retain their own licenses as described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).


# Install on Windows

## Prerequisite

Install and start [Docker Desktop](https://www.docker.com/products/docker-desktop/).

The Docker build downloads Madmom's pretrained model/data files under
CC BY-NC-SA 4.0. Those files are restricted to non-commercial use; see
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## One setup command

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/yuval-kahan/youchords-local/main/install.ps1 | iex
```

The setup command downloads the current source, generates a private local
pairing token, builds the Docker companion, starts it on `127.0.0.1:8765`, and
opens Chrome's extensions page.

Chrome does not permit scripts to silently install an unpacked extension. The
installer copies the extension directory to the clipboard. Enable **Developer
mode**, choose **Load unpacked**, and select that directory.

## Data and privacy

- Chord processing runs inside Docker on this computer.
- Results remain in a local Docker volume.
- Temporary audio is removed after each successful or failed job.
- The companion listens only on the loopback interface.
- A random bearer token pairs the extension with the local companion.

## Stop or restart

```powershell
$root = "$env:LOCALAPPDATA\YouChordsLocal"
$token = Get-Content "$env:LOCALAPPDATA\YouChordsLocalData\pairing-token.txt" -Raw
$env:YOUCHORDS_PAIRING_TOKEN = $token.Trim()
docker compose --project-directory $root -f "$root\compose.yaml" stop
docker compose --project-directory $root -f "$root\compose.yaml" start
```

## Current limitations

- The initial Docker build is large because it compiles the GPL chord engine.
- URL processing depends on yt-dlp and can be affected by source-site changes.
- Local speech-to-text is not included yet; available YouTube captions and the
  extension's existing display tools remain separate from chord processing.

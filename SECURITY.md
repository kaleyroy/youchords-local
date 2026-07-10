# Security Policy

## Supported versions

There is no supported release yet. The repository is currently pre-alpha.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting / Security Advisories for
this repository. Do not open a public issue containing credentials, tokens,
personal data, or a working exploit.

## Local companion requirements

- Bind HTTP services only to `127.0.0.1`.
- Require a random local pairing token.
- Validate URLs, video IDs, paths, body sizes, and job concurrency.
- Use isolated temporary directories and clean them after success, failure,
  cancellation, and startup recovery.
- Never execute user-provided shell fragments.
- Never collect telemetry by default.


# Legacy Extension Snapshot

`apps/extension-legacy` is a sanitized copy of the former hosted extension. It
is included so contributors can preserve the existing carousel, chord cards,
capo, transpose, diagrams, instruments, captions, tuning, and editing UX while
replacing the cloud transport.

It is intentionally not a working standalone extension yet:

- production OAuth and Firebase identifiers were replaced with placeholders;
- the API base URL points to the planned local companion at
  `http://127.0.0.1:8765`;
- the former backend, subscriptions, quotas, account flows, and device
  fingerprinting are not published;
- generated Firebase bundles and media samples were excluded;
- local processing endpoints have not yet been implemented.

Do not publish this directory to an extension store. The installable alpha will
live under `apps/extension` once the local adapter is complete.


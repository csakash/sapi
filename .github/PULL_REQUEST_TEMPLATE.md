## What and why

<!-- What does this change do, and why? Link the issue. -->

## How it was tested

<!-- Commands you ran, tests you added. Security controls need a test that proves them. -->

## ARI-42

- [ ] This change touches no ARI-42 requirement, **or** I updated the affected rows in `ARI42.md`
      with their evidence.
- [ ] No secret, key or token is logged, sent to the browser, put in a prompt or passed to a child
      process.
- [ ] Client-supplied text can't become a command-line flag, a file path or a host.
- [ ] No permission-bypass flags (`--dangerously-skip-permissions`, `bypassPermissions`, `--yolo`).

## AI changes

- [ ] This adds a provider or model, or widens what sapi can reach (hosts, files, tools). If so, I
      added an entry under **AI changes** in `CHANGELOG.md`.

## AI assistance

<!-- Did you use an AI coding assistant? Which one? You must understand every line you submit. -->

## Checklist

- [ ] `bun run ci` passes
- [ ] Commits are signed off (`git commit -s`)

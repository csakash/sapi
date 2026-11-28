# Contributing to sapi

Thanks for helping. sapi handles people's subscription access, so security comes first in every
change.

## Development setup

Use the dev container in `.devcontainer/` (recommended), or install [Bun](https://bun.sh) at the
version in `.bun-version`.

```bash
bun install --frozen-lockfile   # lockfile changes must be deliberate
bun run check                   # lint, typecheck, tests
bun run ari42                   # ARI-42 gate in report mode
bun run ci                      # all of the above and more: run it before you push
```

Never put real provider logins, API keys or customer data in the dev container or the repo.

## Pull requests

- One topic per pull request, with tests. Security controls need a test that proves them.
- Fill in the pull request template, including the ARI-42 section.
- If your change touches an ARI-42 requirement, update its row in `ARI42.md` in the same pull
  request.
- A new provider, model mapping or a change that widens what sapi can reach (hosts, files, tools)
  needs an entry under **AI changes** in `CHANGELOG.md`.
- New dependencies: explain why in the pull request. We prefer none. A dependency must be an
  established package (not published in the last few days), and the lockfile must be updated with
  `bun install`.

## Developer Certificate of Origin

Every commit must be signed off, which certifies the
[Developer Certificate of Origin](https://developercertificate.org/): you wrote the change or have
the right to submit it under the project's license.

```bash
git commit -s -m "Add the thing"
```

`bun run ci` checks for the `Signed-off-by:` line. sapi has no hosted CI, so reviewers run it too.

## AI-assisted contributions

You may use AI coding assistants. The rules:

- **You are the author.** You must understand and be able to explain every line you submit.
- **Say so** in the pull request description, and name the tool.
- **Run agents in the dev container or another sandbox**, never with production credentials, and
  never with permission-bypass modes (`--dangerously-skip-permissions`, `--yolo`, `bypassPermissions`
  or similar).
- **Agents never merge.** Every change gets a human review.
- **Check agent-suggested dependencies exist** and are the package you intended before adding them.

The repository carries an `AGENTS.md` and the ARI-42 skill, so coding agents pick up the project's
security rules automatically.

## Reporting bugs and requesting features

Use the issue templates. For security problems, follow [SECURITY.md](SECURITY.md) instead.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

# Governance

## Maintainers

| Name | GitHub | Role |
|---|---|---|
| _to be filled in before the repository goes public_ | | Lead maintainer, security contact |

A second maintainer is a goal before 1.0, so security fixes never depend on one person.

## Decisions

- The lead maintainer decides, after discussion in the issue or pull request.
- Anything that changes the security model (what sapi can reach, who can call it, how credentials
  are handled, the provider ground rules) needs a written rationale in the pull request and an update
  to `ARI42.md`.
- Some things the project will not do, whatever the vote: multi-user or team mode, pooling or
  rotating several accounts, a hosted version, or anything that reads or forwards Claude login
  tokens.

## Becoming a maintainer

Sustained, high-quality contributions and reviews, with an understanding of the security model. The
current maintainers invite new ones.

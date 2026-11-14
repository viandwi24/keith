# 0001. Branch model, versioning, license and visibility

Status: Accepted (2026-10-26)

## Context

Keith is built solo during the MVP, has no users yet and publishes no packages. The GitHub repo
`viandwi24/keith` still holds an older prototype that the owner will delete later.

## Decision

- Branch model A: `main` only, direct commits allowed, versions stay 0.x.
- Changesets with `privatePackages: { version: true, tag: false }`: changelogs, no publishing.
- License MIT; the repo will be public at `viandwi24/keith`. Superseded on Nov 14, 2026: see "Amendment: license" below.
- Until the old repo is cleaned up, work stays local: commit on `main`, no remote, no push. The
  agent hook blocks `git push` and `git remote add` during this phase. Superseded on Nov 14, 2026: see "Amendment: public repository" below.

## Consequences

- No PR review gate yet; `bun run check`, the git hooks and `act` are the gates.
- "CI green on GitHub" is proven on the first push. Moving to model B (trunk + PR) and adding
  `release.yml` happens when the MVP is in real use.

## Amendment: license (Nov 14, 2026)

The owner changed the license from MIT to **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International**
(`CC-BY-NC-SA-4.0`, `LICENSE`). The requirements were: the source stays open, nobody may use it commercially, and a fork must stay
open, free and non-commercial too. CC BY-NC-SA is the one standard license that holds all three: NonCommercial forbids commercial use,
ShareAlike makes every adaptation carry the same license.

Consequences:

- Keith is **source-available**, not "open source" in the OSI sense (the OSI definition does not allow a non-commercial clause). The
  README says "source-available" and names the license.
- Creative Commons licenses are written for content, not software: they have no patent clause and do not require distributing source
  with a build. Keith ships as source (Bun runs the TypeScript), so a fork is shared as source in practice. Revisit if Keith ever ships
  binaries.
- Dependencies keep their own licenses. eharness is MIT, and every installed npm package is under a permissive license (MIT, Apache-2.0, ISC, BSD, Python-2.0, CC0; checked Nov 14, 2026), which allows this.
- The owner is the only author of the repository (one initial commit, Nov 14, 2026), so no contributor had to agree to the change.

## Amendment: public repository (Nov 14, 2026)

The repository is public at `github.com/viandwi24/keith`. Branch model A stays until there are outside contributors: `main` only,
the owner pushes and reviews outside pull requests, and agents never push. The agent guard keeps blocking `git push` and
`git remote add` for agents.

When outside contributors arrive, move to model B: contributors open pull requests with green CI, and branch protection on `main`
requires them, enforced on the server. Until then, `bun run check` is the gate.

Added with the public repository: `CONTRIBUTING.md` (the contributor path and the gate), `CODE_OF_CONDUCT.md`,
`.github/dependabot.yml` (weekly updates for GitHub Actions and the Bun workspace) and a release workflow that opens the
"Version Packages" pull request from changesets (no publishing, since the packages are private). Keith has no releases yet, so the
workflow is parked, not active: it lives in `.github/disabled-workflows/release.yml`, where GitHub does not run it. Move it back to
`.github/workflows/` for the first release.


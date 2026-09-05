# Warped Pinball Software Website

This repo powers `software.warpedpinball.com`, the update endpoints that Vector
boards check when they look for new firmware. The site is a set of static JSON
files under `docs/`, generated from the GitHub Releases in
[`warped-pinball/vector`](https://github.com/warped-pinball/vector) and served by
GitHub Pages.

Nothing here is edited by hand. A release becomes visible to boards only after
the generated JSON in this repo is regenerated and merged to `main`.

## Deploying a new Vector version

### 1. Cut the release in `vector`

In the `warped-pinball/vector` repo, publish a new GitHub Release:

1. **Create the tag.** The tag must match `VectorVersion` in
   [`src/common/SharedState.py`](https://github.com/warped-pinball/vector/blob/main/src/common/SharedState.py)
   exactly (for example, tag `1.12.4` for `VectorVersion = "1.12.4"`).

   This matters because the build workflow reads the version from
   `SharedState.py`, not from the tag. On a `release: published` event it builds
   with no suffix, so a mismatch produces a release tagged one version while
   the firmware inside reports another.

2. **Generate release notes** with GitHub's "Generate release notes" button,
   then edit them to taste. These notes are pulled into this site verbatim and
   shown to users in the update UI, so write them for board owners, not for
   developers.

3. **Publish as the latest release.** Leave "Set as the latest release"
   checked and do not mark it as a pre-release.

Publishing the release kicks off the **Build and Deploy** workflow in `vector`,
which builds each product, signs the updates, and attaches the `update*.json`
assets to the release. Wait for it to finish before moving on.

### Checkpoint: available, but not yet published

At this point the release exists and its assets are downloadable, but this site
has not been regenerated. Boards will **not** find the update automatically.

That gap is deliberate. Use it to try the build out first: download the
`update*.json` asset for your product from the release page and load it through
the board's manual update (dev build) flow. If something is wrong, you can fix
it before any board in the field sees the version.

Move on once you are happy with the build.

### 2. Create a branch in this repo

Branch off `main`, named exactly after the release tag:

```bash
git fetch origin main
git checkout -b 1.12.4 origin/main
git push -u origin 1.12.4
```

### 3. Run the Sync Releases workflow against that branch

In this repo, go to **Actions → Sync Releases → Run workflow**, and set the
`branch` input to your new branch.

The workflow runs `scripts/generate.py` against `warped-pinball/vector`, rewrites
everything under `docs/vector/` plus `docs/builds.json` and
`docs/download_counts.json`, and commits the result straight to your branch.

### 4. Open a PR

Open a pull request from your release branch into `main`. The repo's PR template
carries a release checklist; fill it in.

### 5. Review the diff, then merge

Check that the generated JSON is what you expect before merging:

- `docs/vector/<product>/latest.json` names the new version for every product
  the release covers.
- `docs/vector/<product>/prod.json` gained the new entry (not `beta.json` or
  `dev.json`, which would mean the version string picked up a suffix).
- The release notes rendered into the `notes` field read the way you intended.
- Nothing unrelated disappeared. The generator wipes and rebuilds `docs/vector/`
  from scratch, so a deleted or unpublished release in `vector` shows up here as
  a removal.

Merge once the checks pass and the diff looks right.

### 6. Wait for Pages to publish

Merging to `main` triggers the GitHub Pages build. Give it a few moments, then
confirm the new version is live:

```bash
curl https://software.warpedpinball.com/vector/sys11/latest.json
```

Boards will pick it up on their next update check.

## How releases are classified

`scripts/generate.py` sorts every release asset into one of three buckets based
on the version string, and boards only auto-update to production builds:

| Version string ends in | Bucket | Published to |
| --- | --- | --- |
| `-dev<N>` | dev | `dev.json` |
| `-beta<N>` or `-beta-<N>` | beta | `beta.json` |
| anything else | production | `prod.json`, and `latest.json` |

The suffixes come from the `vector` build workflow: pull requests build `-dev<PR>`,
pushes to `main` build `-beta<run>`, and a published release builds with no suffix
at all. So a clean tag is what makes a release production.

## Published endpoints

Products are `sys11`, `wpc`, `em`, `data_east`, and `whitestar`. Each gets a
directory under `docs/vector/`:

```
https://software.warpedpinball.com/vector/<product>/latest.json   most recent production release
https://software.warpedpinball.com/vector/<product>/prod.json     all production releases
https://software.warpedpinball.com/vector/<product>/beta.json     all beta releases
https://software.warpedpinball.com/vector/<product>/dev.json      all dev releases
https://software.warpedpinball.com/vector/<product>/all.json      everything, combined
```

Two repo-wide files sit alongside them:

```
https://software.warpedpinball.com/builds.json           every update file, with its sha256
https://software.warpedpinball.com/download_counts.json  download counts per asset
```

## Troubleshooting

**The new version landed in `beta.json` instead of `prod.json`.**
The version string carried a `-beta<N>` suffix, which means the assets were built
by a push to `main` rather than by the published release. Confirm the release
build actually ran and attached fresh assets, then re-run the sync.

**`latest.json` did not change.**
The generator skips a production build whose update file is byte-identical to the
previous production build for that product. If a product genuinely did not change,
this is expected.

**A product is missing from the release entirely.**
`scripts/generate.py` only picks up assets it recognizes: `update.json` (sys11),
`update_wpc.json`, `update_em.json`, `update_data_east.json`, and
`update_whitestar.json`. If one is absent from the release, the `vector` build
did not produce it.

**The sync workflow committed nothing.**
That means the regenerated JSON matched what was already on the branch. Check
that you pointed the workflow at the right branch, and that the `vector` release
is published rather than still a draft.

## Running the generator locally

You should not normally need this, but it is useful for debugging a bad sync:

```bash
python3 -m pip install -r requirements.txt
GITHUB_TOKEN=<token> python3 scripts/generate.py \
  --owner warped-pinball --repo vector --out-dir docs
```

The script rewrites `docs/` in place, so run it on a scratch branch.

## Tests

```bash
python3 -m pip install -r requirements.txt pytest
pytest -v
```

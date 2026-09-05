# Warped Pinball Software Website

This repo powers `software.warpedpinball.com`, the update endpoints that Vector
boards check when they look for new firmware. The site is a set of static JSON
files under `docs/`, generated from the GitHub Releases in
[`warped-pinball/vector`](https://github.com/warped-pinball/vector) and served by
GitHub Pages.

Nothing here is edited by hand. A release becomes visible to boards only after
the generated JSON in this repo is regenerated and merged to `main`.

## Deploying a new Vector version

Quick links, in the order you will need them:

| Step | Link |
| --- | --- |
| Draft the release | [vector → Releases → Draft a new release](https://github.com/warped-pinball/vector/releases/new) |
| Watch the firmware build | [vector → Actions → Build and Deploy](https://github.com/warped-pinball/vector/actions/workflows/build_release.yml) |
| Grab the built assets | [vector → Releases](https://github.com/warped-pinball/vector/releases) |
| Create the branch here | [this repo → Branches](https://github.com/warped-pinball/software.warpedpinball.com/branches) |
| Run the sync | [this repo → Actions → Sync Releases](https://github.com/warped-pinball/software.warpedpinball.com/actions/workflows/sync-releases.yml) |
| Open the PR | [this repo → Pull requests](https://github.com/warped-pinball/software.warpedpinball.com/compare) |
| Confirm it published | [this repo → Deployments](https://github.com/warped-pinball/software.warpedpinball.com/deployments) |

### 1. Cut the release in `vector`

Go to **[github.com/warped-pinball/vector/releases/new](https://github.com/warped-pinball/vector/releases/new)**.
(The long way round: open the [`vector` repo](https://github.com/warped-pinball/vector),
click **Releases** in the right-hand sidebar of the main page, then the green
**Draft a new release** button at the top right.)

On that page:

1. **Create the tag.** Click the **Choose a tag** dropdown at the top left, type
   the new version number, and pick **+ Create new tag: `x.y.z` on publish** from
   the dropdown. Leave the **Target** dropdown next to it set to `main`.

   The tag must match `VectorVersion` in
   [`src/common/SharedState.py`](https://github.com/warped-pinball/vector/blob/main/src/common/SharedState.py)
   exactly. For example, tag `1.12.4` when that file reads
   `VectorVersion = "1.12.4"`.

   This matters because the build workflow reads the version out of
   `SharedState.py`, not out of the tag. On a published release it builds with
   no suffix, so a mismatch ships a release tagged one version whose firmware
   reports another. If the number in `SharedState.py` is not the one you want to
   release, bump it in a normal PR to `main` first, then come back here.

2. **Generate release notes.** Click the **Generate release notes** button at
   the top right of the description box, then edit what it produces to taste.
   These notes get pulled into this site and shown to board owners inside the
   update UI, so write them for owners rather than for developers.

3. **Publish as the latest release.** Below the description box, leave
   **Set as the latest release** checked, and leave **Set as a pre-release**
   unchecked. Then click the green **Publish release** button at the bottom.

Publishing kicks off the **Build and Deploy** workflow, which builds each
product, signs the updates, and attaches the `update*.json` assets to the
release. Watch it at
**[vector → Actions → Build and Deploy](https://github.com/warped-pinball/vector/actions/workflows/build_release.yml)**
and wait for a green check before moving on. It will not be instant.

### Checkpoint: available, but not yet published

At this point the release exists and its assets are downloadable, but this site
has not been regenerated. Boards will **not** find the update automatically.

That gap is deliberate. Use it to try the build out first:

1. Open the release on
   **[vector → Releases](https://github.com/warped-pinball/vector/releases)**.
2. Expand the **Assets** section at the bottom of the release entry and download
   the `update*.json` file for your product (see
   [Published endpoints](#published-endpoints) for which file is which).
3. Load that file onto a board through its manual update flow, the same one used
   for dev builds.

If something is wrong, you can fix it before any board in the field sees the
version. Move on once you are happy with the build.

### 2. Create a branch in this repo

Branch off `main`, named exactly after the release tag.

From the command line:

```bash
git fetch origin main
git checkout -b 1.12.4 origin/main
git push -u origin 1.12.4
```

Or in the browser: go to
**[this repo → Branches](https://github.com/warped-pinball/software.warpedpinball.com/branches)**
and click the grey **New branch** button at the top right. Name it after the
release tag and leave the source set to `main`.

### 3. Run the Sync Releases workflow against that branch

Go to
**[Actions → Sync Releases](https://github.com/warped-pinball/software.warpedpinball.com/actions/workflows/sync-releases.yml)**.
(The long way round: the **Actions** tab at the top of this repo, then
**Sync Releases** in the left-hand workflow list.)

A blue banner reading "This workflow has a workflow_dispatch event trigger"
sits above the run list. Click the **Run workflow** dropdown button at its right
end, set **Branch to run the sync on** to your new branch, and click the green
**Run workflow** button in the dropdown.

The workflow runs `scripts/generate.py` against `warped-pinball/vector`, rewrites
everything under `docs/vector/` plus `docs/builds.json` and
`docs/download_counts.json`, and commits the result straight to your branch.
Refresh the page to see the run appear, and wait for it to go green.

### 4. Open a PR

GitHub usually shows a yellow "your-branch had recent pushes" banner with a
**Compare & pull request** button on the repo's
[main page](https://github.com/warped-pinball/software.warpedpinball.com) and
[Pull requests tab](https://github.com/warped-pinball/software.warpedpinball.com/pulls).
If it is not there, go to
**[New pull request](https://github.com/warped-pinball/software.warpedpinball.com/compare)**
and set **base: `main`** on the left and **compare: your branch** on the right.

The description box is pre-filled from the repo's PR template, which carries a
release checklist. Fill it in, then click **Create pull request**.

### 5. Review the diff, then merge

Open the **Files changed** tab of the PR and check that the generated JSON is
what you expect:

- `docs/vector/<product>/latest.json` names the new version for every product
  the release covers.
- `docs/vector/<product>/prod.json` gained the new entry, and not `beta.json` or
  `dev.json`, which would mean the version string picked up a suffix.
- The release notes rendered into the `notes` field read the way you intended.
- Nothing unrelated disappeared. The generator wipes and rebuilds `docs/vector/`
  from scratch, so a deleted or unpublished release in `vector` shows up here as
  a removal.

Once the checks at the bottom of the **Conversation** tab are green and the diff
looks right, click **Merge pull request**, then **Confirm merge**.

### 6. Wait for Pages to publish

Merging to `main` triggers the GitHub Pages build. Watch it at
**[this repo → Deployments](https://github.com/warped-pinball/software.warpedpinball.com/deployments)**
(also linked as **Deployments** in the right-hand sidebar of the repo's main
page). Give it a few moments, then confirm the new version is live:

- In a browser: <https://software.warpedpinball.com/vector/sys11/latest.json>
- Or from a terminal:

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

There are five products. Each has its own release asset in `vector` and its own
directory of JSON on this site:

| Product | Release asset in `vector` | Endpoint directory |
| --- | --- | --- |
| System 11 | `update.json` | `/vector/sys11/` |
| WPC | `update_wpc.json` | `/vector/wpc/` |
| EM | `update_em.json` | `/vector/em/` |
| Data East | `update_data_east.json` | `/vector/data_east/` |
| Whitestar | `update_whitestar.json` | `/vector/whitestar/` |

Each directory publishes the same five files:

```
https://software.warpedpinball.com/vector/<product>/latest.json   most recent production release
https://software.warpedpinball.com/vector/<product>/prod.json     all production releases
https://software.warpedpinball.com/vector/<product>/beta.json     all beta releases
https://software.warpedpinball.com/vector/<product>/dev.json      all dev releases
https://software.warpedpinball.com/vector/<product>/all.json      everything, combined
```

Two site-wide files sit alongside them:

```
https://software.warpedpinball.com/builds.json           every update file, with its sha256
https://software.warpedpinball.com/download_counts.json  download counts per asset
```

## Troubleshooting

**The new version landed in `beta.json` instead of `prod.json`.**
The version string carried a `-beta<N>` suffix, which means the assets were built
by a push to `main` rather than by the published release. Check the
[Build and Deploy runs](https://github.com/warped-pinball/vector/actions/workflows/build_release.yml)
to confirm a run was triggered by the release itself and attached fresh assets,
then re-run the sync.

**`latest.json` did not change.**
The generator skips a production build whose update file is byte-identical to the
previous production build for that product. If a product genuinely did not change,
this is expected.

**A product is missing from the release entirely.**
`scripts/generate.py` only picks up the five asset names in the table above. If
one is absent from the release's **Assets** list, the `vector` build did not
produce it. Check the run log under
[Build and Deploy](https://github.com/warped-pinball/vector/actions/workflows/build_release.yml).

**The sync workflow committed nothing.**
That means the regenerated JSON matched what was already on the branch. Check
that you pointed the workflow at the right branch, and that the `vector` release
is actually published rather than still a draft. Drafts do not appear on
[the releases page](https://github.com/warped-pinball/vector/releases) to the
generator.

**The site still serves the old version after merging.**
Check the Pages build under
[Deployments](https://github.com/warped-pinball/software.warpedpinball.com/deployments).
If it is green, you may be seeing a cached response; retry with a cache-busting
query string, for example
`https://software.warpedpinball.com/vector/sys11/latest.json?t=1`.

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

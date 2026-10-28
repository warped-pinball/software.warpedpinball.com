#!/usr/bin/env python3
import os
import sys
import json
import argparse
import hashlib
import shutil
import requests
from github import Github
import re
import markdown
import bleach
import base64
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


PRODUCT_ASSETS = {
    "sys11": "update.json",
    "wpc": "update_wpc.json",
    "em": "update_em.json",
    "data_east": "update_data_east.json",
    "whitestar": "update_whitestar.json",
    "classic": "update_classic.json",
}


def parse_update_file(content):
    """Return ``(metadata, sha256, signature)`` from the raw bytes of an update file.

    An update file is a JSON metadata line, then one line per file, then a
    final ``{"sha256": ..., "signature": ...}`` line. That sha256 covers
    everything above it, and the signature is the release key's RSA signature
    of it. Boards check both before applying an update. ``sha256`` and
    ``signature`` are ``None`` when the file has no such line.
    """

    # splitlines handles both ``\n`` and ``\r\n`` newlines
    metadata = json.loads(content.splitlines()[0])

    body, _, last_line = content.rstrip(b"\r\n").rpartition(b"\n")
    try:
        checksum = json.loads(last_line)
        sha256 = checksum.get("sha256")
        signature = checksum.get("signature")
    except (ValueError, AttributeError):
        return metadata, None, None

    if sha256 and hashlib.sha256(body).hexdigest() != sha256:
        print(
            "⚠️ Update file checksum does not match its contents", file=sys.stderr
        )
    return metadata, sha256, signature


def fetch_update_file(url):
    """Download an update file and return ``(metadata, sha256, signature)``, or ``None``."""

    response = requests.get(url)
    if response.status_code != 200:
        return None
    return parse_update_file(response.content)


def calculate_json_hash(json_data):
    """Return a deterministic SHA256 digest for a JSON object."""
    return hashlib.sha256(
        json.dumps(json_data, sort_keys=True).encode("utf-8")
    ).hexdigest()


def normalize_product_name(name):
    """Return a canonical product key without whitespace or separators."""

    return re.sub(r"[^a-z0-9]+", "", name.lower())


def find_versions_section_bounds(text):
    """Return ``(heading_index, heading_span, footer_index)`` for the versions section."""
    if not text:
        return None

    lines = text.splitlines(keepends=True)
    footer_pattern = re.compile(
        r"^\s*<!--\s*END VERSIONS SECTION\s*-->\s*$", re.IGNORECASE
    )
    atx_versions_pattern = re.compile(
        r"^[ ]{0,3}#{1,6}\s*(?:[*_`]+)?Versions(?:[*_`]+)?(?:\s+#+)?\s*$",
        re.IGNORECASE,
    )
    setext_versions_pattern = re.compile(
        r"^[ ]{0,3}(?:[*_`]+)?Versions(?:[*_`]+)?\s*$", re.IGNORECASE
    )
    setext_underline_pattern = re.compile(r"^[ ]{0,3}(?:-{3,}|={3,})\s*$")
    atx_heading_pattern = re.compile(r"^[ ]{0,3}#{1,6}(?:\s+|$)")

    def line_text(index):
        return lines[index].rstrip("\r\n")

    def heading_span(index):
        current_line = line_text(index)
        if atx_heading_pattern.match(current_line):
            return 1
        if (
            index + 1 < len(lines)
            and current_line.strip()
            and setext_underline_pattern.match(line_text(index + 1))
        ):
            return 2
        return 0

    def versions_heading_span(index):
        current_line = line_text(index)
        if atx_versions_pattern.match(current_line):
            return 1
        if (
            index + 1 < len(lines)
            and setext_versions_pattern.match(current_line)
            and setext_underline_pattern.match(line_text(index + 1))
        ):
            return 2
        return 0

    for index in range(len(lines)):
        header_span = versions_heading_span(index)
        if not header_span:
            continue

        footer_index = None
        next_index = index + header_span
        while next_index < len(lines):
            if footer_pattern.match(line_text(next_index)):
                footer_index = next_index
                break
            if heading_span(next_index):
                break
            next_index += 1

        if footer_index is not None:
            return index, header_span, footer_index

    return None


def parse_release_versions(text):
    """Return a mapping of normalized product name to version from a release body."""
    bounds = find_versions_section_bounds(text)
    if bounds is None:
        return {}

    start_index, header_span, footer_index = bounds
    lines = text.splitlines(keepends=True)
    section = "".join(lines[start_index + header_span : footer_index])
    versions = {}
    for m in re.finditer(r"\*\*([^*]+)\*\*\s*:\s*`([^`]+)`", section):
        product = normalize_product_name(m.group(1))
        versions[product] = m.group(2).strip()
    return versions


def filter_release_note_versions(text, target_product):
    """Keep only the common and target-product versions in release notes."""
    if not text:
        return ""

    allowed_products = {"vector", normalize_product_name(target_product)}
    lines = text.splitlines(keepends=True)
    bounds = find_versions_section_bounds(text)
    if bounds is None:
        return text

    index, header_span, footer_index = bounds
    filtered_body = []
    for line in lines[index + header_span : footer_index]:
        version_match = re.match(
            r"[ ]{0,3}\*\*([^*]+)\*\*\s*:\s*`[^`]+`[ \t]*$",
            line.rstrip("\r\n"),
        )
        if not version_match:
            filtered_body.append(line)
            continue

        product = normalize_product_name(version_match.group(1))
        if product in allowed_products:
            filtered_body.append(line)

    return "".join(
        lines[: index + header_span]
        + filtered_body
        + lines[footer_index:]
    )


def release_notes_to_html(text):
    """Convert Markdown release notes to sanitized HTML without images."""
    if not text:
        return ""
    # use the nl2br extension so single newlines become ``<br>`` tags
    html = markdown.markdown(text, extensions=["nl2br"])
    allowed_tags = set(bleach.sanitizer.ALLOWED_TAGS).union(
        {"p", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "br"}
    ) - {"img"}
    return bleach.clean(
        html,
        tags=list(allowed_tags),
        attributes=bleach.sanitizer.ALLOWED_ATTRIBUTES,
        strip=True,
    )



# Environment variable holding the PEM private key that signs latest.json.
# Its public half is compiled into Vector, which refuses an update whose
# release record this key did not sign.
SIGNING_KEY_ENV = "RELEASE_SIGNING_PRIVATE_KEY"


def load_signing_key():
    """Return the release signing key from the environment, or ``None``."""

    pem = os.getenv(SIGNING_KEY_ENV)
    if not pem:
        return None
    return serialization.load_pem_private_key(pem.encode(), password=None)


def sign_release(release_data, product, signing_key):
    """Return the ``signed`` block for latest.json.

    ``payload`` is the release record as a JSON string, so a board verifies
    exactly these bytes and then reads the fields out of it: there is no
    second serialisation that has to match. ``product`` is inside it so a
    board can't be handed another product's release.
    """

    payload = json.dumps(
        {"product": product, **release_data}, sort_keys=True, separators=(",", ":")
    )
    signature = signing_key.sign(payload.encode(), padding.PKCS1v15(), hashes.SHA256())
    return {"payload": payload, "signature": base64.b64encode(signature).decode()}


def build_latest_release_data(owner, repo, release_entry):
    """Return a standardized latest.json payload for a single release."""

    return {
        "version": release_entry["version"],
        "url": release_entry["url"],
        "sha256": release_entry.get("sha256"),
        "signature": release_entry.get("signature"),
        "release_page": f"https://github.com/{owner}/{repo}/releases/tag/{release_entry['tag']}",
        "notes": release_entry["notes"],
        "published_at": release_entry["published_at"],
    }


def build_file_entry(
    product, version, release_type, url, sha256, signature, metadata_sha256
):
    """Return metadata for builds.json without download counts.

    ``sha256`` and ``signature`` are the checksum and its RSA signature
    embedded at the end of the update file.
    ``metadata_sha256`` hashes only its first (metadata) line, and is how a
    production build identical to the previous one is recognised.
    """

    return {
        "product": product,
        "version": version,
        "type": release_type,
        "url": url,
        "sha256": sha256,
        "signature": signature,
        "metadata_sha256": metadata_sha256,
    }


def build_download_record(product, version, release_type, url, count):
    """Return a record used to track download counts separately."""

    return {
        "product": product,
        "version": version,
        "type": release_type,
        "url": url,
        "download_count": count,
    }


# Every field builds.json carries. An existing builds.json missing any of them
# was written by an older generator, so an incremental sync would leave its
# entries without the new field; the generator rebuilds from scratch instead.
FILE_ENTRY_FIELDS = set(build_file_entry(*[None] * 7))


def tag_from_asset_url(url):
    """Return the release tag in a ``.../releases/download/<tag>/<asset>`` URL."""

    return url.rstrip("/").split("/")[-2]


def empty_state():
    return {
        "releases_by_product": {
            product: {"prod": [], "beta": [], "dev": [], "all": []}
            for product in PRODUCT_ASSETS
        },
        # last production metadata hash per product, to skip identical builds
        "previous_update_hashes": {product: None for product in PRODUCT_ASSETS},
        "file_db": [],  # metadata for all update files (without download counts)
        "download_records": [],  # download counts for each asset
    }


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def load_existing_state(out_dir):
    """Return the state previously written to ``out_dir``, or ``None``.

    ``None`` means there is nothing usable to build on, so the caller does a
    full rebuild: no builds.json yet, or one from an older generator that is
    missing a field.
    """

    file_db = load_json(os.path.join(out_dir, "builds.json"), None)
    if not file_db:
        return None
    if any(not FILE_ENTRY_FIELDS <= set(entry) for entry in file_db):
        print("ℹ️ builds.json predates the current fields; rebuilding from scratch")
        return None

    state = empty_state()
    state["file_db"] = file_db
    state["download_records"] = load_json(
        os.path.join(out_dir, "download_counts.json"), []
    )

    for product, groups in state["releases_by_product"].items():
        all_path = os.path.join(out_dir, "vector", product, "all.json")
        for entry in load_json(all_path, []):
            groups["all"].append(entry)
            groups[release_group(entry["type"])].append(entry)

    # builds.json is in processing order, oldest first
    for entry in file_db:
        if entry["type"] == "production" and entry["product"] in PRODUCT_ASSETS:
            state["previous_update_hashes"][entry["product"]] = entry[
                "metadata_sha256"
            ]

    return state


def release_group(release_type):
    return "prod" if release_type == "production" else release_type


def releases_to_process(repository, known_tags):
    """Return the releases not yet in the site, oldest first.

    GitHub lists releases newest first, so walk back from the present and
    stop at the first one already published here. With no ``known_tags``
    that is every release.
    """

    new_releases = []
    for release in repository.get_releases():
        if release.tag_name in known_tags:
            break
        new_releases.append(release)
    # oldest -> newest so we only skip later duplicates
    new_releases.sort(key=lambda r: r.created_at)
    return new_releases


def process_release(release, state):
    tag = release.tag_name or ""
    base_version = tag
    lower_tag = tag.lower()
    for product in PRODUCT_ASSETS:
        prefix = f"{product.replace('_', '-')}-"
        if lower_tag.startswith(prefix):
            base_version = lower_tag[len(prefix):]
            break

    versions_in_body = parse_release_versions(release.body or "")

    # gather assets by name
    assets = {a.name: a for a in release.get_assets()}
    for product, asset_name in PRODUCT_ASSETS.items():
        asset = assets.get(asset_name)
        if not asset:
            continue

        update_file = fetch_update_file(asset.browser_download_url)
        if update_file is None:
            print(f"⏭️ Skipping {tag} {asset_name}: failed to fetch", file=sys.stderr)
            continue
        update_data, sha256, signature = update_file
        print(f"📦 {tag} {asset_name}")

        normalized_product = normalize_product_name(product)
        product_version = versions_in_body.get(normalized_product, base_version)
        release_type = "production"
        if re.search(r"-dev\d+$", product_version):
            release_type = "dev"
        elif re.search(r"-beta-?\d+$", product_version):
            release_type = "beta"

        update_hash = calculate_json_hash(update_data)

        state["file_db"].append(
            build_file_entry(
                product,
                product_version,
                release_type,
                asset.browser_download_url,
                sha256,
                signature,
                update_hash,
            )
        )

        state["download_records"].append(
            build_download_record(
                product,
                product_version,
                release_type,
                asset.browser_download_url,
                asset.download_count,
            )
        )

        # Only skip if this is a production build identical to previous production
        previous_update_hashes = state["previous_update_hashes"]
        if (
            release_type == "production"
            and previous_update_hashes[product] == update_hash
        ):
            continue

        if release_type == "production":
            previous_update_hashes[product] = update_hash

        release_entry = {
            "version": product_version,
            "tag": tag,
            "url": asset.browser_download_url,
            "sha256": sha256,
            "signature": signature,
            "notes": release_notes_to_html(
                filter_release_note_versions(release.body, product)
            ),
            "published_at": release.published_at.isoformat(),
            "type": release_type,
        }
        groups = state["releases_by_product"][product]
        groups["all"].append(release_entry)
        groups[release_group(release_type)].append(release_entry)


def write_outputs(state, out_dir, owner, repo, signing_key=None):
    # Write out the JSON files for each product
    for product, groups in state["releases_by_product"].items():
        if groups["all"]:
            # All firmware metadata now lives under docs/vector/<product>
            out_folder = os.path.join(out_dir, "vector", product)
            os.makedirs(out_folder, exist_ok=True)

            # write combined data for backward compatibility
            all_path = os.path.join(out_folder, "all.json")
            with open(all_path, "w") as f:
                json.dump(groups["all"], f, indent=2)
            print(f"✅ Wrote {all_path}")

            # write per-type JSON files
            for key, filename in [
                ("prod", "prod.json"),
                ("beta", "beta.json"),
                ("dev", "dev.json"),
            ]:
                path = os.path.join(out_folder, filename)
                with open(path, "w") as f:
                    json.dump(groups[key], f, indent=2)
                print(f"✅ Wrote {path}")

            # Write the latest production release to a separate file (latest.json)
            prod_releases = groups["prod"]
            if prod_releases:
                latest_release = max(prod_releases, key=lambda r: r["published_at"])
            else:
                latest_release = max(groups["all"], key=lambda r: r["published_at"])

            latest_release_data = build_latest_release_data(
                owner, repo, latest_release
            )
            # The plain fields stay for boards from before signed releases;
            # newer boards only trust what is inside ``signed``
            if signing_key is not None:
                latest_release_data["signed"] = sign_release(
                    latest_release_data, product, signing_key
                )

            # Latest release metadata in the same folder
            # https://software.warpedpinball.com/vector/<product>/latest.json
            latest_path = os.path.join(out_folder, "latest.json")
            with open(latest_path, "w") as f:
                json.dump(latest_release_data, f, indent=2)
            print(f"✅ Wrote {latest_path} for {product}")

    # write mini database of all update files
    if state["file_db"]:
        build_db_path = os.path.join(out_dir, "builds.json")
        with open(build_db_path, "w") as f:
            json.dump(state["file_db"], f, indent=2)
        print(f"✅ Wrote {build_db_path}")

    if state["download_records"]:
        counts_path = os.path.join(out_dir, "download_counts.json")
        with open(counts_path, "w") as f:
            json.dump(state["download_records"], f, indent=2)
        print(f"✅ Wrote {counts_path}")


def remove_generated_files(out_dir):
    """Delete everything the generator writes, leaving index.html and the icons."""

    out_vector_dir = os.path.join(out_dir, "vector")
    if os.path.exists(out_vector_dir):
        shutil.rmtree(out_vector_dir)
    for name in ("builds.json", "download_counts.json"):
        path = os.path.join(out_dir, name)
        if os.path.exists(path):
            os.remove(path)


def main():
    p = argparse.ArgumentParser(
        description=(
            "Fetch releases from warped-pinball/vector and generate " "per-product JSON"
        )
    )
    p.add_argument(
        "--owner", required=True, help="GitHub org or user (e.g. warped-pinball)"
    )
    p.add_argument("--repo", required=True, help="Repo name to scan (e.g. vector)")
    p.add_argument(
        "--out-dir",
        default="docs",
        help=(
            "Where to write JSON files (defaults to the 'docs' folder "
            "so GitHub Pages can serve them)"
        ),
    )
    p.add_argument(
        "--full",
        action="store_true",
        help=(
            "Rebuild every release from scratch instead of only adding releases "
            "newer than the ones already in --out-dir. Use it after adding a "
            "field, editing old release notes, or deleting a release."
        ),
    )
    args = p.parse_args()

    token = os.getenv("GITHUB_TOKEN")
    if not token:
        sys.stderr.write("ERROR: GITHUB_TOKEN not set\n")
        sys.exit(1)

    signing_key = load_signing_key()
    if signing_key is None:
        print(
            f"⚠️ {SIGNING_KEY_ENV} not set; latest.json is unsigned and "
            "current boards will refuse it",
            file=sys.stderr,
        )

    state = None if args.full else load_existing_state(args.out_dir)
    if state is None:
        # Remove any previously generated release data so deleted releases
        # don't linger on the website.
        remove_generated_files(args.out_dir)
        state = empty_state()
        print("🔄 Full rebuild of every release")

    known_tags = {tag_from_asset_url(entry["url"]) for entry in state["file_db"]}

    gh = Github(token)
    repository = gh.get_repo(f"{args.owner}/{args.repo}")

    new_releases = releases_to_process(repository, known_tags)
    print(f"🆕 {len(new_releases)} release(s) to add")
    for release in new_releases:
        process_release(release, state)

    write_outputs(state, args.out_dir, args.owner, args.repo, signing_key)
    print("✅ Generated release data for all products.")


if __name__ == "__main__":
    main()

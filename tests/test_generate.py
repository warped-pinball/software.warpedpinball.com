import base64
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(
    0,
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
)

import scripts.generate as generate  # noqa: E402


def test_product_assets_known_products():
    assert generate.PRODUCT_ASSETS == {
        "sys11": "update.json",
        "wpc": "update_wpc.json",
        "em": "update_em.json",
        "data_east": "update_data_east.json",
        "whitestar": "update_whitestar.json",
        "classic": "update_classic.json",
    }


def test_calculate_json_hash_deterministic():
    data1 = {"a": 1, "b": 2}
    data2 = {"b": 2, "a": 1}
    hash1 = generate.calculate_json_hash(data1)
    hash2 = generate.calculate_json_hash(data2)
    assert hash1 == hash2


def make_update_file(metadata, files=(b"file-one", b"file-two"), newline=b"\n"):
    body = newline.join([json.dumps(metadata).encode(), *files])
    sha256 = hashlib.sha256(body).hexdigest()
    signature = json.dumps({"sha256": sha256, "signature": "sig"}).encode()
    return body + newline + signature + newline, sha256


def test_parse_update_file_reads_metadata_and_trailing_checksum():
    content, sha256 = make_update_file({"version": "1.0"})
    assert generate.parse_update_file(content) == ({"version": "1.0"}, sha256, "sig")


def test_parse_update_file_without_checksum_line():
    content = json.dumps({"version": "1.0"}).encode() + b"\nBINARYDATA"
    assert generate.parse_update_file(content) == ({"version": "1.0"}, None, None)


def test_parse_update_file_reports_mismatched_checksum(capsys):
    content, sha256 = make_update_file({"version": "1.0"})
    tampered = content.replace(b"file-one", b"file-0ne")
    assert generate.parse_update_file(tampered) == (
        {"version": "1.0"},
        sha256,
        "sig",
    )
    assert "does not match" in capsys.readouterr().err


def test_fetch_update_file_success(monkeypatch):
    content, sha256 = make_update_file({"version": "1.0"})

    class MockResponse:
        status_code = 200

    MockResponse.content = content
    monkeypatch.setattr(generate.requests, "get", lambda url: MockResponse())
    result = generate.fetch_update_file("http://example.com/update.json")
    assert result == ({"version": "1.0"}, sha256, "sig")


def test_fetch_update_file_failure(monkeypatch):
    class MockResponse:
        status_code = 404
        content = b""

    monkeypatch.setattr(generate.requests, "get", lambda url: MockResponse())
    assert generate.fetch_update_file("http://example.com/missing.json") is None


def test_parse_release_versions():
    body = (
        "Some notes\n"
        "## Versions\n"
        "**Vector**: `1.3.11-dev83`\n"
        "**Sys11**: `1.0.0-dev83`\n"
        "**WPC**: `0.0.0-dev83`\n"
        "**EM**: `0.0.1-dev83`\n"
        "**Data East**: `0.0.1-dev83`\n"
        "**Whitestar**: `0.0.1-dev83`\n"
        "**Classic**: `0.0.2-dev83`\n"
        "<!-- END VERSIONS SECTION -->\nMore text"
    )
    versions = generate.parse_release_versions(body)
    assert versions == {
        "vector": "1.3.11-dev83",
        "sys11": "1.0.0-dev83",
        "wpc": "0.0.0-dev83",
        "em": "0.0.1-dev83",
        "dataeast": "0.0.1-dev83",
        "whitestar": "0.0.1-dev83",
        "classic": "0.0.2-dev83",
    }


def test_normalize_product_name_handles_separators():
    assert generate.normalize_product_name("Data East") == "dataeast"
    assert generate.normalize_product_name("data_east") == "dataeast"
    assert generate.normalize_product_name("Data-East") == "dataeast"


def test_product_version_lookup_uses_normalized_key():
    versions = {"dataeast": "0.1.0"}
    product = "data_east"
    assert versions.get(generate.normalize_product_name(product), "fallback") == "0.1.0"


def test_parse_release_versions_missing():
    body = "No version info"
    versions = generate.parse_release_versions(body)
    assert versions == {}



def test_parse_release_versions_whitespace():
    body = (
        "Intro text\r\n"
        "##   VERSIONS   \r\n"
        "**Vector** :   `2.0`\r\n"
        "<!-- END VERSIONS SECTION -->\r\n"
    )
    assert generate.parse_release_versions(body) == {"vector": "2.0"}


def test_main_uses_versions_parser_for_formatted_and_setext_headings(monkeypatch, tmp_path):
    class MockAsset:
        def __init__(self):
            self.name = "update_wpc.json"
            self.browser_download_url = "https://example.com/update_wpc.json"
            self.download_count = 3

    class MockRelease:
        def __init__(self, body):
            self.tag_name = "wpc-9.9.9"
            self.body = body
            self.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
            self.published_at = datetime(2026, 1, 1, tzinfo=timezone.utc)

        def get_assets(self):
            return [MockAsset()]

    class MockRepository:
        def __init__(self, body):
            self._body = body

        def get_releases(self):
            return [MockRelease(self._body)]

    bodies = [
        (
            "## **Versions**\n"
            "**Vector**: `1.3.11`\n"
            "**WPC**: `0.0.0-beta-7`\n"
            "<!-- END VERSIONS SECTION -->\n"
        ),
        (
            "Versions\n"
            "--------\n"
            "**Vector**: `1.3.11`\n"
            "**WPC**: `0.0.0-beta-8`\n"
            "<!-- END VERSIONS SECTION -->\n"
        ),
    ]

    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setattr(
        generate, "fetch_update_file", lambda _: ({"ok": True}, "abc", "sig")
    )

    for index, body in enumerate(bodies):
        out_dir = tmp_path / str(index)
        monkeypatch.setattr(
            generate,
            "Github",
            lambda token, release_body=body: type(
                "MockGithub",
                (),
                {"get_repo": lambda self, _: MockRepository(release_body)},
            )(),
        )
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "generate.py",
                "--owner",
                "warped-pinball",
                "--repo",
                "vector",
                "--out-dir",
                str(out_dir),
            ],
        )
        generate.main()

        beta_path = out_dir / "vector" / "wpc" / "beta.json"
        with beta_path.open() as beta_file:
            beta_releases = json.load(beta_file)
        assert len(beta_releases) == 1
        assert beta_releases[0]["version"].startswith("0.0.0-beta-")


def test_filter_release_note_versions_keeps_only_vector_and_target():
    body = (
        "Some notes\n"
        "## Versions\n"
        "**Vector**: `1.3.11-dev83`\n"
        "**Sys11**: `1.0.0-dev83`\n"
        "**WPC**: `0.0.0-dev83`\n"
        "**EM**: `0.0.1-dev83`\n"
        "<!-- END VERSIONS SECTION -->\n"
        "More text"
    )

    filtered = generate.filter_release_note_versions(body, "sys11")

    assert "**Vector**: `1.3.11-dev83`" in filtered
    assert "**Sys11**: `1.0.0-dev83`" in filtered
    assert "**WPC**: `0.0.0-dev83`" not in filtered
    assert "**EM**: `0.0.1-dev83`" not in filtered
    assert "More text" in filtered


def test_filter_release_note_versions_supports_crlf():
    body = (
        "Some notes\r\n"
        "## Versions\r\n"
        "**Vector**: `1.3.11-dev83`\r\n"
        "**WPC**: `0.0.0-dev83`\r\n"
        "**EM**: `0.0.1-dev83`\r\n"
        "<!-- END VERSIONS SECTION -->\r\n"
        "More text"
    )

    filtered = generate.filter_release_note_versions(body, "wpc")

    assert "**Vector**: `1.3.11-dev83`" in filtered
    assert "**WPC**: `0.0.0-dev83`" in filtered
    assert "**EM**: `0.0.1-dev83`" not in filtered


def test_filter_release_note_versions_supports_indented_heading():
    body = (
        "Some notes\n"
        "   ## Versions\n"
        "**Vector**: `1.3.11-dev83`\n"
        "**WPC**: `0.0.0-dev83`\n"
        "**EM**: `0.0.1-dev83`\n"
        "<!-- END VERSIONS SECTION -->\n"
        "More text"
    )

    filtered = generate.filter_release_note_versions(body, "wpc")

    assert "**Vector**: `1.3.11-dev83`" in filtered
    assert "**WPC**: `0.0.0-dev83`" in filtered
    assert "**EM**: `0.0.1-dev83`" not in filtered


def test_filter_release_note_versions_supports_formatted_heading():
    body = (
        "Some notes\n"
        "## **Versions**\n"
        "**Vector**: `1.3.11-dev83`\n"
        "**WPC**: `0.0.0-dev83`\n"
        "**EM**: `0.0.1-dev83`\n"
        "<!-- END VERSIONS SECTION -->\n"
        "More text"
    )

    filtered = generate.filter_release_note_versions(body, "wpc")

    assert "**Vector**: `1.3.11-dev83`" in filtered
    assert "**WPC**: `0.0.0-dev83`" in filtered
    assert "**EM**: `0.0.1-dev83`" not in filtered


def test_filter_release_note_versions_supports_indented_version_rows():
    body = (
        "Some notes\n"
        "## Versions\n"
        "   **Vector**: `1.3.11-dev83`\n"
        "   **WPC**: `0.0.0-dev83`\n"
        "   **EM**: `0.0.1-dev83`\n"
        "<!-- END VERSIONS SECTION -->\n"
        "More text"
    )

    filtered = generate.filter_release_note_versions(body, "wpc")

    assert "   **Vector**: `1.3.11-dev83`" in filtered
    assert "   **WPC**: `0.0.0-dev83`" in filtered
    assert "   **EM**: `0.0.1-dev83`" not in filtered


def test_filter_release_note_versions_supports_atx_closing_hashes():
    body = (
        "Some notes\n"
        "## Versions ##\n"
        "**Vector**: `1.3.11-dev83`\n"
        "**WPC**: `0.0.0-dev83`\n"
        "**EM**: `0.0.1-dev83`\n"
        "<!-- END VERSIONS SECTION -->\n"
        "More text"
    )

    filtered = generate.filter_release_note_versions(body, "wpc")

    assert "**Vector**: `1.3.11-dev83`" in filtered
    assert "**WPC**: `0.0.0-dev83`" in filtered
    assert "**EM**: `0.0.1-dev83`" not in filtered


def test_filter_release_note_versions_supports_setext_heading():
    body = (
        "Some notes\n"
        "Versions\n"
        "--------\n"
        "**Vector**: `1.3.11-dev83`\n"
        "**WPC**: `0.0.0-dev83`\n"
        "**EM**: `0.0.1-dev83`\n"
        "<!-- END VERSIONS SECTION -->\n"
        "More text"
    )

    filtered = generate.filter_release_note_versions(body, "wpc")

    assert "**Vector**: `1.3.11-dev83`" in filtered
    assert "**WPC**: `0.0.0-dev83`" in filtered
    assert "**EM**: `0.0.1-dev83`" not in filtered


def test_filter_release_note_versions_ignores_incomplete_earlier_section():
    body = (
        "## Versions\n"
        "**Vector**: `old`\n"
        "## Other Heading\n"
        "Some text\n"
        "## Versions\n"
        "**Vector**: `1.3.11-dev83`\n"
        "**WPC**: `0.0.0-dev83`\n"
        "**EM**: `0.0.1-dev83`\n"
        "<!-- END VERSIONS SECTION -->\n"
    )

    filtered = generate.filter_release_note_versions(body, "wpc")

    assert "**Vector**: `old`" in filtered
    assert "**WPC**: `0.0.0-dev83`" in filtered
    assert "**EM**: `0.0.1-dev83`" not in filtered


def test_filter_release_note_versions_supports_trailing_row_whitespace():
    body = (
        "## Versions\n"
        "**Vector**: `1.3.11-dev83`  \n"
        "**WPC**: `0.0.0-dev83`   \n"
        "**EM**: `0.0.1-dev83` \t\n"
        "<!-- END VERSIONS SECTION -->\n"
    )

    filtered = generate.filter_release_note_versions(body, "wpc")

    assert "**Vector**: `1.3.11-dev83`  \n" in filtered
    assert "**WPC**: `0.0.0-dev83`   \n" in filtered
    assert "**EM**: `0.0.1-dev83` \t\n" not in filtered


def test_release_notes_to_html_uses_filtered_versions_section():
    md = (
        "## Versions\n"
        "**Vector**: `1.3.11-dev83`\n"
        "**WPC**: `0.0.0-dev83`\n"
        "**EM**: `0.0.1-dev83`\n"
        "<!-- END VERSIONS SECTION -->"
    )

    html = generate.release_notes_to_html(
        generate.filter_release_note_versions(md, "wpc")
    )

    assert "Vector" in html
    assert "WPC" in html
    assert "EM" not in html


def test_release_notes_to_html_uses_filtered_versions_section_with_crlf():
    md = (
        "## Versions\r\n"
        "**Vector**: `1.3.11-dev83`\r\n"
        "**WPC**: `0.0.0-dev83`\r\n"
        "**EM**: `0.0.1-dev83`\r\n"
        "<!-- END VERSIONS SECTION -->"
    )

    html = generate.release_notes_to_html(
        generate.filter_release_note_versions(md, "wpc")
    )

    assert "Vector" in html
    assert "WPC" in html
    assert "EM" not in html


def test_release_notes_to_html_sanitizes_and_strips_images():
    md = "Hello! ![img](http://example.com/a.png) <script>alert('x')</script>"
    html = generate.release_notes_to_html(md)
    assert "<img" not in html
    assert "script" not in html
    assert "Hello" in html


def test_release_notes_to_html_converts_newlines_to_br():
    md = "Line 1\nLine 2"
    html = generate.release_notes_to_html(md)
    assert "<br" in html



def test_build_latest_release_data_uses_tag():
    entry = {
        "version": "0.0.2-beta493",
        "tag": "1.3.11-beta493",
        "url": "https://github.com/warped-pinball/vector/releases/download/1.3.11-beta493/update_wpc.json",
        "notes": "notes",
        "published_at": "2025-07-18T20:12:57+00:00",
    }

    result = generate.build_latest_release_data("warped-pinball", "vector", entry)
    assert result["release_page"].endswith("/releases/tag/1.3.11-beta493")
    assert result["version"] == entry["version"]


def test_build_file_entry():
    file_entry = generate.build_file_entry(
        "sys11",
        "1.0.0",
        "prod",
        "https://example.com/update.json",
        "deadbeef",
        "c2ln",
        "cafef00d",
    )

    assert "download_count" not in file_entry
    assert file_entry["sha256"] == "deadbeef"
    assert file_entry["signature"] == "c2ln"
    assert file_entry["metadata_sha256"] == "cafef00d"


def test_calculate_json_hash_unique():
    first = {"x": 1}
    second = {"x": 2}
    assert generate.calculate_json_hash(first) != generate.calculate_json_hash(second)


def test_parse_update_file_crlf():
    content, _ = make_update_file({"foo": "bar"}, newline=b"\r\n")
    metadata, _, _ = generate.parse_update_file(content)
    assert metadata == {"foo": "bar"}


def test_parse_release_versions_whitespace():
    body = (
        "Intro text\r\n"
        "##   VERSIONS   \r\n"
        "**Vector** :   `2.0`\r\n"
        "<!-- END VERSIONS SECTION -->\r\n"
    )
    assert generate.parse_release_versions(body) == {"vector": "2.0"}


class FakeAsset:
    def __init__(self, tag, name="update.json", download_count=1):
        self.name = name
        self.browser_download_url = (
            f"https://github.com/warped-pinball/vector/releases/download/{tag}/{name}"
        )
        self.download_count = download_count


class FakeRelease:
    def __init__(self, tag, day):
        self.tag_name = tag
        self.body = f"Notes for {tag}"
        self.created_at = datetime(2026, 1, day, tzinfo=timezone.utc)
        self.published_at = self.created_at

    def get_assets(self):
        return [FakeAsset(self.tag_name)]


def run_generator(monkeypatch, out_dir, releases, *extra_args):
    """Run main() against ``releases`` and return the URLs it downloaded."""

    fetched = []

    def fake_fetch(url):
        fetched.append(url)
        tag = generate.tag_from_asset_url(url)
        return {"version": tag}, f"sha-{tag}", f"sig-{tag}"

    # GitHub lists releases newest first
    newest_first = sorted(releases, key=lambda r: r.created_at, reverse=True)
    repository = type("Repo", (), {"get_releases": lambda self: newest_first})()
    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setattr(generate, "fetch_update_file", fake_fetch)
    monkeypatch.setattr(
        generate,
        "Github",
        lambda token: type("Gh", (), {"get_repo": lambda self, _: repository})(),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["generate.py", "--owner", "warped-pinball", "--repo", "vector"]
        + ["--out-dir", str(out_dir), *extra_args],
    )
    generate.main()
    return [generate.tag_from_asset_url(url) for url in fetched]


def read_outputs(out_dir):
    return {
        str(path.relative_to(out_dir)): json.loads(path.read_text())
        for path in sorted(out_dir.rglob("*.json"))
    }


def test_sync_only_fetches_releases_newer_than_the_site(monkeypatch, tmp_path):
    first = [FakeRelease("1.0.0", 1), FakeRelease("1.1.0-beta2", 2)]
    later = first + [FakeRelease("1.2.0-dev3", 3), FakeRelease("1.2.0", 4)]

    assert run_generator(monkeypatch, tmp_path / "site", first) == [
        "1.0.0",
        "1.1.0-beta2",
    ]
    assert run_generator(monkeypatch, tmp_path / "site", later) == [
        "1.2.0-dev3",
        "1.2.0",
    ]
    assert run_generator(monkeypatch, tmp_path / "site", later) == []

    run_generator(monkeypatch, tmp_path / "scratch", later)
    assert read_outputs(tmp_path / "site") == read_outputs(tmp_path / "scratch")

    latest = read_outputs(tmp_path / "site")["vector/sys11/latest.json"]
    assert latest["version"] == "1.2.0"
    assert latest["sha256"] == "sha-1.2.0"
    assert latest["signature"] == "sig-1.2.0"


def test_full_flag_refetches_every_release(monkeypatch, tmp_path):
    releases = [FakeRelease("1.0.0", 1), FakeRelease("1.1.0", 2)]
    run_generator(monkeypatch, tmp_path, releases)
    assert run_generator(monkeypatch, tmp_path, releases, "--full") == [
        "1.0.0",
        "1.1.0",
    ]


def test_full_rebuild_drops_deleted_releases(monkeypatch, tmp_path):
    run_generator(monkeypatch, tmp_path, [FakeRelease("1.0.0", 1)])
    run_generator(monkeypatch, tmp_path, [FakeRelease("1.1.0", 2)], "--full")
    builds = read_outputs(tmp_path)["builds.json"]
    assert [entry["version"] for entry in builds] == ["1.1.0"]


def test_builds_json_from_older_generator_triggers_full_rebuild(
    monkeypatch, tmp_path
):
    releases = [FakeRelease("1.0.0", 1), FakeRelease("1.1.0", 2)]
    run_generator(monkeypatch, tmp_path, releases)

    builds_path = tmp_path / "builds.json"
    builds = json.loads(builds_path.read_text())
    for entry in builds:
        del entry["metadata_sha256"]
    builds_path.write_text(json.dumps(builds))

    assert run_generator(monkeypatch, tmp_path, releases) == ["1.0.0", "1.1.0"]


def test_incremental_sync_skips_production_build_identical_to_previous(
    monkeypatch, tmp_path
):
    releases = [FakeRelease("1.0.0", 1)]
    run_generator(monkeypatch, tmp_path, releases)

    # same metadata line as 1.0.0, so the same build republished
    def fake_fetch(url):
        return {"version": "1.0.0"}, "sha-same", "sig-same"

    repeat = FakeRelease("1.0.1", 2)
    repository = type("Repo", (), {"get_releases": lambda self: [repeat]})()
    monkeypatch.setattr(generate, "fetch_update_file", fake_fetch)
    monkeypatch.setattr(
        generate,
        "Github",
        lambda token: type("Gh", (), {"get_repo": lambda self, _: repository})(),
    )
    generate.main()

    outputs = read_outputs(tmp_path)
    assert [r["version"] for r in outputs["vector/sys11/prod.json"]] == ["1.0.0"]
    assert len(outputs["builds.json"]) == 2


def test_latest_json_is_signed_when_a_key_is_set(monkeypatch, tmp_path):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    monkeypatch.setenv(generate.SIGNING_KEY_ENV, pem)

    run_generator(monkeypatch, tmp_path, [FakeRelease("1.0.0", 1)])
    latest = read_outputs(tmp_path)["vector/sys11/latest.json"]

    signed = latest["signed"]
    key.public_key().verify(
        base64.b64decode(signed["signature"]),
        signed["payload"].encode(),
        padding.PKCS1v15(),
        hashes.SHA256(),
    )
    payload = json.loads(signed["payload"])
    assert payload["product"] == "sys11"
    assert {k: v for k, v in latest.items() if k != "signed"} == {
        k: v for k, v in payload.items() if k != "product"
    }


def test_latest_json_is_unsigned_without_a_key(monkeypatch, tmp_path):
    monkeypatch.delenv(generate.SIGNING_KEY_ENV, raising=False)
    run_generator(monkeypatch, tmp_path, [FakeRelease("1.0.0", 1)])
    assert "signed" not in read_outputs(tmp_path)["vector/sys11/latest.json"]

import json
import os
import sys

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
    }


def test_calculate_json_hash_deterministic():
    data1 = {"a": 1, "b": 2}
    data2 = {"b": 2, "a": 1}
    hash1 = generate.calculate_json_hash(data1)
    hash2 = generate.calculate_json_hash(data2)
    assert hash1 == hash2


def test_fetch_update_json_success(monkeypatch):
    json_line = json.dumps({"version": "1.0"})

    class MockResponse:
        status_code = 200
        text = json_line + "\nBINARYDATA"

    def mock_get(url):
        return MockResponse()

    monkeypatch.setattr(generate.requests, "get", mock_get)
    result = generate.fetch_update_json("http://example.com/update.json")
    assert result == {"version": "1.0"}


def test_fetch_update_json_failure(monkeypatch):
    class MockResponse:
        status_code = 404
        text = ""

    def mock_get(url):
        return MockResponse()

    monkeypatch.setattr(generate.requests, "get", mock_get)
    result = generate.fetch_update_json("http://example.com/missing.json")
    assert result is None


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


def test_build_file_entry_and_download_record():
    file_entry = generate.build_file_entry(
        "sys11",
        "1.0.0",
        "prod",
        "https://example.com/update.json",
        "deadbeef",
    )

    download_entry = generate.build_download_record(
        "sys11",
        "1.0.0",
        "prod",
        "https://example.com/update.json",
        42,
    )

    assert "download_count" not in file_entry
    assert download_entry["download_count"] == 42
    assert file_entry["sha256"] == "deadbeef"


def test_calculate_json_hash_unique():
    first = {"x": 1}
    second = {"x": 2}
    assert generate.calculate_json_hash(first) != generate.calculate_json_hash(second)


def test_fetch_update_json_crlf(monkeypatch):
    json_line = json.dumps({"foo": "bar"})

    class MockResponse:
        status_code = 200
        text = json_line + "\r\nEXTRA"

    monkeypatch.setattr(generate.requests, "get", lambda url: MockResponse())
    assert generate.fetch_update_json("http://example.com/update.json") == {"foo": "bar"}


def test_parse_release_versions_whitespace():
    body = (
        "Intro text\r\n"
        "##   VERSIONS   \r\n"
        "**Vector** :   `2.0`\r\n"
        "<!-- END VERSIONS SECTION -->\r\n"
    )
    assert generate.parse_release_versions(body) == {"vector": "2.0"}


def test_save_full_update_json_writes_file(monkeypatch, tmp_path):
    payload = b'{"update_file_format":"1.0"}\nfile.py{}QkFTRTY0\n'

    class MockResponse:
        status_code = 200
        content = payload

    monkeypatch.setattr(generate.requests, "get", lambda url: MockResponse())
    ok = generate.save_full_update_json(str(tmp_path), "http://example.com/update.json")
    assert ok is True
    with open(os.path.join(str(tmp_path), "update.json"), "rb") as f:
        assert f.read() == payload


def test_save_full_update_json_skips_on_failure(monkeypatch, tmp_path):
    class MockResponse:
        status_code = 404
        content = b""

    monkeypatch.setattr(generate.requests, "get", lambda url: MockResponse())
    ok = generate.save_full_update_json(str(tmp_path), "http://example.com/missing.json")
    assert ok is False
    assert not os.path.exists(os.path.join(str(tmp_path), "update.json"))


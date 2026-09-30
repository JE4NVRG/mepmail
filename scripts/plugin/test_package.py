"""Exercise package validation and adversarial archive inputs without network access."""

import copy
import io
import json
import unittest
import warnings
import zipfile

from jsonschema import ValidationError

from package import ROOT, read_source, validate, validate_zip, zip_bytes


class PackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = read_source(ROOT / "plugins/mepmail")

    def setUp(self):
        self.files = copy.deepcopy(self.source)

    def change(self, filename, edit):
        value = json.loads(self.files[filename])
        edit(value)
        self.files[filename] = json.dumps(value, ensure_ascii=False).encode()

    def reject(self):
        with self.assertRaises((ValueError, ValidationError)):
            validate(self.files)

    def test_real_package_and_deterministic_zip(self):
        data = zip_bytes(self.files)
        self.assertEqual(data, zip_bytes(self.files))
        self.assertEqual(validate_zip(data, self.files)["name"], "mepmail")

    def test_product_assets_do_not_serve_internal_provenance(self):
        public = ROOT / "apps/web/public/product"
        self.assertFalse((public / "README.md").exists())
        self.assertTrue((ROOT / "docs/gtm/product-screenshot-provenance.md").is_file())
        for name in ("templates-gallery.webp", "templates-hero.webp"):
            self.assertTrue((public / name).is_file())
        self.assertFalse(any("product/" in name for name in self.files))

    def test_missing_mcp_is_rejected(self):
        del self.files["mcp.json"]
        self.reject()

    def test_unexpected_file_is_rejected(self):
        self.files[".env"] = b"NOT_A_REAL_SECRET=fixture"
        self.reject()

    def test_schema_rejects_invented_scope_field(self):
        self.change("mcp.json", lambda x: x["mcpServers"]["mepmail"].update(scopes=["domains:read"]))
        self.reject()

    def test_auth_header_is_rejected(self):
        self.change("mcp.json", lambda x: x["mcpServers"]["mepmail"].update(headers={"Authorization": "fixture"}))
        self.reject()

    def test_other_endpoint_is_rejected(self):
        self.change("mcp.json", lambda x: x["mcpServers"]["mepmail"].update(url="https://example.org/mcp"))
        self.reject()

    def test_extra_server_is_rejected(self):
        self.change("mcp.json", lambda x: x["mcpServers"].update(other={"type": "streamable-http", "url": "https://example.org/mcp"}))
        self.reject()

    def test_traversal_asset_is_rejected(self):
        self.change("plugin.json", lambda x: x["extensions"]["com.openai"]["interface"].update(logo="./../icon.png"))
        self.reject()

    def test_missing_asset_is_rejected(self):
        self.change("plugin.json", lambda x: x["extensions"]["com.openai"]["interface"].update(logo="./assets/absent.png"))
        self.reject()

    def test_wrong_logo_is_rejected(self):
        self.files["assets/icon.png"] += b"tampered"
        self.reject()

    def test_oversized_subtitle_is_rejected(self):
        self.change("plugin.json", lambda x: x["extensions"]["com.openai"]["interface"].update(shortDescription="x" * 31))
        self.reject()

    def test_insecure_listing_url_is_rejected(self):
        self.change("plugin.json", lambda x: x["extensions"]["com.openai"]["interface"].update(supportURL="http://example.org"))
        self.reject()

    def test_hooks_are_rejected(self):
        self.change("plugin.json", lambda x: x["extensions"]["com.openai"].update(hooks="./hooks/hooks.json"))
        self.reject()

    def test_fake_video_is_rejected(self):
        self.change("plugin.json", lambda x: x["extensions"]["com.openai"]["review"].update(demo_recording_url="https://example.org/demo"))
        self.reject()

    def test_credentials_metadata_is_rejected(self):
        self.change("plugin.json", lambda x: x["extensions"]["com.openai"]["review"].update(test_credentials="fixture"))
        self.reject()

    def test_missing_execution_caveat_is_rejected(self):
        self.change("plugin.json", lambda x: x["extensions"]["com.openai"]["review"]["test_cases"]["positive"][0].update(description="Passed"))
        self.reject()

    def test_write_case_is_rejected(self):
        self.change("plugin.json", lambda x: x["extensions"]["com.openai"]["review"]["test_cases"]["positive"][0].update(tools_triggered="send_email"))
        self.reject()

    def test_license_change_is_rejected(self):
        self.files["LICENSE"] = b"MIT"
        self.reject()

    def test_duplicate_json_key_is_rejected(self):
        self.files["mcp.json"] = b'{"mcpServers": {}, "mcpServers": {}}'
        self.reject()

    def test_secret_like_content_is_rejected(self):
        self.files["README.md"] += ("\nBearer " + "a" * 30).encode()
        self.reject()

    def test_invalid_skill_header_is_rejected(self):
        self.files["skills/get-started/SKILL.md"] = b"Missing header"
        self.reject()

    def test_zip_duplicate_and_traversal_are_rejected(self):
        for name in ("plugin.json", "../escape", "/absolute", "C:/escape", "assets\\escape"):
            with self.subTest(name=name):
                data = io.BytesIO(zip_bytes(self.files))
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    with zipfile.ZipFile(data, "a") as archive:
                        archive.writestr(name, b"fixture")
                with self.assertRaises(ValueError):
                    validate_zip(data.getvalue())

    def test_zip_symlink_is_rejected(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            entry = zipfile.ZipInfo("plugin.json")
            entry.create_system = 3
            entry.external_attr = 0o120777 << 16
            archive.writestr(entry, "../outside")
        with self.assertRaisesRegex(ValueError, "symlink"):
            validate_zip(data.getvalue())

    def test_zip_source_parity_is_enforced(self):
        altered = copy.deepcopy(self.files)
        altered["README.md"] += b"\nChanged."
        with self.assertRaisesRegex(ValueError, "match validated source"):
            validate_zip(zip_bytes(altered), self.files)


if __name__ == "__main__":
    unittest.main(verbosity=2)

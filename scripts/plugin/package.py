"""Validate and package the MepMail portable plugin; no installation or publication."""

import argparse
import hashlib
import io
import json
import re
import struct
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = Path(__file__).parent / "schemas"
FILES = (
    "LICENSE",
    "NOTICE.md",
    "README.md",
    "assets/icon.png",
    "mcp.json",
    "plugin.json",
    "skills/get-started/SKILL.md",
    "skills/inspect-delivery/SKILL.md",
)
TOOLS = {
    "list_domains", "get_domain", "list_emails", "get_email",
    "get_email_insights", "get_deliverability", "get_usage",
}
ENDPOINT = "https://api-mepmail.je4ndev.com/mcp"
SECRET = re.compile(
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"
    r"\b(?:sk-proj-|sk_live_|whsec_)[A-Za-z0-9_-]{12,}|"
    r"\bBearer\s+[A-Za-z0-9._-]{20,}|\bms_[A-Za-z0-9]{24,}"
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


def https_url(value):
    require(isinstance(value, str), "URL must be a string")
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and bool(parsed.hostname), "HTTPS URL required")
    require(not parsed.username and not parsed.password and not parsed.query and not parsed.fragment,
            "URL must not contain credentials, query or fragment")


def package_path(value, files):
    require(isinstance(value, str) and value.startswith("./"), "Path must start with ./")
    relative = value[2:]
    require("\\" not in relative and ":" not in relative, "Invalid path separator")
    require(all(part not in ("", ".", "..") for part in relative.split("/")), "Unsafe path")
    require(relative in files, f"Missing packaged path: {relative}")
    return relative


def validate(files):
    require(set(files) == set(FILES), "Package differs from explicit file allowlist")
    for name, data in files.items():
        require(len(data) <= 5 * 1024 * 1024, f"Oversized file: {name}")
        if name != "assets/icon.png":
            require(not SECRET.search(data.decode("utf-8")), f"Credential-like content in {name}")
    manifest = load_json(files["plugin.json"])
    mcp = load_json(files["mcp.json"])
    for name, value in (("plugin", manifest), ("mcp", mcp)):
        schema = load_json((SCHEMAS / f"{name}.schema.json").read_bytes())
        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema).validate(value)
    require(manifest["name"] == "mepmail", "Unexpected plugin identity")
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", manifest["version"]), "Explicit version required")
    require(manifest["license"] == "AGPL-3.0-only", "Preserve AGPL")
    require(manifest["author"]["name"] == "JE4NDEV", "Unexpected publisher")
    require(manifest["author"]["email"] == "support@je4ndev.com", "Unexpected support contact")
    for value in (manifest["homepage"], manifest["repository"], manifest["author"]["url"]):
        https_url(value)
    require(mcp["mcpServers"] == {"mepmail": {"type": "streamable-http", "url": ENDPOINT}},
            "Exactly the existing HTTPS server, without headers or scope inventions, is required")
    require(set(manifest["extensions"]) == {"com.openai"}, "Unexpected extension")
    extension = manifest["extensions"]["com.openai"]
    require(set(extension) == {"interface", "onboardingSkill", "review", "publication"},
            "No hooks, app references or unrecognized extension fields")
    interface = extension["interface"]
    fields = {
        "displayName", "shortDescription", "longDescription", "developerName", "category",
        "capabilities", "websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL",
        "defaultPrompt", "composerIcon", "logo",
    }
    require(set(interface) == fields, "Unexpected listing fields")
    for name, limit in (("displayName", 30), ("shortDescription", 30),
                        ("longDescription", 4000), ("developerName", 80)):
        value = interface[name]
        require(isinstance(value, str) and 0 < len(value.strip()) <= limit, f"Invalid {name}")
        require(not any(ord(char) < 32 for char in value), f"Control character in {name}")
    require(interface["developerName"] == "JE4NDEV", "Unexpected listing publisher")
    require(interface["category"] == "Developer Tools", "Unexpected category")
    expected_urls = {"websiteURL": "", "supportURL": "/support",
                     "privacyPolicyURL": "/privacy", "termsOfServiceURL": "/terms"}
    for name, suffix in expected_urls.items():
        https_url(interface[name])
        require(interface[name] == "https://mepmail.je4ndev.com" + suffix, "Unexpected public URL")
    prompts = interface["defaultPrompt"]
    require(isinstance(prompts, list) and 1 <= len(prompts) <= 3, "One to three prompts required")
    require(len(set(prompts)) == len(prompts), "Duplicate prompts")
    require(all(isinstance(p, str) and 0 < len(p) <= 128 for p in prompts), "Invalid prompts")
    require(interface["capabilities"] == ["Read sending domains", "Read email delivery"],
            "Unexpected capabilities")
    for name in ("composerIcon", "logo"):
        require(package_path(interface[name], files) == "assets/icon.png", "Unexpected asset")
    image = files["assets/icon.png"]
    require(image[:8] == b"\x89PNG\r\n\x1a\n" and image[12:16] == b"IHDR", "PNG required")
    width, height = struct.unpack(">II", image[16:24])
    require(width == height and 48 <= width <= 4096, "Square icon, 48..4096 pixels required")
    require(image == (ROOT / "apps/web/public/logo/mepmail-logo-400.png").read_bytes(),
            "Icon must match existing original branding")
    for name in ("LICENSE", "NOTICE.md"):
        require(files[name] == (ROOT / name).read_bytes(), "License/notice provenance mismatch")
    require(package_path(extension["onboardingSkill"], files) == "skills/get-started/SKILL.md",
            "Unexpected onboarding path")
    for name in ("get-started", "inspect-delivery"):
        text = files[f"skills/{name}/SKILL.md"].decode()
        require(re.match(r"---\nname: " + name + r"\ndescription: [^\n]+\n---\n", text),
                "Skill frontmatter must declare matching name and description")
    review = extension["review"]
    require(set(review) == {"test_cases", "commerce", "commerce_description"},
            "No credentials, reviewer instructions or invented recording")
    require(review["commerce"] is False, "No commerce in this package")
    cases = review["test_cases"]
    require(set(cases) == {"positive", "negative"}, "Unexpected case groups")
    require(len(cases["positive"]) == 5 and len(cases["negative"]) == 3, "Expected 5/3 prepared cases")
    for case in cases["positive"] + cases["negative"]:
        require(case["description"].startswith("Prepared, not executed:"), "Do not fabricate execution")
        require(isinstance(case["prompt"], str) and case["prompt"].strip(), "Prompt required")
    for case in cases["positive"]:
        require(set(case) == {"description", "prompt", "tools_triggered", "expected_behavior"},
                "Unexpected positive case fields")
        require(set(case["tools_triggered"].split(", ")) <= TOOLS, "Only known read tools allowed")
        require(bool(case["expected_behavior"].strip()), "Expected behavior required")
    for case in cases["negative"]:
        require(set(case) == {"description", "prompt"}, "Unexpected negative case fields")
    publication = extension["publication"]
    require(set(publication) == {"release_notes", "translations"}, "No inferred country policy")
    require("NOT executed" in publication["release_notes"], "Execution caveat required")
    require(set(publication["translations"]) == {"pt-BR"}, "PT listing required")
    translation = publication["translations"]["pt-BR"]
    require(set(translation) == {"subtitle", "description"}, "Unexpected translation fields")
    require(0 < len(translation["subtitle"]) <= 30 and 0 < len(translation["description"]) <= 4000,
            "Translation limits exceeded")
    return manifest


def read_source(source):
    source = Path(source)
    require(not source.is_symlink(), "Symlink source not allowed")
    files = {}
    for path in source.rglob("*"):
        require(not path.is_symlink(), f"Symlink not allowed: {path.name}")
        if path.is_file():
            files[path.relative_to(source).as_posix()] = path.read_bytes()
    validate(files)
    return files


def zip_bytes(files):
    validate(files)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[name])
    return output.getvalue()


def validate_zip(data, expected=None):
    files = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        require(len(archive.infolist()) <= len(FILES) + 1, "Too many ZIP entries")
        for entry in archive.infolist():
            name = entry.filename
            require(name not in files, "Duplicate ZIP entry")
            require(not PurePosixPath(name).is_absolute() and "\\" not in name
                    and ":" not in name and all(p not in ("", ".", "..") for p in name.split("/")),
                    "Unsafe ZIP path")
            require((entry.external_attr >> 16) & 0o170000 != 0o120000, "ZIP symlink")
            require(entry.file_size <= 5 * 1024 * 1024, "Oversized ZIP entry")
            files[name] = archive.read(entry)
        require(archive.testzip() is None, "ZIP CRC error")
    manifest = validate(files)
    if expected is not None:
        require(files == expected, "ZIP bytes do not match validated source")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "plugins/mepmail")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.resolve().is_relative_to(args.source.resolve()), "Output must be outside source")
    files = read_source(args.source)
    data = zip_bytes(files)
    manifest = validate_zip(data, files)
    require(data == zip_bytes(files), "Non-deterministic ZIP")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        require(args.output.read_bytes() == data, "Refusing to overwrite a different artifact")
    else:
        args.output.write_bytes(data)
    validate_zip(args.output.read_bytes(), files)
    print(json.dumps({"result": "PASS", "version": manifest["version"],
                      "files": len(files), "bytes": len(data),
                      "sha256": hashlib.sha256(data).hexdigest(),
                      "output": str(args.output), "chatgpt_e2e": "NOT EXECUTED",
                      "portal": "NOT SUBMITTED"}, indent=2))


if __name__ == "__main__":
    main()

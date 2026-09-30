import hashlib
import importlib.util
import io
import os
import subprocess
import tarfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('release_context', Path(__file__).with_name('release-context.py'))
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def read_member(archive, name):
    stream = archive.extractfile(name)
    assert stream is not None
    return stream.read()


class ReleaseContextTest(unittest.TestCase):
    def test_excludes_private_and_development_material(self):
        for name in ['.git/config', '.env.example', 'docs/gtm/private.md', 'specs/rollout.md',
                     'apps/web/AGENTS.md', 'apps/web/.env.local', 'packages/ses/test/fixtures/key.pem',
                     'apps/web/src/foo.test.ts', 'apps/web/node_modules/foo/index.js',
                     'apps/web/.next/server.js', 'scripts/plugin/README.md']:
            with self.subTest(name=name):
                self.assertFalse(module.included(name))

    def test_preserves_source_licenses_migrations_and_build_requirements(self):
        for name in ['Dockerfile', 'LICENSE', 'NOTICE.md', 'pnpm-lock.yaml',
                     'apps/web/src/app/source/route.ts', 'apps/docs/content/docs/billing.mdx',
                     'packages/mcp/LICENSE', 'packages/db/drizzle/0043_billing_terms.sql',
                     'packages/db/drizzle/meta/_journal.json', 'scripts/start.mjs']:
            with self.subTest(name=name):
                self.assertTrue(module.included(name))

    def test_source_policy_preserves_reviewed_installation_only(self):
        for name in ['docker-compose.yml', 'docker-compose.prebuilt.yml',
                     'deploy/docker-compose.yml', 'infra/mepmail-ses.cfn.yaml',
                     '.env.example', 'SELF_HOSTING.md']:
            with self.subTest(name=name):
                self.assertTrue(module.source_included(name))
                self.assertFalse(module.included(name))

    def test_both_archives_exclude_private_siblings_and_real_environments(self):
        forbidden = ['.env', '.env.local', '.env.production', '.env.example.bak',
                     'apps/web/.env.example', 'deploy/.env', 'deploy/secrets.json',
                     'infra/private.yaml', 'docs/gtm/private.md', 'specs/release.md',
                     '.git/config', 'apps/web/test/fixtures/credentials.json',
                     'apps/web/src/foo.test.ts', 'apps/web/AGENTS.md']
        raw = module.archive([(name, b'PRIVATE_SENTINEL', 0o600) for name in forbidden]
                             + [('LICENSE', b'public', 0o644)])
        context, _receipt = module.build_context(raw, 'a' * 40)
        with tarfile.open(fileobj=io.BytesIO(context)) as outer:
            source = read_member(outer, 'source.tar.gz')
            with tarfile.open(fileobj=io.BytesIO(source)) as inner:
                for name in forbidden:
                    with self.subTest(name=name):
                        self.assertFalse(module.source_included(name))
                        self.assertNotIn(name, outer.getnames())
                        self.assertNotIn(name, inner.getnames())
                for member in inner:
                    self.assertNotIn(b'PRIVATE_SENTINEL', read_member(inner, member))

    def test_real_git_archive_installation_closure_and_byte_parity(self):
        snapshot = os.environ.get('RELEASE_CONTEXT_GIT_ARCHIVE')
        raw = (Path(snapshot).read_bytes() if snapshot else subprocess.check_output(
            ['git', 'archive', 'HEAD'], cwd=Path(__file__).resolve().parents[1]))
        context, receipt = module.build_context(raw, 'a' * 40)
        self.assertEqual((context, receipt), module.build_context(raw, 'a' * 40))
        with tarfile.open(fileobj=io.BytesIO(raw)) as original:
            expected = {m.name: read_member(original, m)
                        for m in original if m.isfile()}
        with tarfile.open(fileobj=io.BytesIO(context)) as outer:
            packed = read_member(outer, 'source.tar.gz')
            self.assertEqual(hashlib.sha256(packed).hexdigest(), receipt['source_sha256'])
            with tarfile.open(fileobj=io.BytesIO(packed)) as source:
                files = {m.name: read_member(source, m) for m in source if m.isfile()}
        required = ['docker-compose.yml', 'docker-compose.prebuilt.yml',
                    'deploy/docker-compose.yml', 'infra/mepmail-ses.cfn.yaml',
                    '.env.example', 'SELF_HOSTING.md', 'Dockerfile', '.dockerignore',
                    'LICENSE', 'NOTICE.md', 'package.json', 'pnpm-lock.yaml',
                    'pnpm-workspace.yaml', 'scripts/start.mjs',
                    'scripts/backup/Dockerfile', 'scripts/backup/backup.sh',
                    'scripts/backup/entrypoint.sh', 'apps/web/src/lib/aws-setup-script.ts',
                    'apps/docs/content/docs/self-hosting.mdx']
        for name in required:
            with self.subTest(name=name):
                self.assertIn(name, files)
        for name, data in files.items():
            with self.subTest(name=name):
                self.assertEqual(hashlib.sha256(data).hexdigest(), receipt['source_manifest'][name])
                if name != 'SOURCE-REVISION':
                    self.assertEqual(data, expected[name])
        self.assertIn(b'build: scripts/backup', files['docker-compose.yml'])
        self.assertIn(b'infra/mepmail-ses.cfn.yaml', files['apps/web/src/lib/aws-setup-script.ts'])
        self.assertIn(b'cp .env.example .env', files['SELF_HOSTING.md'])
        template = dict(line.split('=', 1) for line in files['.env.example'].decode().splitlines()
                        if line and not line.startswith('#') and '=' in line)
        for key in ['MASTER_ENCRYPTION_KEY', 'BETTER_AUTH_SECRET', 'AWS_ACCESS_KEY_ID',
                    'AWS_SECRET_ACCESS_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
                    'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'GOOGLE_CLIENT_SECRET',
                    'GITHUB_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY',
                    'ABUSE_JUDGE_API_KEY']:
            with self.subTest(template_key=key):
                self.assertEqual(template[key], '')

    def test_archive_is_deterministic_and_preserves_modes(self):
        entries = [('LICENSE', b'license', 0o644), ('start.sh', b'run', 0o755)]
        data = module.archive(entries)
        self.assertEqual(data, module.archive(entries))
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            self.assertEqual(archive.getmember('start.sh').mode, 0o755)
            self.assertEqual(archive.getmember('LICENSE').mtime, 0)


if __name__ == '__main__':
    unittest.main()

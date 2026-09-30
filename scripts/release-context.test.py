import importlib.util
import io
import tarfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('release_context', Path(__file__).with_name('release-context.py'))
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


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

    def test_archive_is_deterministic_and_preserves_modes(self):
        entries = [('LICENSE', b'license', 0o644), ('start.sh', b'run', 0o755)]
        data = module.archive(entries)
        self.assertEqual(data, module.archive(entries))
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            self.assertEqual(archive.getmember('start.sh').mode, 0o755)
            self.assertEqual(archive.getmember('LICENSE').mtime, 0)


if __name__ == '__main__':
    unittest.main()

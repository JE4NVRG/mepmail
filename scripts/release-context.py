"""Create a filtered Docker context and its corresponding-source archive from Git."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

ROOT_FILES = {
    'Dockerfile', '.dockerignore', 'LICENSE', 'NOTICE.md', 'package.json',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'turbo.json', 'biome.json',
}


def included(name):
    path = PurePosixPath(name)
    if name in ROOT_FILES:
        return True
    if path.parts[0] not in ('apps', 'packages', 'scripts'):
        return False
    if any(part in ('test', 'tests', 'test-support', 'fixtures', 'node_modules', '.git', '.next', '.source', '__pycache__') for part in path.parts):
        return False
    if any(part.startswith('.env') for part in path.parts):
        return False
    if '.test.' in name or name.endswith(('.tsbuildinfo', '.log')):
        return False
    if path.name in ('AGENTS.md', 'CLAUDE.md', 'DESIGN.md'):
        return False
    if path.suffix == '.md' and not name.startswith('apps/docs/content/'):
        return False
    if name.startswith(('scripts/plugin/', 'packages/cli/scripts/preview/')):
        return False
    return True


def archive(entries):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as output:
        for name, data, mode in entries:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = mode
            member.mtime = 0
            output.addfile(member, io.BytesIO(data))
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    revision = subprocess.check_output(['git', 'rev-parse', args.revision], cwd=root, text=True).strip()
    raw = subprocess.check_output(['git', 'archive', revision], cwd=root)
    entries = []
    with tarfile.open(fileobj=io.BytesIO(raw)) as source:
        for item in source:
            if not item.isfile() or not included(item.name):
                continue
            stream = source.extractfile(item)
            assert stream is not None
            entries.append((item.name, stream.read(), item.mode))
    entries.sort()
    entries.append(('SOURCE-REVISION', (revision+'\n').encode(), 0o644))
    source = gzip.compress(archive(entries), mtime=0)
    entries.append(('source.tar.gz', source, 0o644))
    context = archive(entries)
    output = Path(args.output)
    if output.exists():
        raise SystemExit('Output already exists; refusing to overwrite')
    output.write_bytes(context)
    receipt = {'revision': revision, 'context_sha256': hashlib.sha256(context).hexdigest(),
               'source_sha256': hashlib.sha256(source).hexdigest(), 'context_bytes': len(context),
               'included_files': len(entries), 'paths': [e[0] for e in entries]}
    output.with_suffix('.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps({k: v for k, v in receipt.items() if k != 'paths'}))


if __name__ == '__main__':
    main()

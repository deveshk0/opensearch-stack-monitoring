"""Publish a checked main build with SemVer metadata and a checksum (stdlib + gh)."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile


VERSION = re.compile(r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')
PREFIX = 'opensearch-dashboards/stackMonitoring/'


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()


def plan(root):
    tags = [tag for tag in git(root, 'tag', '--list', 'v*').splitlines() if VERSION.fullmatch(tag)]
    if not tags:
        return 'v1.0.0', None
    previous = max(tags, key=lambda tag: tuple(map(int, VERSION.fullmatch(tag).groups())))
    head = git(root, 'rev-parse', 'HEAD')
    released = git(root, 'rev-list', '-n', '1', previous)
    if head == released:
        return previous, None
    if subprocess.run(['git', 'merge-base', '--is-ancestor', head, released], cwd=root).returncode == 0:
        return None, None  # A newer checked commit has already been released.
    if subprocess.run(['git', 'merge-base', '--is-ancestor', released, head], cwd=root).returncode != 0:
        raise RuntimeError('Release history diverged from main; reconcile tags before publishing.')
    messages = git(root, 'log', f'{previous}..HEAD', '--format=%B%x00').split('\0')
    headers = [msg.strip().splitlines()[0] for msg in messages if msg.strip()]
    major, minor, patch = map(int, VERSION.fullmatch(previous).groups())
    if (any(re.match(r'^[a-z]+(?:\([^\n]+\))?!: ', header) for header in headers)
            or any(re.search(r'^BREAKING[ -]CHANGE: ', msg, re.M) for msg in messages)):
        version = (major + 1, 0, 0)
    elif any(re.match(r'^feat(?:\([^\n]+\))?: ', header) for header in headers):
        version = (major, minor + 1, 0)
    else:
        version = (major, minor, patch + 1)
    return 'v' + '.'.join(map(str, version)), previous


def prepare_archive(path, tag):
    if not VERSION.fullmatch(tag):
        raise ValueError('Invalid release version')
    replacement = path.with_suffix('.release.zip')
    with zipfile.ZipFile(path) as source:
        manifest = json.loads(source.read(PREFIX + 'opensearch_dashboards.json'))
        if manifest['id'] != 'stackMonitoring' or manifest['opensearchDashboardsVersion'] != '3.9.0':
            raise ValueError('Unexpected plugin identity or host compatibility')
        for required in ('package.json', 'LICENSE', 'NOTICE'):
            source.getinfo(PREFIX + required)
        with zipfile.ZipFile(replacement, 'w') as output:
            for info in source.infolist():
                data = source.read(info.filename)
                if info.filename in (PREFIX + 'package.json', PREFIX + 'opensearch_dashboards.json'):
                    metadata = json.loads(data)
                    metadata['version'] = tag[1:]
                    data = (json.dumps(metadata, indent=2) + '\n').encode()
                output.writestr(info, data)
    with zipfile.ZipFile(replacement) as output:
        if output.testzip() is not None:
            raise ValueError('Corrupt release archive')
    replacement.replace(path)
    path.with_name('SHA256SUMS').write_text(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n')


def publish(root):
    tag, previous = plan(root)
    if tag is None:
        print('A newer commit is already released; skipping this old run.')
        return
    head = git(root, 'rev-parse', 'HEAD')
    existing = subprocess.run(['gh', 'release', 'view', tag, '--json', 'isDraft,targetCommitish,url'],
                              cwd=root, text=True, capture_output=True)
    if existing.returncode == 0:
        release = json.loads(existing.stdout)
        if not release['isDraft']:
            print('Already published: ' + release['url'])
            return
        if release['targetCommitish'] != head:
            raise RuntimeError('An unfinished draft targets another commit. Retry that run before publishing this one.')
    elif existing.returncode != 1 or 'release not found' not in existing.stderr.lower():
        raise RuntimeError('Cannot check existing release: ' + existing.stderr)
    archive = root / 'artifacts/stack-monitoring.zip'
    prepare_archive(archive, tag)
    notes = root / 'artifacts/release-notes.md'
    notes.write_text(f'''Stack Monitoring {tag} for **OpenSearch Dashboards 3.9.0 only**.

Download `stack-monitoring.zip` and verify it against `SHA256SUMS` before installing.
See [installation and upgrades](https://github.com/deveshk0/opensearch-stack-monitoring/blob/{tag}/docs/installation.md) for provisioning, roles, TLS, and collector configuration.

One attached cluster and one collecting Dashboards instance are supported. Validate your workload in staging; this release does not imply HA or production certification.

Built and checked from commit `{head}`. Plugin version and host compatibility are independent.
''')
    assets = [str(archive), str(archive.with_name('SHA256SUMS'))]
    if existing.returncode != 0:
        args = ['gh', 'release', 'create', tag, '--draft', '--target', head,
                '--title', f'Stack Monitoring {tag}', '--generate-notes', '--notes-file', str(notes)]
        if previous:
            args += ['--notes-start-tag', previous]
        subprocess.run(args, cwd=root, check=True)
    subprocess.run(['gh', 'release', 'upload', tag, *assets, '--clobber'], cwd=root, check=True)
    subprocess.run(['gh', 'release', 'edit', tag, '--draft=false', '--latest'], cwd=root, check=True)
    print('Published ' + tag)


if __name__ == '__main__':
    publish(Path(__file__).resolve().parents[1])

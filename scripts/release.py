"""Publish a checked main build with SemVer metadata and a checksum (stdlib + gh)."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile


VERSION = re.compile(r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')
PREFIX = 'opensearch-dashboards/stackMonitoring/'
HOST_VERSIONS = ('3.7.0', '3.8.0', '3.9.0', '3.10.0')


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


def validate_archive(path, host):
    with zipfile.ZipFile(path) as source:
        if len(source.namelist()) != len(set(source.namelist())):
            raise ValueError('Duplicate entries in release archive: ' + path.name)
        manifest = json.loads(source.read(PREFIX + 'opensearch_dashboards.json'))
        if manifest['id'] != 'stackMonitoring' or manifest['opensearchDashboardsVersion'] != host:
            raise ValueError('Unexpected plugin identity or host compatibility: ' + path.name)
        package = json.loads(source.read(PREFIX + 'package.json'))
        if package['name'] != 'stackMonitoring':
            raise ValueError('Unexpected package identity: ' + path.name)
        for required in ('LICENSE', 'NOTICE'):
            source.getinfo(PREFIX + required)
        if source.testzip() is not None:
            raise ValueError('Corrupt release archive: ' + path.name)


def prepare_archive(path, tag, host):
    if not VERSION.fullmatch(tag):
        raise ValueError('Invalid release version')
    validate_archive(path, host)
    replacement = path.with_suffix('.release.zip')
    with zipfile.ZipFile(path) as source:
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


def prepare_archives(directory, tag):
    archives = [(directory / f'stack-monitoring-{host}.zip', host) for host in HOST_VERSIONS]
    generic = directory / 'stack-monitoring.zip'
    archives.append((generic, '3.9.0'))
    if set(directory.glob('stack-monitoring*.zip')) != {path for path, _ in archives}:
        raise ValueError('Release requires exactly the four versioned host archives and stack-monitoring.zip.')
    # Validate every build before stamping any archive or creating a remote draft.
    for path, host in archives:
        validate_archive(path, host)
    if generic.read_bytes() != (directory / 'stack-monitoring-3.9.0.zip').read_bytes():
        raise ValueError('Generic archive must match the checked 3.9.0 build.')
    for path, host in archives:
        prepare_archive(path, tag, host)
    checksum = directory / 'SHA256SUMS'
    checksum.write_text(''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n'
                                for path, _ in archives))
    return [path for path, _ in archives] + [checksum]


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
    assets = prepare_archives(root / 'artifacts', tag)
    notes = root / 'artifacts/release-notes.md'
    download = f'https://github.com/deveshk0/opensearch-stack-monitoring/releases/download/{tag}'
    compatibility = '\n'.join(
        f'| {host} | {host} | [stack-monitoring-{host}.zip]({download}/stack-monitoring-{host}.zip) |'
        for host in HOST_VERSIONS)
    notes.write_text(f'''Stack Monitoring {tag} adds first-run setup from the Stack Monitoring UI and version-specific builds for the following matched hosts.

| OpenSearch | OpenSearch Dashboards | Download |
| --- | --- | --- |
{compatibility}

Choose the ZIP matching your host version and verify it against [SHA256SUMS]({download}/SHA256SUMS) before installing. [stack-monitoring.zip]({download}/stack-monitoring.zip) is the same build as the 3.9.0 archive for existing installation links.

For first-run setup, open Stack Monitoring as an administrator and use the setup control to provision monitoring resources and a collector identity. See [installation and upgrades](https://github.com/deveshk0/opensearch-stack-monitoring/blob/{tag}/docs/installation.md) for permissions, TLS, persistent collector credentials, and existing deployments.

One attached cluster and one collecting Dashboards instance are supported. Validate your workload in staging; this release does not imply HA or production certification.

Built and checked from commit `{head}`. Plugin version and host compatibility are independent.
''')
    if existing.returncode != 0:
        args = ['gh', 'release', 'create', tag, '--draft', '--target', head,
                '--title', f'Stack Monitoring {tag}', '--generate-notes', '--notes-file', str(notes)]
        if previous:
            args += ['--notes-start-tag', previous]
        subprocess.run(args, cwd=root, check=True)
    subprocess.run(['gh', 'release', 'upload', tag, *map(str, assets), '--clobber'], cwd=root, check=True)
    subprocess.run(['gh', 'release', 'edit', tag, '--draft=false', '--latest'], cwd=root, check=True)
    print('Published ' + tag)


if __name__ == '__main__':
    publish(Path(__file__).resolve().parents[1])

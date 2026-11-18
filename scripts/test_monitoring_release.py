"""Release planning and archive integrity, without publishing anything."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from release import HOST_VERSIONS, plan, prepare_archive, prepare_archives, publish


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        self.commit('feat: initial plugin')

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, text=True).strip()

    def commit(self, message):
        self.git('commit', '--allow-empty', '-qm', message)

    def test_first_release(self):
        self.assertEqual(plan(self.root), ('v1.0.0', None))

    def test_release_matrix_matches_build_and_ci(self):
        root = Path(__file__).resolve().parent.parent
        workflow = (root / '.github/workflows/ci.yml').read_text()
        ci_versions = json.loads(re.search(r'osd:\s*(\[[^\]]+\])', workflow).group(1))
        build_versions = re.findall(r'^\s+(\d+\.\d+\.\d+)\)',
                                    (root / 'scripts/host-version.sh').read_text(), re.M)
        self.assertEqual(tuple(ci_versions), HOST_VERSIONS)
        self.assertEqual(tuple(build_versions), HOST_VERSIONS)

    def test_semantic_changes_and_default_patch(self):
        cases = [('fix: repair', '1.2.4'), ('docs: explain install', '1.2.4'),
                 ('feat(nodes): add chart', '1.3.0'), ('refactor!: change API', '2.0.0'),
                 ('fix(api): change\n\nBREAKING CHANGE: incompatible', '2.0.0'),
                 ('fix: change\n\nBREAKING-CHANGE: incompatible', '2.0.0'),
                 ('docs: examples\n\nfeat: an example, not the header', '1.2.4')]
        self.git('tag', 'v1.2.3')
        for message, expected in cases:
            with self.subTest(message=message):
                self.git('reset', '--hard', 'v1.2.3')
                self.commit(message)
                self.assertEqual(plan(self.root), ('v' + expected, 'v1.2.3'))

    def test_setup_feature_after_patch_release_is_minor(self):
        self.git('tag', 'v1.0.1')
        self.commit('feat: add one-click setup and broader host compatibility')
        self.assertEqual(plan(self.root), ('v1.1.0', 'v1.0.1'))

    def test_largest_change_wins_and_numeric_order(self):
        self.git('tag', 'v1.9.0')
        self.commit('fix: repair')
        self.git('tag', 'v1.10.0')
        self.commit('feat: chart')
        self.commit('docs: guide')
        self.assertEqual(plan(self.root), ('v1.11.0', 'v1.10.0'))

    def test_retry_uses_same_tag(self):
        self.git('tag', 'v1.0.0')
        self.assertEqual(plan(self.root), ('v1.0.0', None))

    def test_old_run_cannot_publish_after_newer_release(self):
        old = self.git('rev-parse', 'HEAD')
        self.commit('fix: newer')
        self.git('tag', 'v1.0.1')
        self.git('checkout', '-q', old)
        self.assertEqual(plan(self.root), (None, None))

    def test_unrelated_release_history_fails(self):
        self.git('tag', 'v1.0.0')
        self.git('checkout', '--orphan', 'unrelated')
        self.commit('feat: unrelated')
        with self.assertRaisesRegex(RuntimeError, 'diverged'):
            plan(self.root)

    def archive(self, host='3.9.0', path=None):
        path = path or self.root / 'stack-monitoring.zip'
        prefix = 'opensearch-dashboards/stackMonitoring/'
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(prefix + 'opensearch_dashboards.json', json.dumps({
                'id': 'stackMonitoring', 'version': '1.0.0', 'opensearchDashboardsVersion': host}))
            archive.writestr(prefix + 'package.json', '{"name":"stackMonitoring","version":"1.0.0"}')
            archive.writestr(prefix + 'public/plugin.js', b'unchanged compiled code')
            archive.writestr(prefix + 'LICENSE', b'license')
            archive.writestr(prefix + 'NOTICE', b'notice')
        return path, prefix

    def test_archive_version_checksum_and_payload_preserved(self):
        path, prefix = self.archive()
        before = path.read_bytes()
        prepare_archive(path, 'v1.2.3', '3.9.0')
        self.assertNotEqual(before, path.read_bytes())
        with zipfile.ZipFile(path) as archive:
            self.assertIsNone(archive.testzip())
            for name in ['package.json', 'opensearch_dashboards.json']:
                self.assertEqual(json.loads(archive.read(prefix + name))['version'], '1.2.3')
            self.assertEqual(archive.read(prefix + 'public/plugin.js'), b'unchanged compiled code')
            self.assertEqual(archive.read(prefix + 'LICENSE'), b'license')
        self.assertFalse(path.with_name('SHA256SUMS').exists())

    def test_wrong_host_rejected_without_changing_archive(self):
        path, _ = self.archive('3.8.0')
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'compatibility'):
            prepare_archive(path, 'v1.2.3', '3.9.0')
        self.assertEqual(before, path.read_bytes())

    def archives(self):
        directory = self.root / 'artifacts'
        directory.mkdir(exist_ok=True)
        for host in HOST_VERSIONS:
            self.archive(host, directory / f'stack-monitoring-{host}.zip')
        (directory / 'stack-monitoring.zip').write_bytes(
            (directory / 'stack-monitoring-3.9.0.zip').read_bytes())
        return directory

    def test_all_host_archives_one_checksum_and_unchanged_payloads(self):
        directory = self.archives()
        assets = prepare_archives(directory, 'v1.1.0')
        self.assertEqual(len(assets), 6)
        for path in assets[:-1]:
            host = '3.9.0' if path.name == 'stack-monitoring.zip' else path.stem.removeprefix('stack-monitoring-')
            with zipfile.ZipFile(path) as archive:
                prefix = 'opensearch-dashboards/stackMonitoring/'
                manifest = json.loads(archive.read(prefix + 'opensearch_dashboards.json'))
                self.assertEqual(manifest['opensearchDashboardsVersion'], host)
                self.assertEqual(manifest['version'], '1.1.0')
                self.assertEqual(json.loads(archive.read(prefix + 'package.json'))['version'], '1.1.0')
                self.assertEqual(archive.read(prefix + 'public/plugin.js'), b'unchanged compiled code')
        self.assertEqual(assets[-1].name, 'SHA256SUMS')
        self.assertEqual(assets[-1].read_text(), ''.join(
            hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n'
            for path in assets[:-1]))
        self.assertEqual((directory / 'stack-monitoring.zip').read_bytes(),
                         (directory / 'stack-monitoring-3.9.0.zip').read_bytes())

    def test_incomplete_or_ambiguous_builds_cannot_create_a_draft(self):
        for fault in ('missing', 'mismatch', 'duplicate-entry', 'extra-archive', 'generic-differs'):
            with self.subTest(fault=fault):
                directory = self.archives()
                bad = directory / 'stack-monitoring-3.10.0.zip'
                if fault == 'missing':
                    bad.unlink()
                elif fault == 'mismatch':
                    self.archive('3.9.0', bad)
                elif fault == 'duplicate-entry':
                    with zipfile.ZipFile(bad, 'a') as archive:
                        archive.writestr('duplicate.js', b'first')
                        with self.assertWarns(UserWarning):
                            archive.writestr('duplicate.js', b'second')
                elif fault == 'extra-archive':
                    self.archive('3.10.0', directory / 'stack-monitoring-copy.zip')
                else:
                    with zipfile.ZipFile(directory / 'stack-monitoring.zip', 'a') as archive:
                        archive.writestr('different.js', b'different code')
                before = {p.name: p.read_bytes() for p in directory.glob('*.zip')}
                calls = []
                def run(args, **kwargs):
                    calls.append(args)
                    return subprocess.CompletedProcess(args, 1, '', 'release not found')
                with patch('release.plan', return_value=('v1.1.0', 'v1.0.1')), patch('release.git', return_value='checked-sha'), patch('release.subprocess.run', side_effect=run):
                    with self.assertRaises((ValueError, FileNotFoundError)):
                        publish(self.root)
                self.assertFalse(any(call[:3] == ['gh', 'release', 'create'] for call in calls))
                self.assertEqual(before, {p.name: p.read_bytes() for p in directory.glob('*.zip')})
                for path in directory.iterdir():
                    path.unlink()

    def publish_with(self, view, fail_upload=False):
        self.archives()
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if args[:3] == ['gh', 'release', 'view']:
                return view
            if fail_upload and args[:3] == ['gh', 'release', 'upload']:
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0)

        with patch('release.plan', return_value=('v1.0.0', None)), patch('release.subprocess.run', side_effect=run), patch('release.git', return_value='checked-sha'):
            publish(self.root)
        return calls

    def test_upload_before_publish_and_exact_target(self):
        calls = self.publish_with(subprocess.CompletedProcess([], 1, '', 'release not found'))
        self.assertEqual([call[2] for call in calls], ['view', 'create', 'upload', 'edit'])
        self.assertIn('--draft', calls[1])
        self.assertEqual(calls[1][calls[1].index('--target') + 1], 'checked-sha')
        self.assertIn('--draft=false', calls[-1])
        self.assertEqual(len(calls[2][4:-1]), 6)
        notes = (self.root / 'artifacts/release-notes.md').read_text()
        for host in HOST_VERSIONS:
            self.assertIn(f'/releases/download/v1.0.0/stack-monitoring-{host}.zip', notes)
        self.assertIn('first-run', notes)

    def test_published_release_is_not_modified(self):
        calls = self.publish_with(subprocess.CompletedProcess([], 0, json.dumps({
            'isDraft': False, 'url': 'release-url', 'targetCommitish': 'checked-sha'})))
        self.assertEqual(len(calls), 1)

    def test_draft_retry_uploads_before_publish(self):
        calls = self.publish_with(subprocess.CompletedProcess([], 0, json.dumps({
            'isDraft': True, 'targetCommitish': 'checked-sha'})))
        self.assertEqual([call[2] for call in calls], ['view', 'upload', 'edit'])

    def test_draft_for_other_commit_is_not_overwritten(self):
        with self.assertRaisesRegex(RuntimeError, 'another commit'):
            self.publish_with(subprocess.CompletedProcess([], 0, json.dumps({
                'isDraft': True, 'targetCommitish': 'another-sha'})))

    def test_permission_failure_does_not_create_release(self):
        with self.assertRaisesRegex(RuntimeError, 'Cannot check'):
            self.publish_with(subprocess.CompletedProcess([], 1, '', 'HTTP 403'))

    def test_upload_failure_does_not_publish(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.publish_with(subprocess.CompletedProcess([], 1, '', 'release not found'), fail_upload=True)


if __name__ == '__main__':
    unittest.main()

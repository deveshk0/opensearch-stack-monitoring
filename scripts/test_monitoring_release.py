"""Release planning and archive integrity, without publishing anything."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from release import plan, prepare_archive, publish


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

    def archive(self, host='3.9.0'):
        path = self.root / 'stack-monitoring.zip'
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
        prepare_archive(path, 'v1.2.3')
        self.assertNotEqual(before, path.read_bytes())
        with zipfile.ZipFile(path) as archive:
            self.assertIsNone(archive.testzip())
            for name in ['package.json', 'opensearch_dashboards.json']:
                self.assertEqual(json.loads(archive.read(prefix + name))['version'], '1.2.3')
            self.assertEqual(archive.read(prefix + 'public/plugin.js'), b'unchanged compiled code')
            self.assertEqual(archive.read(prefix + 'LICENSE'), b'license')
        self.assertEqual(path.with_name('SHA256SUMS').read_text(),
                         hashlib.sha256(path.read_bytes()).hexdigest() + '  stack-monitoring.zip\n')

    def test_wrong_host_rejected_without_changing_archive(self):
        path, _ = self.archive('3.8.0')
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'compatibility'):
            prepare_archive(path, 'v1.2.3')
        self.assertEqual(before, path.read_bytes())

    def publish_with(self, view, fail_upload=False):
        path, _ = self.archive()
        (self.root / 'artifacts').mkdir()
        path.rename(self.root / 'artifacts/stack-monitoring.zip')
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

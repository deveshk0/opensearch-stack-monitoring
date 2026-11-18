"""Reject wrong or corrupted public release inputs before Docker is touched."""
import hashlib
import base64
from types import SimpleNamespace
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
import zipfile

upgrade = runpy.run_path(str(Path(__file__).with_name('check-release-upgrade.py')))
verify = upgrade['verify_release']


class UpgradeArchiveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'stack-monitoring.zip'
        self.archive()

    def archive(self, host='3.9.0', version='1.0.1'):
        prefix = 'opensearch-dashboards/stackMonitoring/'
        with zipfile.ZipFile(self.path, 'w') as archive:
            archive.writestr(prefix + 'opensearch_dashboards.json', json.dumps({
                'id': 'stackMonitoring', 'version': version, 'opensearchDashboardsVersion': host}))
            archive.writestr(prefix + 'package.json', json.dumps({'name': 'stackMonitoring', 'version': version}))
            archive.writestr(prefix + 'LICENSE', 'fixture')
            archive.writestr(prefix + 'NOTICE', 'fixture')
        self.checksum = hashlib.sha256(self.path.read_bytes()).hexdigest() + '  ' + self.path.name + '\n'

    def test_verified_exact_release(self):
        verify(self.path, self.checksum, 'v1.0.1')

    def test_corrupt_bytes_are_rejected(self):
        self.path.write_bytes(self.path.read_bytes() + b'corruption')
        with self.assertRaises(RuntimeError):
            verify(self.path, self.checksum, 'v1.0.1')

    def test_missing_or_duplicate_checksum_is_rejected(self):
        for checksum in ['', self.checksum * 2]:
            with self.subTest(checksum=checksum), self.assertRaises(RuntimeError):
                verify(self.path, checksum, 'v1.0.1')

    def test_wrong_host_is_rejected(self):
        self.archive(host='3.8.0')
        with self.assertRaises(ValueError):
            verify(self.path, self.checksum, 'v1.0.1')

    def test_wrong_release_version_is_rejected(self):
        self.archive(version='1.1.0')
        with self.assertRaises(RuntimeError):
            verify(self.path, self.checksum, 'v1.0.1')


class UpgradePreservationTests(unittest.TestCase):
    def test_samples_written_by_new_release_must_survive_rollback(self):
        source = {'old': {'timestamp': 1}, 'new': {'timestamp': 2}}
        with self.assertRaises(RuntimeError):
            upgrade['assert_retained'](source, {'old': source['old']}, True)

    def test_disabled_collection_requires_identical_documents(self):
        with self.assertRaises(RuntimeError):
            upgrade['assert_retained']({'old': 1}, {'old': 1, 'unexpected': 2}, False)
        upgrade['assert_retained']({'old': 1}, {'old': 1}, False)
        upgrade['assert_retained']({'old': 1}, {'old': 1, 'new': 2}, True)

    def test_modified_retained_sample_is_rejected(self):
        with self.assertRaises(RuntimeError):
            upgrade['assert_retained']({'old': {'value': 1}}, {'old': {'value': 2}}, True)

    def test_target_success_and_visible_sample_must_both_follow_stopped_source(self):
        sample = {'snapshot': {'timestamp': 101}, 'collection': {'last_success': 99}}
        self.assertFalse(upgrade['fresh_history'](sample, 100))
        sample['collection']['last_success'] = 101
        self.assertTrue(upgrade['fresh_history'](sample, 100))
        sample['snapshot']['timestamp'] = 100
        self.assertFalse(upgrade['fresh_history'](sample, 100))


class UpgradeCleanupTests(unittest.TestCase):
    def clean(self, fake):
        cleanup = upgrade['cleanup_fixture']
        with patch.dict(cleanup.__globals__, {'docker': fake}):
            cleanup(['fixture-os', 'fixture-dash'], 'fixture-network', ['fixture-data'], ['fixture:old', 'fixture:new'])

    def test_cleanup_attempts_every_owned_resource_and_accepts_absence(self):
        calls = []
        self.clean(lambda *args, **kwargs: calls.append(args) or '')
        self.assertEqual(len([args for args in calls if 'rm' in args]), 6)
        self.assertFalse(any('prune' in args for args in calls))

    def test_remaining_owned_resource_fails_without_reporting_unrelated_names(self):
        def fake(*args, **kwargs):
            return 'fixture-dash\nunrelated-private-name' if args[:2] == ('container', 'ls') else ''
        with self.assertRaisesRegex(RuntimeError, 'fixture-dash') as error:
            self.clean(fake)
        self.assertNotIn('unrelated-private-name', str(error.exception))

    def test_unavailable_docker_does_not_claim_success(self):
        def fake(*args, **kwargs):
            if 'ls' in args:
                raise RuntimeError('Cannot confirm cleanup')
            return ''
        with self.assertRaises(RuntimeError):
            self.clean(fake)


class UpgradeDiagnosticsTests(unittest.TestCase):
    def test_browser_error_keeps_cause_but_redacts_credentials(self):
        secret = 'fixture-secret'
        encoded = base64.b64encode(('admin:' + secret).encode()).decode()
        message = 'TimeoutError: filling ' + secret + '\nAuthorization: Basic ' + encoded + '\nCookie: session-token\n'
        result = upgrade['browser_failure'](SimpleNamespace(returncode=1), message, secret)
        self.assertIn('TimeoutError', result)
        for value in [secret, encoded, 'session-token']:
            self.assertNotIn(value, result)


if __name__ == '__main__':
    unittest.main()

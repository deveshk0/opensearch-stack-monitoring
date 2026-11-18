"""Reject wrong or corrupted public release inputs before Docker is touched."""
import hashlib
import json
from pathlib import Path
import runpy
import tempfile
import unittest
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


if __name__ == '__main__':
    unittest.main()

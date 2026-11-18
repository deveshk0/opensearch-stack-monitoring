import os
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parent.parent


class HostToolchainTests(unittest.TestCase):
    def config(self, version=None):
        env = {key: value for key, value in os.environ.items() if key != "OSD_VERSION"}
        if version is not None:
            env["OSD_VERSION"] = version
        return subprocess.run(
            ["bash", "-c", 'set -eu; source scripts/host-version.sh; printf "%s\\n" "$OSD_VERSION" "$OSD_COMMIT" "$NODE_VERSION" "$OSD_HOST"'],
            cwd=ROOT, env=env, capture_output=True, text=True,
        )

    def test_pinned_hosts_and_default(self):
        expected = {
            "3.7.0": ("dd15c5757c758bc51d8992e979e05f975a605434", "22.22.3"),
            "3.8.0": ("aa72a9818a045ad4e290a5eb9be59e025b90634d", "22.23.0"),
            "3.9.0": ("def668b5c4ad825dfff980ed0951cca07aa0ac4b", "22.23.0"),
            "3.10.0": ("73911ce80af1364fa32301e220ec34910a58c0d3", "22.23.4"),
        }
        for version, (commit, node) in expected.items():
            with self.subTest(version=version):
                result = self.config(version)
                self.assertEqual(result.returncode, 0, result.stderr)
                suffix = "" if version == "3.9.0" else "-" + version
                self.assertEqual(result.stdout.splitlines(), [
                    version, commit, node, str(ROOT / (".cache/OpenSearch-Dashboards" + suffix)),
                ])
        self.assertEqual(self.config().stdout, self.config("3.9.0").stdout)

    def test_unsupported_hosts_fail_before_bootstrap(self):
        for version in ("2.19.7", "3.11.0", "../3.9.0", "3.9", ""):
            with self.subTest(version=version):
                result = self.config(version)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Unsupported OSD_VERSION", result.stderr)


if __name__ == "__main__":
    unittest.main()

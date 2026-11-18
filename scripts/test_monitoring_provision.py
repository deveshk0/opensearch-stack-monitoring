"""The production provisioner never sends credentials over unverified TLS."""
import importlib.util
import io
from pathlib import Path
import ssl
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('provision_monitoring', Path(__file__).with_name('provision-monitoring.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProvisionerTests(unittest.TestCase):
    def test_rejects_untrusted_urls_before_opening_connections(self):
        for url in ['http://cluster:9200', 'https://user:password@cluster',
                    'https://cluster?token=secret', 'https://cluster/#fragment']:
            with self.assertRaises(ValueError):
                module.build_client(url, None, 'operator', 'password')

    def test_tls_is_verified_and_redirects_are_rejected(self):
        with patch.object(module.urllib.request, 'build_opener') as factory:
            client = module.build_client('https://cluster:9200', None, 'operator', 'password')
            handlers = factory.call_args.args
            https = next(handler for handler in handlers if isinstance(handler, module.urllib.request.HTTPSHandler))
            self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(https._context.check_hostname)
            redirects = next(handler for handler in handlers if isinstance(handler, module.urllib.request.HTTPRedirectHandler))
            with self.assertRaises(RuntimeError):
                redirects.redirect_request(None, None, 302, 'redirect', {}, 'https://elsewhere')
            factory.return_value.open.return_value.__enter__.return_value = io.BytesIO(b'{"ok":true}')
            self.assertEqual(client('PUT', '/owned', {'enabled': False}), {'ok': True})
            request = factory.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, 'https://cluster:9200/owned')
            self.assertEqual(request.data, b'{"enabled": false}')

    def test_http_errors_do_not_echo_response_secrets(self):
        with patch.object(module.urllib.request, 'build_opener') as factory:
            factory.return_value.open.side_effect = urllib.error.HTTPError(
                'https://cluster', 403, 'password-secret', {}, io.BytesIO(b'password-secret'))
            client = module.build_client('https://cluster', None, 'operator', 'password-secret')
            with self.assertRaisesRegex(RuntimeError, 'HTTP 403') as caught:
                client('GET', '/owned')
            self.assertNotIn('password-secret', str(caught.exception))


if __name__ == '__main__':
    unittest.main()

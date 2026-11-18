#!/usr/bin/env python3
"""Provision monitoring storage and roles without creating or modifying identities."""
import argparse
import base64
import getpass
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

from monitoring_resources import ApiError, provision


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Redirect refused; use the final HTTPS cluster endpoint')


def build_client(url, ca_cert, username, password):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment):
        raise ValueError('Use an HTTPS URL without embedded credentials, query, or fragment')
    if not username or ':' in username or not password:
        raise ValueError('A nonempty username without a colon and a password are required')
    context = ssl.create_default_context(cafile=ca_cert)
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), NoRedirect())
    authorization = 'Basic ' + base64.b64encode(f'{username}:{password}'.encode()).decode()

    def api(method, path, body=None):
        headers = {'Authorization': authorization, 'Accept': 'application/json'}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body).encode()
        request = urllib.request.Request(url.rstrip('/') + path, method=method, data=data, headers=headers)
        try:
            with opener.open(request, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise ApiError(method, path, error.code) from None
        except urllib.error.URLError:
            raise RuntimeError(f'{method} {path}: connection failed; check endpoint, CA, hostname and connectivity') from None
        except json.JSONDecodeError:
            raise RuntimeError(f'{method} {path}: invalid JSON response') from None

    return api


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default=os.environ.get('OPENSEARCH_URL'), help='HTTPS cluster URL (or OPENSEARCH_URL)')
    parser.add_argument('--ca-cert', default=os.environ.get('OPENSEARCH_CA_CERT'), help='CA PEM file; defaults to system trust')
    parser.add_argument('--username', default=os.environ.get('OPENSEARCH_USERNAME'), help='Provisioning identity (or OPENSEARCH_USERNAME)')
    parser.add_argument('--retention-days', type=int, default=7, help='Metrics retention after rollover (default: 7)')
    parser.add_argument('--replicas', type=int, default=1, help='Replicas for new monitoring indices (default: 1)')
    args = parser.parse_args()
    if not args.url:
        parser.error('--url or OPENSEARCH_URL is required')
    if not args.username:
        if not sys.stdin.isatty():
            parser.error('--username or OPENSEARCH_USERNAME is required without a terminal')
        args.username = input('Provisioning username: ').strip()
    password = os.environ.get('OPENSEARCH_PASSWORD')
    if not password:
        if not sys.stdin.isatty():
            parser.error('Set OPENSEARCH_PASSWORD when no terminal is available')
        password = getpass.getpass('Provisioning password: ')
    try:
        api = build_client(args.url, args.ca_cert, args.username, password)
        provision(api, retention_days=args.retention_days, replicas=args.replicas)
    except (RuntimeError, ValueError, OSError) as error:
        parser.exit(1, f'Provisioning failed: {error}\n')
    print('Monitoring resources and roles provisioned. Map existing identities to the monitoring roles separately.')


if __name__ == '__main__':
    main()

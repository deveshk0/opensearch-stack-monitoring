#!/usr/bin/env python3
"""Verify published v1.0.1 -> v1.1.0 and rollback on an isolated 3.9.0 host.

--check downloads and validates releases only. The live check uses disposable
Docker resources; PLAYWRIGHT_MODULE enables cached-browser upgrade checks.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import runpy
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile

from release import validate_archive

ROOT = Path(__file__).resolve().parents[1]
HOST = '3.9.0'
RELEASES = {'v1.0.1': 'stack-monitoring.zip', 'v1.1.0': 'stack-monitoring-3.9.0.zip'}
helpers = runpy.run_path(str(Path(__file__).with_name('check-compatibility.py')))
require, docker, request, wait_for, endpoint, private_file = (
    helpers[key] for key in ['require', 'docker', 'request', 'wait_for', 'endpoint', 'private_file'])


def verify_release(path, checksums, tag):
    matches = [line.split()[0] for line in checksums.splitlines()
               if len(line.split()) == 2 and line.split()[1] == path.name]
    require(len(matches) == 1, 'Expected exactly one release checksum')
    require(hashlib.sha256(path.read_bytes()).hexdigest() == matches[0], 'Release checksum mismatch')
    validate_archive(path, HOST)
    with zipfile.ZipFile(path) as archive:
        for file in ['package.json', 'opensearch_dashboards.json']:
            metadata = json.loads(archive.read('opensearch-dashboards/stackMonitoring/' + file))
            require(metadata['version'] == tag[1:], 'Plugin version does not match its release tag')


def download_releases():
    result = {}
    for tag, asset in RELEASES.items():
        directory = ROOT / '.cache/upgrade-releases' / tag
        directory.mkdir(parents=True, exist_ok=True)
        base = f'https://github.com/deveshk0/opensearch-stack-monitoring/releases/download/{tag}/'
        with urllib.request.urlopen(base + 'SHA256SUMS', timeout=60) as response:
            checksums = response.read().decode()
        path = directory / asset
        if not path.exists():
            with urllib.request.urlopen(base + asset, timeout=60) as response:
                path.write_bytes(response.read())
        verify_release(path, checksums, tag)
        result[tag] = path
        print(f'PASS: {tag} published checksum, plugin version and exact host', flush=True)
    return result


def assert_retained(expected, actual, enabled):
    require(all(key in actual and actual[key] == value for key, value in expected.items()),
            'Retained monitoring documents changed or disappeared')
    if not enabled:
        require(actual == expected, 'Disabled collection changed the stored documents')


def fresh_history(body, after):
    return bool(body and body.get('snapshot') and body['snapshot']['timestamp'] > after
                and (body['collection'].get('last_success') or 0) > after)


def main():
    require(sys.argv[1:] in ([], ['--check']), 'Only --check is supported')
    archives = download_releases()
    if sys.argv[1:]:
        return
    prefix = 'stack-upgrade-' + secrets.token_hex(6)
    node, dashboards = prefix + '-os', prefix + '-dash'
    volumes = [prefix + '-os-data', prefix + '-dash-data']
    images = {tag: prefix + ':' + tag for tag in RELEASES}
    admin = 'Upgrade9!' + secrets.token_hex(24)
    collector = 'Collector9!' + secrets.token_hex(24)
    reader = 'Reader9!' + secrets.token_hex(24)
    denied = 'Denied9!' + secrets.token_hex(24)
    checks = []
    browser = None
    with tempfile.TemporaryDirectory(prefix=prefix + '-') as temporary:
        temporary = Path(temporary)
        try:
            for tag, archive in archives.items():
                context = temporary / tag
                (context / 'artifacts').mkdir(parents=True)
                shutil.copyfile(archive, context / 'artifacts/stack-monitoring.zip')
                shutil.copyfile(ROOT / 'docker/Dockerfile.dashboards', context / 'Dockerfile')
                print(f'Building isolated image for {tag}', flush=True)
                docker('build', '--build-arg', f'OPENSEARCH_VERSION={HOST}', '-t', images[tag], str(context), timeout=900)
            docker('network', 'create', prefix)
            for volume in volumes:
                docker('volume', 'create', volume)
            os_env = temporary / 'opensearch.env'
            private_file(os_env, f'OPENSEARCH_INITIAL_ADMIN_PASSWORD={admin}\n')
            docker('run', '-d', '--name', node, '--network', prefix, '--network-alias', 'opensearch',
                   '--memory', '1536m', '--ulimit', 'memlock=-1:-1', '--ulimit', 'nofile=65536:65536',
                   '-p', '127.0.0.1::9200', '--env-file', str(os_env),
                   '-e', 'discovery.type=single-node', '-e', 'cluster.name=release-upgrade-fixture',
                   '-e', 'bootstrap.memory_lock=true', '-e', 'node.store.allow_mmap=false',
                   '-e', 'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
                   '-v', f'{volumes[0]}:/usr/share/opensearch/data',
                   f'opensearchproject/opensearch:{HOST}', timeout=600)
            os_url = endpoint(node, 9200, 'https')
            def os_api(path, method='GET', body=None, user='admin', password=None):
                return request(os_url, path, password or admin, method, body, user)
            def healthy():
                code, body = os_api('/_cluster/health')
                return code == 200 and body.get('number_of_data_nodes') == 1 and body.get('status') in ('green', 'yellow')
            wait_for('fresh OpenSearch', healthy, 300)
            old_source = subprocess.check_output(['git', 'show', 'v1.0.1:scripts/monitoring_resources.py'], cwd=ROOT)
            old_file = temporary / 'old_resources.py'
            old_file.write_bytes(old_source)
            old = runpy.run_path(str(old_file))
            def provision_api(method, path, body=None):
                code, response = os_api(path, method, body)
                if code >= 400:
                    raise old['ApiError'](method, path, code)
                return response
            old['provision'](provision_api, retention_days=11, replicas=0)
            for user, password, roles in [
                ('upgrade_collector', collector, ['stack_monitoring_collector']),
                ('upgrade_reader', reader, ['stack_monitoring_reader', 'kibana_user']),
                ('upgrade_denied', denied, []),
            ]:
                require(os_api('/_plugins/_security/api/internalusers/' + user, 'PUT', {
                    'password': password, 'backend_roles': [], 'opendistro_security_roles': roles})[0] in (200, 201), 'Fixture identity creation failed')
            require(os_api('/upgrade-fixture-orders', 'PUT', {'settings': {'number_of_shards': 1, 'number_of_replicas': 0}})[0] == 200, 'Fixture data index creation failed')
            require(os_api('/upgrade-fixture-orders/_doc/order-1?refresh=true', 'PUT', {'total': 42, 'status': 'retained'})[0] in (200, 201), 'Fixture data write failed')
            config = temporary / 'opensearch_dashboards.yml'
            config.write_text('''server.host: "0.0.0.0"
server.name: release-upgrade-dashboards
opensearch.hosts: ["https://opensearch:9200"]
opensearch.ssl.verificationMode: none
opensearch.username: kibanaserver
opensearch.password: kibanaserver
opensearch.requestHeadersAllowlist: [authorization, securitytenant]
opensearch_security.multitenancy.enabled: true
opensearch_security.cookie.secure: false
uiSettings.overrides.defaultRoute: /app/stackMonitoring
stackMonitoring.collection.username: upgrade_collector
stackMonitoring.collection.password: ${UPGRADE_COLLECTOR_PASSWORD}
stackMonitoring.collection.resolvedRetentionDays: 17
''')
            config.chmod(0o644)
            dash_env = temporary / 'dashboards.env'
            private_file(dash_env, f'UPGRADE_COLLECTOR_PASSWORD={collector}\n')
            dash_url = None
            def dash_api(path, method='GET', body=None, user='admin', password=None):
                return request(dash_url, path, password or admin, method, body, user)
            def start(tag):
                nonlocal dash_url
                port = '127.0.0.1::5601' if dash_url is None else urllib.parse.urlparse(dash_url).netloc + ':5601'
                docker('run', '-d', '--name', dashboards, '--network', prefix, '--memory', '768m',
                       '-p', port, '--env-file', str(dash_env), '-e', 'NODE_OPTIONS=--max-old-space-size=512',
                       '-v', f'{config}:/usr/share/opensearch-dashboards/config/opensearch_dashboards.yml:ro',
                       '-v', f'{volumes[1]}:/usr/share/opensearch-dashboards/data', images[tag])
                dash_url = endpoint(dashboards, 5601, 'http')
                wait_for('Dashboards ' + tag, lambda: dash_api('/api/stack_monitoring/collection')[0] == 200, 300)
                metadata = json.loads(docker('exec', dashboards, 'node/bin/node', '-e',
                    'console.log(JSON.stringify(require("./plugins/stackMonitoring/opensearch_dashboards.json")))'))
                require(metadata['version'] == tag[1:] and metadata['opensearchDashboardsVersion'] == HOST, 'Installed release identity mismatch')
            def history(after=0):
                code, body = dash_api('/api/stack_monitoring/history')
                return body if code == 200 and fresh_history(body, after) else None
            def toggle(enabled):
                code, body = dash_api('/api/stack_monitoring/collection', 'POST', {'enabled': enabled})
                require(code == 200 and body['enabled'] == enabled, 'Collection toggle failed')
            def documents():
                code, body = os_api('/stack-monitoring-v2-*/_search', 'POST', {'size': 10000, 'track_total_hits': True})
                require(code == 200 and body['hits']['total']['value'] < 10000, 'Unable to capture complete retained fixture history')
                return {(hit['_index'], hit['_id']): hit['_source'] for hit in body['hits']['hits']}
            def check_access():
                require(dash_api('/api/stack_monitoring/history', user='upgrade_reader', password=reader)[0] == 200, 'Reader lost history access')
                require(dash_api('/api/stack_monitoring/history', user='upgrade_denied', password=denied)[0] == 403, 'Denied user gained history access')
                require(dash_api('/api/stack_monitoring/collection', 'POST', {'enabled': False}, 'upgrade_reader', reader)[0] == 403, 'Reader gained collection write access')
                code, body = os_api('/_plugins/_security/api/account', user='upgrade_collector', password=collector)
                require(code == 200 and body['roles'] == ['stack_monitoring_collector'], 'Collector credentials or scope changed')
                require(os_api('/upgrade-fixture-orders/_doc/forbidden', 'PUT', {'forbidden': True}, 'upgrade_collector', collector)[0] == 403, 'Collector gained application write access')
            start('v1.0.1')
            first = wait_for('old release sample', history, 180)
            wait_for('second old release sample', lambda: history(first['snapshot']['timestamp']), 60)
            toggle(False)
            require(os_api('/stack-monitoring-v2-*/_refresh', 'POST')[0] == 200, 'Fixture history refresh failed')
            retained = documents()
            require(len(retained) > 1, 'Old release produced no retained history')
            baseline = dash_api('/api/stack_monitoring/history')[1]['snapshot']
            instance = baseline['instances'][0]['id']
            end = baseline['timestamp']
            iso = lambda value: datetime.datetime.fromtimestamp(value / 1000, datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
            fixed_range = {'from': iso(end - 60000), 'to': iso(end)}
            history_paths = ['/api/stack_monitoring/history?' + urllib.parse.urlencode({**fixed_range, **query})
                             for query in [{}, {'type': 'node', 'id': baseline['nodes'][0]['id']}]]
            historical = []
            for path in history_paths:
                code, body = dash_api(path)
                require(code == 200 and body['series'], 'Old release historical API is empty')
                historical.append((path, {'snapshot': body['snapshot'], 'series': body['series']}))
            incident = {'id': 'upgrade-retained-insight', 'cluster_uuid': baseline['cluster_uuid'],
                        'rule_id': 'unassigned-shards', 'entity_id': 'upgrade-fixture', 'entity_name': 'Upgrade fixture',
                        'entity_type': 'cluster', 'severity': 'warning', 'status': 'resolved',
                        'first_seen': end - 60000, 'detected_at': end - 50000, 'last_seen': end - 10000,
                        'last_evaluated': end - 10000, 'resolved_at': end - 10000, 'value': 1, 'evidence': []}
            require(os_api('/stack-monitoring-insights-v1/_doc/upgrade-retained-insight?refresh=true', 'PUT', incident)[0] in (200, 201), 'Could not store retained insight fixture')
            policy_path = '/_plugins/_ism/policies/stack-monitoring-v2-retention'
            policy = os_api(policy_path)[1]['policy']
            require(policy['states'][0]['transitions'][0]['conditions']['min_rollover_age'] == '11d', 'Custom retention was not applied')
            templates = {name: os_api('/_index_template/' + name)[1] for name in ['stack-monitoring-v2', 'stack-monitoring-insights-v1']}
            aliases = os_api('/_alias/stack-monitoring-write')[1]
            users = os_api('/_plugins/_security/api/internalusers')[1]
            config_hash = hashlib.sha256(config.read_bytes()).hexdigest()
            def preserved(enabled):
                code, state = dash_api('/api/stack_monitoring/collection')
                require(code == 200 and state['configured'] and state['enabled'] == enabled and state['desired_enabled'] == enabled, 'Saved collection state changed')
                for path, expected in historical:
                    code, body = dash_api(path)
                    require(code == 200 and {'snapshot': body['snapshot'], 'series': body['series']} == expected, 'Historical API data changed')
                current = documents()
                require(all(current.get(key) == value for key, value in retained.items()), 'Retained monitoring documents changed or disappeared')
                require(os_api('/stack-monitoring-insights-v1/_doc/upgrade-retained-insight')[1]['_source'] == incident, 'Retained insight changed')
                require(os_api('/upgrade-fixture-orders/_doc/order-1')[1]['_source'] == {'total': 42, 'status': 'retained'}, 'Application data changed')
                require(os_api(policy_path)[1]['policy'] == policy, 'Custom retention policy changed')
                require(os_api('/_alias/stack-monitoring-write')[1] == aliases, 'Write alias changed')
                for name, value in templates.items():
                    require(os_api('/_index_template/' + name)[1] == value, 'Monitoring template changed')
                require(os_api('/_plugins/_security/api/internalusers')[1] == users, 'Collector or other identities changed')
                require(hashlib.sha256(config.read_bytes()).hexdigest() == config_hash, 'Manual configuration changed')
                require(docker('exec', dashboards, 'cat', 'data/uuid') == instance, 'Persistent Dashboards UUID changed')
                check_access()
                if enabled:
                    state = history()
                    require(state and not state['collection']['last_error'] and not state['snapshot']['errors'], 'Resumed collection is incomplete')
                    require(state['snapshot']['instances'][0]['id'] == instance, 'Dashboards instance identity changed')
                if installed == 'v1.1.0':
                    code, setup = dash_api('/api/stack_monitoring/setup')
                    require(code == 200 and setup['configured'] and not setup['managed'], 'Upgrade replaced manual collector configuration')
                    docker('exec', dashboards, 'test', '!', '-e', '/usr/share/opensearch-dashboards/data/stack-monitoring/collector.json')
            installed = 'v1.0.1'
            preserved(False)
            for enabled in [False, True]:
                if enabled:
                    toggle(True)
                    wait_for('old release resumed sample', lambda: history(end), 120)
                for target in ['v1.1.0', 'v1.0.1']:
                    label = f'{installed} -> {target}, collection ' + ('enabled' if enabled else 'disabled')
                    print('Checking ' + label, flush=True)
                    if os.environ.get('PLAYWRIGHT_MODULE'):
                        browser_config = temporary / 'browser.json'
                        if browser_config.exists():
                            browser_config.unlink()
                        ready = temporary / 'browser-ready'
                        ready.unlink(missing_ok=True)
                        private_file(browser_config, json.dumps({'base': dash_url, 'password': admin, 'ready': str(ready)}))
                        browser = subprocess.Popen([os.environ.get('NODE_BINARY', 'node'), str(ROOT / 'scripts/check-release-upgrade-browser.cjs')],
                            env={**os.environ, 'UPGRADE_BROWSER_CONFIG': str(browser_config)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                        def browser_ready():
                            if browser.poll() is not None:
                                _, stderr = browser.communicate()
                                stage = next((line for line in stderr.splitlines() if line.startswith('FAIL: browser stage ')), 'details withheld')
                                raise RuntimeError('Browser could not warm the installed release: ' + stage)
                            return ready.exists()
                        wait_for('cached browser baseline', browser_ready, 90)
                    docker('stop', '--time', '60', dashboards)
                    require(os_api('/stack-monitoring-v2-*/_refresh', 'POST')[0] == 200, 'Stopped source history refresh failed')
                    source_documents = documents()
                    before = max(value['timestamp'] for value in source_documents.values())
                    docker('rm', dashboards)
                    start(target)
                    installed = target
                    if enabled:
                        wait_for('fresh sample after image replacement', lambda: history(before), 120)
                    else:
                        time.sleep(12)
                    assert_retained(source_documents, documents(), enabled)
                    preserved(enabled)
                    if browser:
                        stdout, stderr = browser.communicate(timeout=150)
                        require(browser.returncode == 0, 'Cached-browser reload failed: ' + next((line for line in stderr.splitlines() if line.startswith('FAIL: browser stage ')), 'details withheld'))
                        browser = None
                    checks.append(label)
                    print('PASS: ' + label + '; retained history/insight, settings, identity and permissions'
                          + ('; cached browser passed' if os.environ.get('PLAYWRIGHT_MODULE') else '; browser not requested'), flush=True)
            report = {'host': HOST, 'completed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'passed': checks, 'retained_documents': len(retained), 'browser_checked': bool(os.environ.get('PLAYWRIGHT_MODULE')),
                      'archives': {tag: hashlib.sha256(path.read_bytes()).hexdigest() for tag, path in archives.items()}}
            (ROOT / '.cache/release-upgrade-results.json').write_text(json.dumps(report, indent=2) + '\n')
            print('PASS: published release upgrade and rollback verification complete', flush=True)
        finally:
            if browser and browser.poll() is None:
                browser.terminate()
                try:
                    browser.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    browser.kill()
                    browser.wait()
            for container in [dashboards, node]:
                docker('rm', '-f', container, check=False)
            docker('network', 'rm', prefix, check=False)
            for volume in volumes:
                docker('volume', 'rm', volume, check=False)
            for image in images.values():
                docker('image', 'rm', image, check=False)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if isinstance(error, RuntimeError):
            print('FAIL: ' + str(error), file=sys.stderr)
        else:
            print(f'FAIL: upgrade verification raised {type(error).__name__}; details withheld to protect credentials', file=sys.stderr)
        sys.exit(1)

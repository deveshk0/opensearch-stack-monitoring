#!/usr/bin/env python3
"""Provision only this demo's monitoring identities, template, and retention policy."""
import base64
import json
from pathlib import Path
import ssl
import subprocess
import urllib.error
import urllib.request
from monitoring_resources import ApiError, provision

ROOT = Path(__file__).resolve().parents[1]
ENV = dict(line.split('=', 1) for line in (ROOT / '.opensearch.env').read_text().splitlines())
# Local-only OpenSearch bundled demo certificates do not cover localhost.
TLS = ssl._create_unverified_context()


def api(method, path, body=None, user='admin', password=None):
    password = password or ENV['OPENSEARCH_ADMIN_PASSWORD']
    headers = {'Authorization': 'Basic ' + base64.b64encode(f'{user}:{password}'.encode()).decode()}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request('https://localhost:9201' + path, method=method,
                                    data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(request, context=TLS, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # The response can contain request material; report only path and status.
        raise ApiError(method, path, error.code) from None


def main():
    health = api('GET', '/_cluster/health?wait_for_nodes=3&wait_for_status=green&timeout=30s')
    assert health['number_of_nodes'] == 3 and health['status'] == 'green', health
    provision(api)
    security = '/_plugins/_security/api/'
    config = api('GET', security + 'securityconfig')['config']
    if config['dynamic']['kibana']['server_username'] != 'stack_dashboards':
        config['dynamic']['kibana']['server_username'] = 'stack_dashboards'
        config_path = ROOT / '.cache/security-config.json'
        config_path.parent.mkdir(exist_ok=True)
        config_path.write_text(json.dumps({'_meta': {'type': 'config', 'config_version': 2}, 'config': config}))
        config_path.chmod(0o600)
        compose = ['docker', 'compose', '--env-file', str(ROOT / '.opensearch.env'), '-f', str(ROOT / 'compose.opensearch.yml')]
        subprocess.run(compose + ['cp', str(config_path), 'os01:/tmp/stack-security-config.json'], check=True)
        subprocess.run(compose + ['exec', '-T', '-u', 'root', 'os01', 'chown', 'opensearch:opensearch', '/tmp/stack-security-config.json'], check=True)
        subprocess.run(compose + ['exec', '-T', 'os01', 'sh', '-c', 'plugins/opensearch-security/tools/securityadmin.sh -f /tmp/stack-security-config.json -t config -icl -nhnv -cacert config/root-ca.pem -cert config/kirk.pem -key config/kirk-key.pem'], check=True)
        config_path.unlink()
        subprocess.run(compose + ['exec', '-T', 'os01', 'rm', '/tmp/stack-security-config.json'], check=True)
    builtin = api('GET', security + 'roles/kibana_server')['kibana_server']
    api('PUT', security + 'roles/stack_dashboards_server', {key: builtin[key] for key in ['cluster_permissions', 'index_permissions', 'tenant_permissions']})
    identities = [
        ('stack_dashboards', 'DASHBOARDS_PASSWORD', ['stack_dashboards_server']),
        ('stack_monitoring_collector', 'MONITORING_COLLECTOR_PASSWORD', ['stack_monitoring_collector']),
        ('monitor', 'MONITORING_READER_PASSWORD', ['stack_monitoring_reader', 'stack_monitoring_manager']),
        ('monitor_denied', 'MONITORING_DENIED_PASSWORD', []),
    ]
    for username, password_key, roles in identities:
        api('PUT', security + 'internalusers/' + username, {
            'password': ENV[password_key], 'opendistro_security_roles': roles,
            'backend_roles': ['kibanauser'] if username in ('monitor', 'monitor_denied') else [], 'attributes': {},
        })
    # Preserve the demo's existing v1 lifecycle; v2 uses the shared rollover policy.
    policy_path = '/_plugins/_ism/policies/stack-monitoring-retention'
    policy = {'policy': {'description': 'Retain only this plugin monitoring history for two days.',
        'default_state': 'collecting',
        'states': [
            {'name': 'collecting', 'actions': [], 'transitions': [
                {'state_name': 'delete', 'conditions': {'min_index_age': '2d'}}]},
            {'name': 'delete', 'actions': [{'delete': {}}], 'transitions': []},
        ],
        'ism_template': [{'index_patterns': ['stack-monitoring-v1-*'], 'priority': 100}],
    }}
    try:
        previous = api('GET', policy_path)
        policy_path += f'?if_seq_no={previous["_seq_no"]}&if_primary_term={previous["_primary_term"]}'
    except RuntimeError as error:
        if 'HTTP 404' not in str(error):
            raise
    api('PUT', policy_path, policy)
    api('PUT', '/_index_template/stack-monitoring-v1', {
        'index_patterns': ['stack-monitoring-v1-*'], 'priority': 100,
        'template': {
            'settings': {'number_of_shards': 1, 'number_of_replicas': 1},
            'mappings': {'dynamic': False, 'properties': {
                'timestamp': {'type': 'date'}, 'cluster_uuid': {'type': 'keyword'},
                'type': {'type': 'keyword'}, 'entity_id': {'type': 'keyword'},
                'metrics': {'type': 'object', 'enabled': False},
                'counters': {'type': 'object', 'enabled': False},
                'payload': {'type': 'object', 'enabled': False},
            }},
        },
    })
    auth = api('GET', security + 'account', user='stack_monitoring_collector', password=ENV['MONITORING_COLLECTOR_PASSWORD'])
    assert 'stack_monitoring_collector' in auth['roles']
    try:
        api('GET', '/_search', user='stack_monitoring_collector', password=ENV['MONITORING_COLLECTOR_PASSWORD'])
    except RuntimeError as error:
        assert 'HTTP 403' in str(error), error
    else:
        raise AssertionError('Collector unexpectedly has application-document read permission')
    print('Three-node green cluster; monitoring roles, identities, v2 rollover resources and legacy v1 policy verified.')

if __name__ == '__main__':
    main()

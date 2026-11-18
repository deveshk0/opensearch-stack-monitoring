#!/usr/bin/env python3
"""Temporarily deny collector permissions to verify failure isolation and recovery."""
import base64
import copy
import json
from pathlib import Path
import runpy
import subprocess
import time
import urllib.request

setup = runpy.run_path(str(Path(__file__).with_name('setup-cluster.py')))
api, env = setup['api'], setup['ENV']
role_path = '/_plugins/_security/api/roles/stack_monitoring_collector'
saved = api('GET', role_path)['stack_monitoring_collector']
original = {key: saved[key] for key in ['cluster_permissions', 'index_permissions', 'tenant_permissions'] if key in saved}
headers = {'Authorization': 'Basic ' + base64.b64encode(('monitor:' + env['MONITORING_READER_PASSWORD']).encode()).decode()}

def status():
    request = urllib.request.Request('http://localhost:5602/api/stack_monitoring/collection', headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

def until(check, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = status()
            if check(value):
                return value
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise AssertionError('Timed out waiting for collector failure/recovery')

def deny(index):
    role = copy.deepcopy(original)
    role['index_permissions'] = [entry for entry in role['index_permissions'] if index not in entry['index_patterns']]
    api('PUT', role_path, role)

assert status()['enabled'], 'Test requires enabled collection'
try:
    deny('.stack-monitoring-settings')
    failed = until(lambda value: value['last_error'])
    time.sleep(12)
    assert status()['last_success'] == failed['last_success'], 'Settings failure did not stop collection'
    api('PUT', role_path, original)
    until(lambda value: not value['last_error'] and value['last_success'] > failed['last_success'])
    print('PASS: unreadable settings stop writes and collection recovers automatically after access returns', flush=True)
    deny('stack-monitoring-insights-v1')
    subprocess.run(['docker','compose','--env-file','.opensearch.env','-f','compose.opensearch.yml','restart','dashboards'], check=True)
    failed = until(lambda value: value['last_success'] and value.get('insights_error') and not value['last_error'])
    until(lambda value: value['last_success'] > failed['last_success'] and value.get('insights_error') and not value['last_error'])
    api('PUT', role_path, original)
    until(lambda value: not value.get('insights_error') and not value['last_error'] and value['last_success'] > failed['last_success'])
    print('PASS: Insights permission failure leaves metrics running and recovers automatically after access returns', flush=True)
finally:
    api('PUT', role_path, original)

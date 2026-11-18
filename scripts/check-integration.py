#!/usr/bin/env python3
"""Check the installed native plugin using both permitted and denied identities."""
import argparse
import base64
import datetime
import json
from pathlib import Path
import runpy
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

setup = runpy.run_path(str(Path(__file__).with_name('setup-cluster.py')))
api, env = setup['api'], setup['ENV']

def dashboards(path, user='monitor', key='MONITORING_READER_PASSWORD'):
    headers = {} if user is None else {'Authorization': 'Basic ' + base64.b64encode(f'{user}:{env[key]}'.encode()).decode()}
    request = urllib.request.Request('http://localhost:5602' + path, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None

parser = argparse.ArgumentParser()
parser.add_argument('--restart', action='store_true')
args = parser.parse_args()
health = api('GET', '/_cluster/health')
assert health['number_of_nodes'] == 3 and health['status'] == 'green'
for path in ['/api/stack_monitoring/history', '/api/stack_monitoring/status', '/api/stack_monitoring/logs']:
    assert dashboards(path, None)[0] == 401, path
    assert dashboards(path, 'monitor_denied', 'MONITORING_DENIED_PASSWORD')[0] == 403, path
    assert dashboards(path)[0] == 200, path
assert dashboards('/api/stack_monitoring/history?from=now-25h&to=now')[0] == 400
assert dashboards('/api/stack_monitoring/history?from=invalid&to=now')[0] == 400
assert dashboards('/api/stack_monitoring/history?type=unknown')[0] == 400
status, data = dashboards('/api/stack_monitoring/history')
assert status == 200 and data['snapshot'], data
snapshot = data['snapshot']
assert len(snapshot['nodes']) == 3 and snapshot['instances']
assert not snapshot['errors'], snapshot['errors']
assert data['collection']['last_success'] and not data['collection']['last_error']
assert len(data['series']) <= 360
assert any(p['metrics'].get('index_primary_rate', 0) and p['metrics']['index_primary_rate'] > 0 for p in data['series']), 'Run demo-traffic.py first'
assert any(p['name'] == 'stack-monitoring-demo' for p in snapshot['pipelines'])
for entity in [snapshot['nodes'][0], snapshot['indices'][0], snapshot['instances'][0], snapshot['pipelines'][0]]:
    query = urllib.parse.urlencode({'type': entity['type'], 'id': entity['id']})
    code, result = dashboards('/api/stack_monitoring/history?' + query)
    assert code == 200 and result['series'], entity['name']
for path, body in [('/monitoring-denied-probe/_doc/1', {'must_not_write': True})]:
    try:
        api('PUT', path, body, user='stack_monitoring_collector', password=env['MONITORING_COLLECTOR_PASSWORD'])
    except RuntimeError as error:
        assert 'HTTP 403' in str(error)
    else:
        raise AssertionError('Collector unexpectedly wrote outside monitoring indices')
end = snapshot['timestamp']
iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
query = urllib.parse.urlencode({'from': iso(end - 60000), 'to': iso(end)})
path = '/api/stack_monitoring/history?' + query
code, history = dashboards(path)
assert code == 200 and history['snapshot']['timestamp'] == end
assert all(end - 60000 <= point['timestamp'] <= end for point in history['series'])
if args.restart:
    subprocess.run(['docker', 'compose', '--env-file', '.opensearch.env', '-f', 'compose.opensearch.yml', 'restart', 'dashboards'], check=True)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            code, after = dashboards(path)
            if code == 200:
                assert after['snapshot']['timestamp'] == end, 'Historical sample changed or was lost'
                break
        except (OSError, ValueError):
            pass
        time.sleep(2)
    else:
        raise AssertionError('Dashboards did not recover after restart')
print('PASS: green 3-node cluster, real rates, entity history, current-user authorization, collector isolation, parameter validation and absolute range.' + (' History survives restart.' if args.restart else ''))

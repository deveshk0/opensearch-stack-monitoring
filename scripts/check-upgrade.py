#!/usr/bin/env python3
"""Verify a real retained v1 processor sample through the installed plugin."""
import base64
import datetime
import json
from pathlib import Path
import runpy
import urllib.parse
import urllib.request

setup = runpy.run_path(str(Path(__file__).with_name('setup-cluster.py')))
api, env = setup['api'], setup['ENV']
hits = api('POST', '/stack-monitoring-v1-*/_search?ignore_unavailable=true', {
    'size': 1, 'sort': [{'timestamp': 'desc'}], 'query': {'term': {'type': 'cluster'}},
    '_source': ['timestamp', 'payload.pipelines.processors']})['hits']['hits']
assert hits, 'Upgrade check requires retained v1 history'
source = hits[0]['_source']
processors = [processor for pipeline in source['payload']['pipelines'] for processor in pipeline.get('processors', [])]
assert processors, 'Upgrade check requires a retained v1 processor sample'
processor, end = processors[0], source['timestamp']
iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
query = urllib.parse.urlencode({'type': 'processor', 'id': processor['id'], 'from': iso(end - 60000), 'to': iso(end)})
headers = {'Authorization': 'Basic ' + base64.b64encode(('monitor:' + env['MONITORING_READER_PASSWORD']).encode()).decode()}
with urllib.request.urlopen(urllib.request.Request('http://localhost:5602/api/stack_monitoring/history?' + query, headers=headers), timeout=45) as response:
    result = json.load(response)
assert any(point['timestamp'] == end and point['metrics'] == processor['metrics'] for point in result['series'])
assert all(p['type'] == 'processor' for pipeline in result['snapshot']['pipelines'] for p in pipeline.get('processors', []))
print('PASS: retained v1 processor measurements and entity types survive the installed upgrade')

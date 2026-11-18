#!/usr/bin/env python3
"""Bounded, repeatable traffic on an explicitly named demo index and pipeline."""
import argparse
import json
import runpy
import time
from pathlib import Path

setup = runpy.run_path(str(Path(__file__).with_name('setup-cluster.py')))
api = setup['api']
parser = argparse.ArgumentParser()
parser.add_argument('--seconds', type=int, default=60)
args = parser.parse_args()
assert 1 <= args.seconds <= 600, 'Use 1–600 seconds'
api('PUT', '/_ingest/pipeline/stack-monitoring-demo', {
    'description': 'Local monitoring demo: label synthetic orders',
    'processors': [{'set': {'field': 'demo', 'value': True, 'tag': 'label-demo'}}],
})
try:
    api('PUT', '/monitoring-demo-orders', {'settings': {'number_of_shards': 3, 'number_of_replicas': 1},
        'mappings': {'properties': {'sequence': {'type': 'integer'}, 'demo': {'type': 'boolean'}}}})
except RuntimeError as error:
    if 'HTTP 400' not in str(error):
        raise
    assert api('GET', '/monitoring-demo-orders')
start = time.monotonic()
count = 0
while time.monotonic() - start < args.seconds:
    for _ in range(5):
        api('PUT', f'/monitoring-demo-orders/_doc/{count % 1000}?pipeline=stack-monitoring-demo', {'sequence': count})
        count += 1
    api('GET', '/monitoring-demo-orders/_search?q=demo:true')
    time.sleep(0.25)
api('POST', '/monitoring-demo-orders/_refresh')
print(f'Completed {count} writes and real searches; at most 1000 demo documents retained.')

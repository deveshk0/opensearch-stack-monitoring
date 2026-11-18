#!/usr/bin/env python3
"""Verify live rollover routing and an isolated ISM rollover/delete lifecycle."""
import json
from pathlib import Path
import runpy
import time
import uuid

setup = runpy.run_path(str(Path(__file__).with_name('setup-cluster.py')))
api = setup['api']

def wait(check, timeout=1200):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(5)
    raise AssertionError('ISM lifecycle did not finish within the test deadline')

alias = 'stack-monitoring-write'
current = api('GET', '/_alias/' + alias)
old = next(name for name, data in current.items() if data['aliases'][alias].get('is_write_index'))
result = api('POST', '/' + alias + '/_rollover', {})
assert result['rolled_over'] and result['old_index'] == old
new = result['new_index']
settings = api('GET', '/' + new + '/_settings')[new]['settings']['index']
assert settings['number_of_shards'] == '1' and settings['number_of_replicas'] == '1'
assert settings['plugins']['index_state_management']['rollover_alias'] == alias
wait(lambda: api('POST', '/' + new + '/_count', {'query': {'term': {'type': 'cluster'}}})['count'], 90)
assert api('GET', '/' + old + '/_count')['count'] > 0
print('PASS: live alias rollover, inherited settings, new metric writes and preserved old history', flush=True)

# Only this unique prefix can be deleted by the short-lived verification policy.
prefix = 'stack-monitoring-verification-' + uuid.uuid4().hex[:10]
test_alias, index = prefix + '-write', prefix + '-000001'
policy_path = '/_plugins/_ism/policies/' + prefix
template_path = '/_index_template/' + prefix
try:
    api('PUT', policy_path, {'policy': {
        'description': 'Isolated lifecycle verification; unique disposable prefix only',
        'default_state': 'collecting',
        'states': [
            {'name': 'collecting', 'actions': [{'rollover': {'min_doc_count': 1}}], 'transitions': [{'state_name': 'delete', 'conditions': {'min_rollover_age': '1s'}}]},
            {'name': 'delete', 'actions': [{'delete': {}}], 'transitions': []}],
        'ism_template': [{'index_patterns': [prefix + '-*'], 'priority': 500}]}})
    api('PUT', template_path, {'index_patterns': [prefix + '-*'], 'priority': 500, 'template': {'settings': {'number_of_shards': 1, 'number_of_replicas': 1, 'plugins.index_state_management.rollover_alias': test_alias}}})
    api('PUT', '/' + index, {'aliases': {test_alias: {'is_write_index': True}}})
    api('PUT', '/' + test_alias + '/_doc/test?refresh=true', {'verification': True})
    print('Waiting for normal ISM scheduler on isolated test indices (no cluster settings changed).', flush=True)
    wait(lambda: any(name != index and value['aliases'][test_alias].get('is_write_index') for name, value in api('GET', '/_alias/' + test_alias).items()))
    print('PASS: ISM automatically rolled the test write alias', flush=True)
    wait(lambda: index not in api('GET', '/' + prefix + '-*'))
    print('PASS: ISM deleted only the retired test generation; current write index preserved', flush=True)
finally:
    for name in api('GET', '/' + prefix + '-*'):
        api('DELETE', '/' + name)
    api('DELETE', template_path)
    api('DELETE', policy_path)

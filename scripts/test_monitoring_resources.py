"""Offline checks for production monitoring provisioning."""
import copy
import json
from pathlib import Path
import unittest

from monitoring_resources import ApiError, resources, provision


class Cluster:
    def __init__(self):
        self.calls = []
        self.indices = {}
        self.templates = {}
        self.policy = None
        self.enabled = None
        self.managed_policy = 'stack-monitoring-v2-retention'
        self.simulated_template = None

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if path.startswith('/_plugins/_security/api/roles/'):
            return {}
        if path.startswith('/_plugins/_ism/explain/'):
            return {path.rsplit('/', 1)[1]: {'policy_id': self.managed_policy}}
        if path.startswith('/_plugins/_ism/policies/'):
            if method == 'GET':
                if self.policy is None:
                    raise ApiError(method, path, 404)
                return {'_seq_no': 2, '_primary_term': 1, **self.policy}
            self.policy = copy.deepcopy(body)
            return {}
        if path.startswith('/_index_template/_simulate_index/'):
            template = copy.deepcopy(self.simulated_template or self.templates['stack-monitoring-v2']['template'])
            settings = template['settings']
            template['settings'] = {'index': {
                'number_of_shards': str(settings['number_of_shards']),
                'number_of_replicas': str(settings['number_of_replicas']),
                'plugins': {'index_state_management': {
                    'rollover_alias': settings['plugins.index_state_management.rollover_alias']}},
            }}
            return {'template': template}
        if path.startswith('/_index_template/'):
            self.templates[path.rsplit('/', 1)[1]] = copy.deepcopy(body)
            return {}
        if path == '/_alias/stack-monitoring-write':
            aliases = {name: {'aliases': value.get('aliases', {})}
                       for name, value in self.indices.items()
                       if 'stack-monitoring-write' in value.get('aliases', {})}
            if not aliases:
                raise ApiError(method, path, 404)
            return copy.deepcopy(aliases)
        if path.startswith('/stack-monitoring-v2-*'):
            return {name: value for name, value in self.indices.items()
                    if name.startswith('stack-monitoring-v2-')}
        if path == '/.stack-monitoring-settings/_create/collection':
            if self.enabled is not None:
                raise ApiError(method, path, 409)
            self.enabled = body['enabled']
            return {}
        name = path.strip('/').split('/')[0]
        if path.endswith('/_mapping'):
            self.indices[name]['mappings'] = copy.deepcopy(body)
            return {}
        if method == 'GET':
            if name not in self.indices:
                raise ApiError(method, path, 404)
            return {name: copy.deepcopy(self.indices[name])}
        if method == 'PUT':
            template = self.templates['stack-monitoring-v2']['template'] if name.startswith('stack-monitoring-v2-') else {}
            self.indices[name] = {**copy.deepcopy(template), **copy.deepcopy(body)}
            return {}
        raise AssertionError((method, path))


class ResourceTests(unittest.TestCase):
    def test_native_setup_defaults_match_python_resources(self):
        path = Path(__file__).resolve().parents[1] / 'stack_monitoring/common/setup_resources.json'
        self.assertEqual(json.loads(path.read_text()), resources())

    def test_rollover_retains_seven_days_after_rollover(self):
        policy = resources()['policy']['policy']
        states = policy['states']
        self.assertEqual(states[0]['actions'][0]['rollover'],
                         {'min_index_age': '1d', 'min_primary_shard_size': '20gb'})
        self.assertEqual(states[0]['transitions'][0]['conditions'], {'min_rollover_age': '7d'})
        self.assertEqual(states[1]['actions'], [{'delete': {}}])
        self.assertEqual(policy['ism_template'][0]['index_patterns'], ['stack-monitoring-v2-*'])

    def test_template_does_not_redeclare_the_rollover_alias(self):
        template = resources()['metrics_template']['template']
        self.assertNotIn('aliases', template)
        self.assertEqual(template['settings']['number_of_shards'], 1)
        self.assertEqual(template['settings']['number_of_replicas'], 1)
        self.assertEqual(template['settings']['plugins.index_state_management.rollover_alias'], 'stack-monitoring-write')
        for field in ['metrics', 'counters', 'payload']:
            self.assertEqual(template['mappings']['properties'][field], {'type': 'object', 'enabled': False})

    def test_roles_keep_application_documents_and_lifecycle_admin_out_of_collector(self):
        roles = resources()['roles']
        collector = roles['stack_monitoring_collector']
        self.assertEqual(collector['index_permissions'][0],
                         {'index_patterns': ['*'], 'allowed_actions': ['indices:monitor/*']})
        permissions = {tuple(p['index_patterns']): p['allowed_actions'] for p in collector['index_permissions']}
        self.assertIn('indices:data/write/delete/byquery', permissions[('stack-monitoring-insights-v1',)])
        self.assertEqual(set(permissions[('.stack-monitoring-locks-v1',)]),
                         {'indices:data/read/get', 'indices:data/write/index', 'indices:data/write/delete',
                          'indices:data/write/bulk*'})
        metric_actions = permissions[('stack-monitoring-write', 'stack-monitoring-v2-*')]
        self.assertFalse(any(action == 'read' or action.startswith('indices:admin/') for action in metric_actions))
        self.assertFalse(any('stack-monitoring-v1-*' in p['index_patterns'] for p in collector['index_permissions']))
        reader = roles['stack_monitoring_reader']['index_permissions'][0]
        self.assertEqual(reader['index_patterns'], ['stack-monitoring-v1-*', 'stack-monitoring-v2-*', 'stack-monitoring-insights-v1'])

    def test_bootstrap_and_rerun_preserve_alias_and_disabled_setting(self):
        cluster = Cluster()
        provision(cluster)
        self.assertEqual(cluster.indices['stack-monitoring-v2-000001']['aliases'],
                         {'stack-monitoring-write': {'is_write_index': True}})
        self.assertEqual(cluster.indices['.stack-monitoring-locks-v1']['mappings'],
                         {'dynamic': 'strict', 'properties': {'owner': {'type': 'keyword'}}})
        cluster.enabled = False
        cluster.calls.clear()
        provision(cluster)
        self.assertIs(cluster.enabled, False)
        self.assertFalse(any(method == 'PUT' and path == '/stack-monitoring-v2-000001'
                             for method, path, _ in cluster.calls))
        self.assertTrue(any('if_seq_no=2&if_primary_term=1' in path for _, path, _ in cluster.calls))
        self.assertFalse(any('internalusers' in path or 'securityconfig' in path or 'rolesmapping' in path
                             for _, path, _ in cluster.calls))

    def test_existing_rollover_target_is_preserved(self):
        cluster = Cluster()
        provision(cluster)
        cluster.indices['stack-monitoring-v2-000002'] = cluster.indices.pop('stack-monitoring-v2-000001')
        provision(cluster)
        self.assertNotIn('stack-monitoring-v2-000001', cluster.indices)

    def test_fixed_insights_mapping_is_extended_without_rollover_or_retention_policy(self):
        cluster = Cluster()
        provision(cluster)
        del cluster.indices['stack-monitoring-insights-v1']['mappings']['properties']['evidence']
        cluster.calls.clear()
        provision(cluster)
        self.assertEqual(cluster.indices['stack-monitoring-insights-v1']['mappings']['properties']['evidence'],
                         {'type': 'object', 'enabled': False})
        self.assertNotIn('aliases', cluster.templates['stack-monitoring-insights-v1']['template'])
        self.assertFalse(any('stack-monitoring-v1' in path for _, path, _ in cluster.calls))

    def test_multiple_write_indices_and_wrong_rollover_setting_are_rejected(self):
        cluster = Cluster()
        provision(cluster)
        cluster.indices['stack-monitoring-v2-000002'] = copy.deepcopy(cluster.indices['stack-monitoring-v2-000001'])
        with self.assertRaisesRegex(RuntimeError, 'exactly one'):
            provision(cluster)
        del cluster.indices['stack-monitoring-v2-000002']
        cluster.indices['stack-monitoring-v2-000001']['settings']['plugins.index_state_management.rollover_alias'] = 'other'
        with self.assertRaisesRegex(RuntimeError, 'rollover alias'):
            provision(cluster)

    def test_authentication_failures_are_not_treated_as_missing_resources(self):
        calls = []
        def denied(method, path, body=None):
            calls.append(method)
            raise ApiError(method, path, 403)
        with self.assertRaises(ApiError):
            provision(denied)
        self.assertEqual(calls, ['GET'])

    def test_existing_write_target_requires_searchable_timestamp_mapping(self):
        cluster = Cluster()
        provision(cluster)
        del cluster.indices['stack-monitoring-v2-000001']['mappings']['properties']['timestamp']
        with self.assertRaisesRegex(RuntimeError, 'mapping'):
            provision(cluster)

    def test_existing_write_target_must_already_have_the_retention_policy(self):
        for policy in [None, 'unrelated-policy']:
            cluster = Cluster()
            provision(cluster)
            cluster.managed_policy = policy
            cluster.calls.clear()
            with self.assertRaisesRegex(RuntimeError, 'policy'):
                provision(cluster)
            self.assertFalse(any(method in ['PUT', 'POST', 'DELETE'] for method, _, _ in cluster.calls))

    def test_conflicting_effective_template_blocks_initial_backing_index(self):
        cluster = Cluster()
        cluster.simulated_template = copy.deepcopy(resources()['metrics_template']['template'])
        del cluster.simulated_template['mappings']['properties']['timestamp']
        with self.assertRaisesRegex(RuntimeError, 'mapping'):
            provision(cluster)
        self.assertNotIn('stack-monitoring-v2-000001', cluster.indices)

    def test_orphan_indices_or_wrong_alias_fail_without_repairing_ownership(self):
        for name, aliases in [('stack-monitoring-v2-000001', {}),
                              ('application-data', {'stack-monitoring-write': {'is_write_index': True}})]:
            cluster = Cluster()
            cluster.indices[name] = {'aliases': aliases}
            with self.assertRaisesRegex(RuntimeError, 'alias|backing'):
                provision(cluster)
            self.assertFalse(any(method in ['PUT', 'POST', 'DELETE'] for method, _, _ in cluster.calls))

    def test_conflicting_mapping_is_not_overwritten(self):
        cluster = Cluster()
        provision(cluster)
        cluster.indices['stack-monitoring-insights-v1']['mappings']['properties']['resolved_at'] = {'type': 'keyword'}
        with self.assertRaisesRegex(RuntimeError, 'mapping'):
            provision(cluster)
        self.assertEqual(cluster.indices['stack-monitoring-insights-v1']['mappings']['properties']['resolved_at']['type'], 'keyword')

    def test_configurable_retention_and_replicas_are_validated(self):
        result = resources(retention_days=14, replicas=2)
        self.assertEqual(result['policy']['policy']['states'][0]['transitions'][0]['conditions'], {'min_rollover_age': '14d'})
        self.assertEqual(result['metrics_template']['template']['settings']['number_of_replicas'], 2)
        for kwargs in [{'retention_days': 0}, {'replicas': -1}, {'retention_days': 1.5}]:
            with self.assertRaises(ValueError):
                resources(**kwargs)


if __name__ == '__main__':
    unittest.main()

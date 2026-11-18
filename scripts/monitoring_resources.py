"""Shared, narrowly scoped OpenSearch monitoring resources and provisioning."""
import re

WRITE_ALIAS = 'stack-monitoring-write'
METRICS_PATTERN = 'stack-monitoring-v2-*'
FIRST_INDEX = 'stack-monitoring-v2-000001'
INSIGHTS_INDEX = 'stack-monitoring-insights-v1'
SETTINGS_INDEX = '.stack-monitoring-settings'
LOCKS_INDEX = '.stack-monitoring-locks-v1'
POLICY = 'stack-monitoring-v2-retention'


class ApiError(RuntimeError):
    def __init__(self, method, path, status):
        self.status = status
        super().__init__(f'{method} {path}: HTTP {status}')


def resources(retention_days=7, replicas=1):
    if type(retention_days) is not int or retention_days < 1:
        raise ValueError('retention_days must be a positive integer')
    if type(replicas) is not int or replicas < 0:
        raise ValueError('replicas must be a nonnegative integer')
    settings = {'number_of_shards': 1, 'number_of_replicas': replicas}
    metrics_mapping = {'dynamic': False, 'properties': {
        'timestamp': {'type': 'date'},
        **{key: {'type': 'keyword'} for key in ['cluster_uuid', 'type', 'entity_id', 'name', 'status']},
        **{key: {'type': 'object', 'enabled': False} for key in ['metrics', 'counters', 'payload']},
    }}
    insights_mapping = {'dynamic': False, 'properties': {
        **{key: {'type': 'keyword'} for key in ['id', 'cluster_uuid', 'rule_id', 'entity_id', 'entity_name', 'entity_type', 'severity', 'status']},
        **{key: {'type': 'date'} for key in ['first_seen', 'detected_at', 'last_seen', 'last_evaluated', 'resolved_at']},
        'value': {'type': 'double'}, 'evidence': {'type': 'object', 'enabled': False},
    }}
    return {
        'policy': {'policy': {
            'description': f'Roll monitoring history at one day or 20 GiB; retain {retention_days} days after rollover.',
            'default_state': 'collecting',
            'states': [
                {'name': 'collecting', 'actions': [{'rollover': {'min_index_age': '1d', 'min_primary_shard_size': '20gb'}}],
                 'transitions': [{'state_name': 'delete', 'conditions': {'min_rollover_age': f'{retention_days}d'}}]},
                {'name': 'delete', 'actions': [{'delete': {}}], 'transitions': []},
            ],
            'ism_template': [{'index_patterns': [METRICS_PATTERN], 'priority': 200}],
        }},
        'metrics_template': {
            'index_patterns': [METRICS_PATTERN], 'priority': 200,
            'template': {'settings': {**settings, 'plugins.index_state_management.rollover_alias': WRITE_ALIAS},
                         'mappings': metrics_mapping},
        },
        'insights_template': {'index_patterns': [INSIGHTS_INDEX], 'priority': 200,
                              'template': {'settings': settings, 'mappings': insights_mapping}},
        'indices': {
            INSIGHTS_INDEX: {'settings': settings, 'mappings': insights_mapping},
            SETTINGS_INDEX: {'settings': settings, 'mappings': {
                'dynamic': 'strict', 'properties': {'enabled': {'type': 'boolean'}}}},
            LOCKS_INDEX: {'settings': settings, 'mappings': {
                'dynamic': 'strict', 'properties': {'owner': {'type': 'keyword'}}}},
        },
        'roles': {
            'stack_monitoring_collector': {
                'cluster_permissions': ['cluster_monitor', 'cluster:admin/ingest/pipeline/get', 'indices:data/write/bulk',
                                        'indices:data/read/scroll', 'indices:data/read/scroll/clear'],
                'index_permissions': [
                    {'index_patterns': ['*'], 'allowed_actions': ['indices:monitor/*']},
                    {'index_patterns': [SETTINGS_INDEX], 'allowed_actions': ['indices:data/read/get']},
                    {'index_patterns': [LOCKS_INDEX], 'allowed_actions': [
                        'indices:data/read/get', 'indices:data/write/index', 'indices:data/write/delete',
                        'indices:data/write/bulk*']},
                    {'index_patterns': [INSIGHTS_INDEX], 'allowed_actions': [
                        'read', 'indices:data/write/bulk*', 'indices:data/write/index*',
                        'indices:data/write/delete/byquery', 'indices:data/write/delete']},
                    {'index_patterns': [WRITE_ALIAS, METRICS_PATTERN], 'allowed_actions': [
                        'indices:data/write/bulk*', 'indices:data/write/index*']},
                ],
            },
            'stack_monitoring_reader': {
                'cluster_permissions': ['cluster_monitor', 'cluster_composite_ops_ro'],
                'index_permissions': [
                    {'index_patterns': ['stack-monitoring-v1-*', METRICS_PATTERN, INSIGHTS_INDEX], 'allowed_actions': ['read']},
                    {'index_patterns': [SETTINGS_INDEX], 'allowed_actions': ['indices:data/read/get']},
                ],
                'tenant_permissions': [{'tenant_patterns': ['global_tenant'], 'allowed_actions': ['kibana_all_read']}],
            },
            'stack_monitoring_manager': {'index_permissions': [
                {'index_patterns': [SETTINGS_INDEX], 'allowed_actions': ['indices:data/write/index', 'indices:data/write/bulk*']},
            ]},
        },
    }


def optional_get(api, path):
    try:
        return api('GET', path)
    except ApiError as error:
        if error.status != 404:
            raise
        return None


def validate_mapping(name, actual, expected, require_all=False):
    if actual.get('dynamic') not in [expected['dynamic'], str(expected['dynamic']).lower()]:
        raise RuntimeError(f'Conflicting mapping for {name}: dynamic setting')
    for field, definition in expected['properties'].items():
        current = actual.get('properties', {}).get(field)
        if current is None and require_all:
            raise RuntimeError(f'Missing mapping for {name}: {field}')
        if current is not None and any(current.get(key) != value for key, value in definition.items()):
            raise RuntimeError(f'Conflicting mapping for {name}: {field}')


def provision(api, retention_days=7, replicas=1):
    """Apply owned resources; the caller supplies authenticated api(method, path, body)."""
    desired = resources(retention_days, replicas)
    alias = optional_get(api, f'/_alias/{WRITE_ALIAS}')
    write_index = None
    if alias is not None:
        writers = []
        for name, value in alias.items():
            options = value.get('aliases', {}).get(WRITE_ALIAS, {})
            if not re.fullmatch(r'stack-monitoring-v2-\d{6,}', name) or any(
                    key in options for key in ['filter', 'routing', 'index_routing', 'search_routing']):
                raise RuntimeError('Monitoring write alias has an unexpected backing index or routing')
            if options.get('is_write_index') is True:
                writers.append(name)
        if len(writers) != 1:
            raise RuntimeError('Monitoring write alias must have exactly one explicit write index')
        write_index = writers[0]
    elif optional_get(api, f'/{WRITE_ALIAS}') or api('GET', f'/{METRICS_PATTERN}?expand_wildcards=all'):
        raise RuntimeError('Monitoring backing indices exist without the expected write alias; repair explicitly')

    existing = {}
    for name, definition in desired['indices'].items():
        current = optional_get(api, f'/{name}')
        if current is not None:
            if set(current) != {name}:
                raise RuntimeError(f'Expected a fixed monitoring index, found alias: {name}')
            validate_mapping(name, current[name].get('mappings', {}), definition['mappings'])
        existing[name] = current
    if write_index:
        current = api('GET', f'/{write_index}')[write_index]
        validate_mapping(write_index, current.get('mappings', {}), desired['metrics_template']['template']['mappings'], require_all=True)
        settings = current.get('settings', {})
        rollover_alias = settings.get('plugins.index_state_management.rollover_alias')
        if rollover_alias is None:
            rollover_alias = settings.get('index', {}).get('plugins', {}).get('index_state_management', {}).get('rollover_alias')
        if rollover_alias != WRITE_ALIAS:
            raise RuntimeError('Monitoring backing index has the wrong rollover alias setting')
        managed = api('GET', f'/_plugins/_ism/explain/{write_index}')
        if managed.get(write_index, {}).get('policy_id') != POLICY:
            raise RuntimeError(
                'Monitoring write index is not managed by the expected retention policy; '
                'retry after initial ISM attachment settles, otherwise repair its policy explicitly')

    policy_path = f'/_plugins/_ism/policies/{POLICY}'
    previous = optional_get(api, policy_path)
    if previous is not None:
        policy_path += f'?if_seq_no={previous["_seq_no"]}&if_primary_term={previous["_primary_term"]}'
    api('PUT', policy_path, desired['policy'])
    api('PUT', '/_index_template/stack-monitoring-v2', desired['metrics_template'])
    api('PUT', '/_index_template/stack-monitoring-insights-v1', desired['insights_template'])
    if write_index is None:
        effective = api('POST', f'/_index_template/_simulate_index/{FIRST_INDEX}')['template']
        validate_mapping(FIRST_INDEX, effective.get('mappings', {}),
                         desired['metrics_template']['template']['mappings'], require_all=True)
        settings = effective.get('settings', {}).get('index', {})
        rollover_alias = settings.get('plugins', {}).get('index_state_management', {}).get('rollover_alias')
        if (str(settings.get('number_of_shards')) != '1'
                or str(settings.get('number_of_replicas')) != str(replicas)
                or rollover_alias != WRITE_ALIAS or WRITE_ALIAS in effective.get('aliases', {})):
            raise RuntimeError('Conflicting effective monitoring template settings or write alias')
    for name, definition in desired['indices'].items():
        if existing[name] is None:
            api('PUT', f'/{name}', definition)
        elif any(field not in existing[name][name]['mappings'].get('properties', {})
                 for field in definition['mappings']['properties']):
            api('PUT', f'/{name}/_mapping', definition['mappings'])
    try:
        api('PUT', f'/{SETTINGS_INDEX}/_create/collection', {'enabled': True})
    except ApiError as error:
        if error.status != 409:
            raise
    if write_index is None:
        api('PUT', f'/{FIRST_INDEX}', {'aliases': {WRITE_ALIAS: {'is_write_index': True}}})
    for name, role in desired['roles'].items():
        api('PUT', f'/_plugins/_security/api/roles/{name}', role)

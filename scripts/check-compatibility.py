#!/usr/bin/env python3
"""Exercise a built plugin on a fresh, disposable, secured OpenSearch/Dashboards pair.

OSD_VERSION selects artifacts/stack-monitoring-VERSION.zip. Set PLAYWRIGHT_MODULE
and optionally NODE_BINARY / PLAYWRIGHT_CHANNEL / PLAYWRIGHT_EXECUTABLE_PATH to
exercise the setup button in Chrome. All Docker resources belong to this run.
"""
import base64
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def docker(*args, input_text=None, timeout=180, check=True):
    result = subprocess.run(['docker', *args], input=input_text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f'Docker {args[0]} failed (exit {result.returncode}); output withheld to protect credentials')
    return result.stdout.strip()


def request(base, path, password, method='GET', body=None, user='admin'):
    headers = {'Authorization': 'Basic ' + base64.b64encode(f'{user}:{password}'.encode()).decode(),
               'osd-xsrf': 'compatibility-check', 'Content-Type': 'application/json'}
    req = urllib.request.Request(base + path, method=method, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    # Only the disposable Docker fixture uses bundled demo certificates.
    context = ssl._create_unverified_context() if base.startswith('https://127.0.0.1:') else None
    try:
        with urllib.request.urlopen(req, context=context, timeout=45) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        return status, None


def wait_for(label, check, seconds=240):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(2)
    raise RuntimeError(f'Timed out waiting for {label}')


def endpoint(container, port, scheme):
    address = docker('port', container, f'{port}/tcp').splitlines()[0]
    require(re.fullmatch(r'127\.0\.0\.1:\d+', address), 'Fixture port was not bound only to loopback')
    return f'{scheme}://{address}'


def private_file(path, text):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
        handle.write(text)


# The secret never leaves the container: only metadata and authorization results do.
CREDENTIAL_CHECK = r'''
const fs = require('fs');
const https = require('https');
(async () => {
  const dir = '/usr/share/opensearch-dashboards/data/stack-monitoring';
  const file = dir + '/collector.json';
  const credential = JSON.parse(fs.readFileSync(file, 'utf8'));
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const request = https.request({hostname:'opensearch',port:9200,rejectUnauthorized:false,
      method,path,auth:credential.username + ':' + credential.password,
      headers:{'content-type':'application/json'}}, response => {
      let text=''; response.on('data',chunk=>text+=chunk);
      response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(text)}));
    });
    request.on('error',reject); request.setTimeout(20000,()=>request.destroy(new Error('timeout')));
    if(body) request.write(JSON.stringify(body)); request.end();
  });
  const account = await call('GET','/_plugins/_security/api/account');
  const denied = await call('PUT','/compatibility-application-probe/_doc/1',{forbidden:true});
  console.log(JSON.stringify({username:credential.username,cluster_uuid:credential.cluster_uuid,
    ready:credential.ready,file_mode:fs.statSync(file).mode & 511,
    directory_mode:fs.statSync(dir).mode & 511,account_status:account.status,
    roles:account.body.roles,application_write_status:denied.status}));
})().catch(()=>{console.error('Credential metadata or authorization check failed');process.exitCode=1;});
'''


def main():
    version = os.environ.get('OSD_VERSION', '')
    require(re.fullmatch(r'\d+\.\d+\.\d+', version), 'Set OSD_VERSION to an exact supported host version')
    artifact = ROOT / 'artifacts' / f'stack-monitoring-{version}.zip'
    require(artifact.is_file(), f'Missing built artifact for {version}')
    with zipfile.ZipFile(artifact) as archive:
        manifest = json.loads(archive.read('opensearch-dashboards/stackMonitoring/opensearch_dashboards.json'))
        require(manifest['opensearchDashboardsVersion'] == version, 'Artifact host version does not match OSD_VERSION')
    require(sys.argv[1:] in ([], ['--check']), 'Only --check is supported')
    if sys.argv[1:] == ['--check']:
        with tempfile.TemporaryDirectory(prefix='stack-compat-check-') as directory:
            file = Path(directory) / 'private.json'
            private_file(file, 'private fixture')
            require(file.stat().st_mode & 0o777 == 0o600, 'Private fixture file permissions are unsafe')
            try:
                private_file(file, 'overwrite')
            except FileExistsError:
                pass
            else:
                raise RuntimeError('Private file helper overwrote an existing file')
            require(file.read_text() == 'private fixture', 'Private fixture file was changed')
        print(f'PASS: {version} artifact identity and private-file checks; Docker fixture was not started')
        return
    prefix = 'stack-compat-' + secrets.token_hex(6)
    node, dashboards = prefix + '-os', prefix + '-dash'
    volumes = [prefix + '-os-data', prefix + '-dash-data']
    image = prefix + ':test'
    password = 'Compat9!' + secrets.token_hex(24)
    denied_password = 'Denied9!' + secrets.token_hex(24)
    print(f'{version}: building isolated plugin image', flush=True)
    with tempfile.TemporaryDirectory(prefix=prefix + '-') as temporary:
        temporary = Path(temporary)
        context = temporary / 'build'
        (context / 'artifacts').mkdir(parents=True)
        shutil.copyfile(artifact, context / 'artifacts/stack-monitoring.zip')
        shutil.copyfile(ROOT / 'docker/Dockerfile.dashboards', context / 'Dockerfile')
        env = temporary / 'opensearch.env'
        private_file(env, f'OPENSEARCH_INITIAL_ADMIN_PASSWORD={password}\n')
        config = temporary / 'opensearch_dashboards.yml'
        config.write_text('''server.host: "0.0.0.0"
server.name: compatibility-dashboards
opensearch.hosts: ["https://opensearch:9200"]
opensearch.ssl.verificationMode: none
opensearch.username: kibanaserver
opensearch.password: kibanaserver
opensearch.requestHeadersAllowlist: [authorization, securitytenant]
opensearch_security.multitenancy.enabled: true
opensearch_security.readonly_mode.roles: [kibana_read_only]
opensearch_security.cookie.secure: false
uiSettings.overrides.defaultRoute: /app/stackMonitoring
''')
        config.chmod(0o644)
        try:
            docker('build', '--build-arg', f'OPENSEARCH_VERSION={version}', '-t', image, str(context), timeout=900)
            docker('network', 'create', prefix)
            for volume in volumes:
                docker('volume', 'create', volume)
            docker('run', '-d', '--name', node, '--network', prefix, '--network-alias', 'opensearch',
                   '--memory', '1536m', '--ulimit', 'memlock=-1:-1', '--ulimit', 'nofile=65536:65536',
                   '-p', '127.0.0.1::9200', '--env-file', str(env),
                   '-e', 'discovery.type=single-node', '-e', 'cluster.name=compatibility-fixture',
                   '-e', 'bootstrap.memory_lock=true', '-e', 'node.store.allow_mmap=false',
                   '-e', 'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
                   '-v', f'{volumes[0]}:/usr/share/opensearch/data',
                   f'opensearchproject/opensearch:{version}', timeout=600)
            os_url = endpoint(node, 9200, 'https')
            def os_api(path, method='GET', body=None):
                return request(os_url, path, password, method, body)
            def healthy():
                code, body = os_api('/_cluster/health')
                return code == 200 and body.get('number_of_data_nodes') == 1 and body.get('status') in ('green', 'yellow')
            wait_for('fresh OpenSearch', healthy, 300)
            cluster_uuid = os_api('/')[1]['cluster_uuid']
            print(f'{version}: starting fresh Dashboards without collector credentials', flush=True)
            docker('run', '-d', '--name', dashboards, '--network', prefix,
                   '--memory', '768m', '-p', '127.0.0.1::5601',
                   '-e', 'NODE_OPTIONS=--max-old-space-size=512',
                   '-v', f'{config}:/usr/share/opensearch-dashboards/config/opensearch_dashboards.yml:ro',
                   '-v', f'{volumes[1]}:/usr/share/opensearch-dashboards/data', image)
            dash_url = endpoint(dashboards, 5601, 'http')
            def dash_api(path, method='GET', body=None):
                return request(dash_url, path, password, method, body)
            def setup_status():
                code, body = dash_api('/api/stack_monitoring/setup')
                return body if code == 200 else None
            before = wait_for('fresh setup endpoint', setup_status, 300)
            require(before['available'] and not before['configured'] and not before['managed'], 'Fresh setup did not offer administrator provisioning')
            code, _ = os_api('/_plugins/_security/api/internalusers/compatibility_denied', 'PUT',
                             {'password': denied_password, 'backend_roles': [], 'opendistro_security_roles': []})
            require(code in (200, 201), 'Unable to create unprivileged fixture identity')
            initial_users = set(os_api('/_plugins/_security/api/internalusers')[1])
            code, _ = request(dash_url, '/api/stack_monitoring/setup', denied_password, 'POST', {}, 'compatibility_denied')
            require(code == 403, 'Unprivileged setup was not denied')
            for path in ['/_index_template/stack-monitoring-v2', '/_index_template/stack-monitoring-insights-v1',
                         '/_plugins/_ism/policies/stack-monitoring-v2-retention', '/_alias/stack-monitoring-write',
                         '/.stack-monitoring-settings', '/.stack-monitoring-locks-v1', '/stack-monitoring-insights-v1',
                         *['/_plugins/_security/api/roles/stack_monitoring_' + role for role in ['collector', 'reader', 'manager']]]:
                require(os_api(path)[0] == 404, 'Denied setup created a managed resource')
            require(set(os_api('/_plugins/_security/api/internalusers')[1]) == initial_users, 'Denied setup created an account')
            docker('exec', dashboards, 'test', '!', '-e', '/usr/share/opensearch-dashboards/data/stack-monitoring/collector.json')
            print(f'{version}: provisioning through ' + ('browser login and setup button' if os.environ.get('PLAYWRIGHT_MODULE') else 'administrator API'), flush=True)
            if os.environ.get('PLAYWRIGHT_MODULE'):
                browser_config = temporary / 'browser.json'
                private_file(browser_config, json.dumps({'base': dash_url, 'password': password}))
                browser = subprocess.run([os.environ.get('NODE_BINARY', 'node'), str(ROOT / 'scripts/check-setup-browser.cjs')],
                                         env={**os.environ, 'SETUP_BROWSER_CONFIG': str(browser_config)},
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=300)
                if browser.returncode:
                    stages = re.findall(r'^FAIL: browser stage ([a-z_]+)$', browser.stderr, re.MULTILINE)
                    stage = stages[-1] if stages else 'launch_or_timeout'
                    causes = re.findall(r'^Browser diagnostic: ([a-z_]+)$', browser.stderr, re.MULTILINE)
                    if causes:
                        print(f'Browser diagnostic: {causes[-1]}', flush=True)
                    raise RuntimeError(f'Browser first-run setup failed at {stage}; credential-bearing diagnostics withheld')
                print(f'{version}: browser setup and populated charts passed', flush=True)
            else:
                def setup():
                    code, body = dash_api('/api/stack_monitoring/setup', 'POST', {})
                    require(code in (200, 409, 503), 'Administrator setup was denied')
                    return code == 200 and body.get('configured')
                wait_for('administrator setup', setup, 180)
            def sample(after=0):
                code, body = dash_api('/api/stack_monitoring/history')
                if code != 200 or not body.get('snapshot'):
                    return None
                snapshot = body['snapshot']
                return body if snapshot['timestamp'] > after and body['collection'].get('last_success') else None
            history = wait_for('first stored sample', sample, 180)
            snapshot = history['snapshot']
            require(snapshot['cluster_uuid'] == cluster_uuid and len(snapshot['nodes']) == 1 and snapshot['instances'], 'Sample does not describe the fresh fixture')
            require(history['series'] and not snapshot['errors'] and not history['collection']['last_error'], 'First sample is incomplete')
            alias = os_api('/_alias/stack-monitoring-write')[1]
            require(len(alias) == 1 and next(iter(alias.values()))['aliases']['stack-monitoring-write']['is_write_index'] is True, 'Expected one explicit write index')
            write_index = next(iter(alias))
            settings = os_api(f'/{write_index}/_settings')[1][write_index]['settings']['index']
            require(settings['number_of_replicas'] == '0', 'Single-node monitoring replica count must be zero')
            policy = os_api('/_plugins/_ism/policies/stack-monitoring-v2-retention')[1]['policy']
            require(policy['states'][0]['transitions'][0]['conditions']['min_rollover_age'] == '7d', 'Default retention policy missing')
            for template_name in ['stack-monitoring-v2', 'stack-monitoring-insights-v1']:
                code, body = os_api('/_index_template/' + template_name)
                require(code == 200, 'Monitoring index template missing')
                template = body['index_templates'][0]['index_template']['template']
                require(str(template['settings']['index']['number_of_replicas']) == '0', 'Single-node template replica count must be zero')
            print(f'{version}: waiting for the automatic retention policy attachment', flush=True)
            def attached():
                code, body = os_api(f'/_plugins/_ism/explain/{write_index}')
                return code == 200 and body.get(write_index, {}).get('policy_id') == 'stack-monitoring-v2-retention'
            wait_for('ISM attachment', attached, 480)
            users = set(os_api('/_plugins/_security/api/internalusers')[1])
            created = users - initial_users
            require(len(created) == 1 and re.fullmatch(r'stack_monitoring_[a-f0-9]{32}', next(iter(created))), 'Setup did not create exactly one generated collector')
            metadata = json.loads(docker('exec', '-i', dashboards, 'node/bin/node', '-', input_text=CREDENTIAL_CHECK))
            require(metadata['file_mode'] == 0o600 and metadata['directory_mode'] == 0o700 and metadata['ready'], 'Managed credential permissions/readiness are invalid')
            require(metadata['cluster_uuid'] == cluster_uuid and metadata['username'] in created, 'Managed identity binding is invalid')
            require(metadata['account_status'] == 200 and metadata['roles'] == ['stack_monitoring_collector'] and metadata['application_write_status'] == 403, 'Collector privileges exceed the scoped role or fail authentication')
            for _ in range(2):
                code, body = dash_api('/api/stack_monitoring/setup', 'POST', {})
                require(code == 200 and body['configured'], 'Repeated setup was not idempotent')
            require(set(os_api('/_plugins/_security/api/internalusers')[1]) == users, 'Repeated setup created another account')
            print(f'{version}: restarting Dashboards with its protected data volume', flush=True)
            last = sample()['snapshot']['timestamp']
            docker('restart', dashboards)
            after = wait_for('fresh collection after restart', lambda: sample(last), 300)
            require(after['collection']['last_success'] > last, 'Collector did not resume after restart')
            restored = json.loads(docker('exec', '-i', dashboards, 'node/bin/node', '-', input_text=CREDENTIAL_CHECK))
            require(restored == metadata, 'Restart changed the protected collector identity or privileges')
            require(set(os_api('/_plugins/_security/api/internalusers')[1]) == users, 'Restart created another collector account')
            print(f'PASS {version}: fresh setup, denied setup, scoped identity, history, retention, idempotency and restart', flush=True)
        finally:
            if sys.exc_info()[0] is not None:
                logs = docker('logs', '--tail', '100', dashboards, check=False)
                for line in logs.splitlines():
                    match = re.search(r'Monitoring setup failed[^\n]*', line)
                    if match:
                        print('Setup diagnostic: ' + match.group(0), file=sys.stderr)
            for container in [dashboards, node]:
                docker('rm', '-f', container, check=False)
            docker('network', 'rm', prefix, check=False)
            for volume in volumes:
                docker('volume', 'rm', volume, check=False)
            docker('image', 'rm', image, check=False)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not echo response bodies, subprocess arguments, or credential-bearing exceptions.
        if isinstance(error, RuntimeError):
            print(f'FAIL: {error}', file=sys.stderr)
        else:
            print(f'FAIL: compatibility check raised {type(error).__name__}; details withheld to protect credentials', file=sys.stderr)
        sys.exit(1)

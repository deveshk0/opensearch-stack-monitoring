#!/usr/bin/env python3
"""Exercise a real incident using a temporary index with one unassignable replica."""
import base64
import json
import os
from pathlib import Path
import runpy
import subprocess
import time
import urllib.error
import urllib.request
import uuid
setup=runpy.run_path(str(Path(__file__).with_name('setup-cluster.py')))
api, env=setup['api'], setup['ENV']

def dashboard(path, user='monitor', key='MONITORING_READER_PASSWORD'):
    headers={} if user is None else {'Authorization':'Basic '+base64.b64encode(f'{user}:{env[key]}'.encode()).decode()}
    try:
        with urllib.request.urlopen(urllib.request.Request('http://localhost:5602'+path,headers=headers),timeout=30) as response:
            return response.status,json.load(response)
    except urllib.error.HTTPError as error:
        return error.code,None

def until(check, seconds=150):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        try:
            result=check()
            if result: return result
        except (OSError,ValueError): pass
        time.sleep(2)
    raise AssertionError('Timed out waiting for incident lifecycle')

def incidents():
    code,body=dashboard('/api/stack_monitoring/insights')
    return body['incidents'] if code==200 else []

path='/api/stack_monitoring/insights'
assert dashboard(path,None)[0]==401
assert dashboard(path,'monitor_denied','MONITORING_DENIED_PASSWORD')[0]==403
assert dashboard(path)[0]==200
assert dashboard(path+'?from=now-48h&to=now')[0]==400
assert dashboard('/api/stack_monitoring/collection')[1]['enabled']
assert api('GET','/_cluster/health')['unassigned_shards']==0,'Test requires initially assigned shards'
initial={i['id'] for i in incidents()}
assert not any(i['status']=='active' and i['rule_id']=='unassigned-shards' for i in incidents()),'Existing shard incident must not be disturbed'
index='monitoring-insights-verification-'+uuid.uuid4().hex[:10]
incident=None
try:
    api('PUT','/'+index,{'settings':{'number_of_shards':1,'number_of_replicas':3}})
    print('Temporary index created; waiting for sustained unassigned-shard finding.',flush=True)
    incident=until(lambda:next((i for i in incidents() if i['id'] not in initial and i['rule_id']=='unassigned-shards' and i['status']=='active'),None))
    assert incident['detected_at']-incident['first_seen']>=60000
    assert len(incident['evidence'])>=3
    print('PASS real sustained detection and persisted evidence',flush=True)
    subprocess.run(['node','scripts/check-insights.cjs'],check=True,env={**os.environ,'INSIGHT_ID':incident['id'],'INSIGHT_STATUS':'active'})
    subprocess.run(['docker','compose','--env-file','.opensearch.env','-f','compose.opensearch.yml','restart','dashboards'],check=True)
    restarted=int(time.time()*1000)
    restored=until(lambda:next((i for i in incidents() if i['id']==incident['id'] and i['last_evaluated']>restarted),None),180)
    assert restored['status']=='active'
    assert len([i for i in incidents() if i['rule_id']=='unassigned-shards' and i['status']=='active'])==1
    print('PASS restart restores the same incident without duplicates',flush=True)
    api('DELETE','/'+index)
    print('Temporary index removed; waiting for sustained recovery.',flush=True)
    resolved=until(lambda:next((i for i in incidents() if i['id']==incident['id'] and i['status']=='resolved'),None))
    assert resolved['resolved_at']>resolved['last_seen']+60000
    subprocess.run(['node','scripts/check-insights.cjs'],check=True,env={**os.environ,'INSIGHT_ID':incident['id'],'INSIGHT_STATUS':'resolved'})
    assert api('GET','/_cluster/health?wait_for_status=green&timeout=30s')['status']=='green'
    print('PASS real recovery, incident history, authorization and green cluster',flush=True)
finally:
    try: api('DELETE','/'+index)
    except RuntimeError as error:
        if 'HTTP 404' not in str(error): raise
    if incident:
        # Wait for the live tracker to release this test incident before deleting its record.
        until(lambda:next((i for i in incidents() if i['id']==incident['id'] and i['status']=='resolved'),None),180)
        api('DELETE','/stack-monitoring-insights-v1/_doc/'+incident['id']+'?refresh=true')

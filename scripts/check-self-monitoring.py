#!/usr/bin/env python3
"""Verify persisted controls and permission boundaries; restore enabled collection."""
import base64
import json
from pathlib import Path
import runpy
import secrets
import subprocess
import time
import urllib.error
import urllib.request

setup=runpy.run_path(str(Path(__file__).with_name('setup-cluster.py')))
api,env=setup['api'],setup['ENV']

def request(method,path,body=None,user='monitor',password=None):
    headers={'osd-xsrf':'collection-test'}
    if user: headers['Authorization']='Basic '+base64.b64encode((user+':'+(password or env['MONITORING_READER_PASSWORD'])).encode()).decode()
    if body is not None: headers['Content-Type']='application/json'
    req=urllib.request.Request('http://localhost:5602'+path,method=method,headers=headers,data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req,timeout=45) as response: return response.status,json.load(response)
    except urllib.error.HTTPError as error: return error.code,None

def latest():
    result=api('POST','/stack-monitoring-v1-*,stack-monitoring-v2-*/_search',{'size':1,'sort':[{'timestamp':'desc'}],'query':{'term':{'type':'cluster'}}})
    return result['hits']['hits'][0]['_source']['timestamp']

path='/api/stack_monitoring/collection'
reader='stack_monitoring_readonly_test'
password='Q8!'+secrets.token_hex(20)
api('PUT','/_plugins/_security/api/internalusers/'+reader,{'password':password,'opendistro_security_roles':['stack_monitoring_reader'],'backend_roles':['kibanauser']})
try:
    assert request('GET',path)[0]==200
    assert request('POST',path,{'enabled':False},user=None)[0]==401
    assert request('POST',path,{'enabled':False},user='monitor_denied',password=env['MONITORING_DENIED_PASSWORD'])[0]==403
    assert request('GET',path,user=reader,password=password)[0]==200
    assert request('POST',path,{'enabled':False},user=reader,password=password)[0]==403
    assert request('POST',path,{'enabled':'yes'})[0]==400
    code,state=request('POST',path,{'enabled':False});assert code==200 and not state['enabled']
    time.sleep(2)
    before=latest();time.sleep(12);assert latest()==before,'Samples continued after disabling'
    subprocess.run(['docker','compose','--env-file','.opensearch.env','-f','compose.opensearch.yml','restart','dashboards'],check=True)
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        try:
            code,state=request('GET',path)
            if code==200:break
        except (OSError,ValueError):pass
        time.sleep(2)
    else:raise AssertionError('Dashboards did not restart')
    assert not state['enabled'] and not state['desired_enabled'],'Disabled state lost across restart'
    assert latest()==before,'Restart ignored disabled setting'
    code,state=request('POST',path,{'enabled':True});assert code==200 and state['enabled'] and state['last_success']>before
    time.sleep(2)
    assert latest()>before,'Enabling did not persist a new sample'
    print('PASS: enable/disable, write authorization, stopped samples, persisted setting across restart, and resumed indexing')
finally:
    request('POST',path,{'enabled':True})
    api('DELETE','/_plugins/_security/api/internalusers/'+reader)

// Execute installed server modules with the deployed collector identity.
const { spawnSync } = require("node:child_process");
const result = spawnSync(
  "docker",
  [
    "compose",
    "--env-file",
    ".opensearch.env",
    "-f",
    "compose.opensearch.yml",
    "exec",
    "-T",
    "dashboards",
    "node/bin/node",
  ],
  {
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    input: String.raw`
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {Client} = require('@opensearch-project/opensearch');
const {CollectorOwnership} = require('./plugins/stackMonitoring/server/ownership');
const {InsightStore} = require('./plugins/stackMonitoring/server/insights');
const client = new Client({nodes:JSON.parse(process.env.OPENSEARCH_HOSTS),auth:{username:'stack_monitoring_collector',password:process.env.MONITORING_COLLECTOR_PASSWORD},ssl:{rejectUnauthorized:false},maxRetries:0,requestTimeout:20000});
(async()=>{
 const index='stack-monitoring-insights-v1',now=Date.now(),cluster='verification-'+randomUUID();
 const fixtures=['old-resolved','old-active','recent-resolved','other-cluster'].map((kind,i)=>({id:cluster+'-'+kind,cluster_uuid:kind==='other-cluster'?cluster+'-other':cluster,rule_id:'unassigned-shards',entity_id:'cluster',entity_name:'Verification',entity_type:'cluster',severity:'warning',status:kind==='old-active'?'active':'resolved',first_seen:now-40*86400000,detected_at:now-40*86400000,last_seen:now-40*86400000,last_evaluated:now-40*86400000,resolved_at:kind==='old-active'?null:now-(kind==='recent-resolved'?1:40)*86400000,value:1,evidence:[]}));
 try {
  const info=await client.info();
  const competitor=new CollectorOwnership(client,'verification-'+randomUUID());
  await assert.rejects(competitor.acquire(info.body.cluster_uuid),/another Dashboards/);
  console.log('PASS: competing collector is blocked by the deployed ownership document');
  const body=fixtures.flatMap(d=>[{index:{_index:index,_id:d.id}},d]);
  assert.equal((await client.bulk({body,refresh:'wait_for'})).body.errors,false);
  const store=new InsightStore(client,30);
  await store.collect({schema:1,timestamp:now,cluster_uuid:cluster,cluster_name:'Verification',cluster:{id:'cluster',type:'cluster',name:'Verification',status:'green',metrics:{},counters:{}},nodes:[],indices:[],pipelines:[],instances:[],shards:[],recoveries:[],errors:[],source_validity:{health:true,nodeStats:true,indexStats:true,shards:true}});
  await assert.rejects(client.get({index,id:fixtures[0].id}),e=>e.statusCode===404);
  for(const fixture of fixtures.slice(1)) assert.equal((await client.get({index,id:fixture.id})).body.found,true);
  console.log('PASS: installed retention deletes old resolved incidents and preserves active, recent and other-cluster incidents');
 } finally {
  for(const fixture of fixtures) await client.delete({index,id:fixture.id}).catch(e=>{if(e.statusCode!==404)throw e});
  await client.close();
 }
})().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1});
`,
  },
);
process.exitCode = result.status ?? 1;

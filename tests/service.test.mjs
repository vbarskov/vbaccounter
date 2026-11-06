import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.mjs';
const now = () => new Date('2026-11-06T10:00:00Z');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vbaccounter-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, service: createService({ stateDir: join(dir, 'state'), now }) };
}
async function company(service) { return (await service.call('vb_create_company', { name: 'ТОО Test', taxRegime: 'unknown' })).account; }
async function obligation(service, accountId, kind = 'filing') {
  return (await service.call('vb_add_obligation', { accountId, title: 'Test filing', authority: 'КГД', period: '2026-Q3', due: '2026-11-10', kind })).obligation;
}
test('filing acceptance and payment require regular evidence, retained privately, with audit', async t => {
  const {dir,service} = await fixture(t); const account = await company(service);
  const filing = await obligation(service, account.id);
  await assert.rejects(service.call('vb_update_obligation', { accountId: account.id, id: filing.id, status: 'accepted' }), /evidencePath|подтвержд/i);
  const receipt = join(dir, 'receipt.txt'); await writeFile(receipt, 'User supplied receipt');
  const link = join(dir, 'link.txt'); await symlink(receipt, link);
  await assert.rejects(service.call('vb_update_obligation', { accountId: account.id, id: filing.id, status: 'accepted', evidencePath: link }), /symbolic|символ|regular|обычн|ELOOP/i);
  const updated = (await service.call('vb_update_obligation', { accountId: account.id, id: filing.id, status: 'accepted', evidencePath: receipt })).obligation;
  assert.equal(updated.lifecycle, 'accepted'); assert.equal(updated.closed, true);
  assert.equal(updated.evidence.verification, 'user-supplied'); assert.ok(updated.evidence.sha256);
  await rm(receipt); assert.equal((await readFile(updated.evidence.path, 'utf8')), 'User supplied receipt');
  assert.equal(updated.history.at(-1).action, 'update-obligation');
  const payment = await obligation(service, account.id, 'payment');
  await assert.rejects(service.call('vb_update_obligation', { accountId: account.id, id: payment.id, status: 'paid' }), /evidencePath|подтвержд/i);
  await assert.rejects(service.call('vb_update_obligation', { accountId: account.id, id: payment.id, status: 'accepted' }), /статус|status/i);
});
test('notifications dedupe, acknowledgment and snooze do not close obligations', async t => {
  const {service} = await fixture(t); const account = await company(service); const ob = await obligation(service, account.id);
  await service.call('vb_notification_settings', { leadDays: [7, 1, 0] });
  let first = await service.call('vb_check_notifications'); assert.ok(first.notifications.some(n => n.obligationId === ob.id));
  assert.equal((await service.call('vb_check_notifications')).notifications.length, 0);
  const item = first.notifications.find(n => n.obligationId === ob.id);
  await service.call('vb_ack_notification', { id: item.id, snoozeUntil: '2026-11-08' });
  assert.equal((await service.call('vb_get_obligation', { accountId: account.id, id: ob.id })).obligation.closed, false);
  assert.equal((await service.call('vb_check_notifications')).notifications.length, 0);
  await service.call('vb_notification_settings', { enabled: false });
  assert.equal((await service.call('vb_check_notifications')).enabled, false);
});
test('connected source remains unchanged, filing legacy completion is not acceptance; source failure surfaces', async t => {
  const {dir,service} = await fixture(t); const path = join(dir, 'source.json');
  const source = {version:6,activeAccountId:'source-company',accounts:[{id:'source-company',name:'Imported',data:{company:{taxRegime:'simplified'},transactions:[],completedObligations:['2026-910-h1-file','2026-910-h1-pay'],reporting:{settings:{},documents:[],reports:[],assignments:[]}}}]};
  const original = JSON.stringify(source); await writeFile(path, original);
  await service.call('vb_connect_workspace', {path});
  const list = await service.call('vb_list_obligations'); const filing = list.obligations.find(o => o.id === '2026-910-h1-file');
  assert.equal(filing.lifecycle, 'needs-data'); assert.equal(filing.closed, false); assert.equal(filing.rulesNeedVerification, true);
  const pay = list.obligations.find(o => o.id === '2026-910-h1-pay'); assert.equal(pay.closed, false); assert.equal(pay.sourceCompletionClaim, true);
  await service.call('vb_update_obligation', {accountId:filing.accountId,id:filing.id,status:'prepared'});
  assert.equal(await readFile(path,'utf8'), original);
  await rm(path); await assert.rejects(service.call('vb_list_obligations'), /source|источник|ENOENT/i);
});
test('source accepted filing requires receipt and demo is excluded', async t => {
  const {dir,service} = await fixture(t); const path = join(dir, 'source.json');
  const data = {company:{taxRegime:'simplified'},transactions:[],reporting:{settings:{},documents:[{id:'receipt',kind:'receipt',name:'receipt.txt',base64:'YQ=='}],reports:[{form:'910.00',period:'2026-H1',status:'accepted',receipt:{status:'accepted',documentId:'receipt'}}],assignments:[]}};
  await writeFile(path,JSON.stringify({version:6,accounts:[{id:'a',name:'Real',data},{id:'d',name:'Demo',isDemo:true,data}]}));
  await service.call('vb_connect_workspace',{path});
  const list = await service.call('vb_list_obligations',{includeClosed:true});
  assert.ok(list.obligations.some(o => o.id==='2026-910-h1-file' && o.closed)); assert.ok(list.obligations.every(o => !o.isDemo));
});
test('invalid inputs and corrupt state fail visibly, concurrent services keep all accounts', async t => {
  const {dir,service} = await fixture(t);
  await assert.rejects(service.call('vb_create_company',{name:'Bad',registrationDate:'2026-02-30'}),/дат|date/i);
  await assert.rejects(service.call('vb_notification_settings',{leadDays:[-1]}),/leadDays|дн/i);
  const sibling = createService({stateDir:join(dir,'state'),now});
  await Promise.all(Array.from({length:8},(_,i)=>(i%2?service:sibling).call('vb_create_company',{name:`Company ${i}`})));
  assert.equal((await service.call('vb_status')).accounts.length,8);
  await writeFile(join(dir,'state','state.json'),'{broken');
  await assert.rejects(service.call('vb_status'),/corrupt|поврежд|JSON/i);
});
test('unknown scope stays actionable until explicit applicability with recorded basis; done updates next action', async t => {
  const {service} = await fixture(t); const account = await company(service);
  const scope = (await service.call('vb_list_obligations')).obligations.find(o=>o.id==='check:tax-scope');
  await assert.rejects(service.call('vb_update_obligation',{accountId:account.id,id:scope.id,status:'done'}),/применим|applicability|unknown/i);
  await assert.rejects(service.call('vb_set_applicability',{accountId:account.id,id:scope.id,applicability:'not-required'}),/основан|basis/i);
  const result=await service.call('vb_set_applicability',{accountId:account.id,id:scope.id,applicability:'not-required',notes:'Проверено бухгалтером: ведём обязательства отдельно'});
  assert.equal(result.obligation.applicability,'not-required');assert.equal(result.obligation.closed,true);assert.ok(result.obligation.provenance.notes);
  const item=(await service.call('vb_add_obligation',{accountId:account.id,title:'Review data',authority:'Company',period:'2026-10',kind:'check',applicability:'unknown',notes:'Need bank data'})).obligation;
  const resolved=(await service.call('vb_set_applicability',{accountId:account.id,id:item.id,applicability:'required',sourceUrl:'https://example.com/assignment',due:'2026-11-10'})).obligation;
  assert.equal(resolved.due,'2026-11-10');assert.equal(resolved.applicability,'required');
  const done=(await service.call('vb_update_obligation',{accountId:account.id,id:item.id,status:'done'})).obligation;
  assert.match(done.nextAction,/выполнен/i);assert.equal(done.history.at(-2).action,'set-applicability');
});
test('personal monthly reminders retain a completed action after done', async t=>{
  const {service}=await fixture(t);const account=await company(service);
  const statement=(await service.call('vb_list_obligations')).obligations.find(o=>o.origin==='personal-reminder');
  assert.ok(statement);
  const done=(await service.call('vb_update_obligation',{accountId:account.id,id:statement.id,status:'done'})).obligation;
  assert.equal(done.closed,true);assert.match(done.nextAction,/выполнен/i);
});
test('deadline and applicability changes notify again, persisted unread history is available separately', async t=>{
  const {service}=await fixture(t); const account=await company(service);
  const item=await obligation(service,account.id);
  const first=(await service.call('vb_check_notifications')).notifications.find(n=>n.obligationId===item.id);assert.ok(first);
  await service.call('vb_set_applicability',{accountId:account.id,id:item.id,applicability:'required',due:'2026-11-11',notes:'Updated assignment deadline'});
  const changed=(await service.call('vb_check_notifications')).notifications.find(n=>n.obligationId===item.id);assert.ok(changed);assert.notEqual(changed.id,first.id);
  const pending=await service.call('vb_list_notifications',{accountId:account.id});assert.ok(pending.notifications.some(n=>n.id===first.id));
  await service.call('vb_ack_notification',{id:first.id});
  assert.ok(!(await service.call('vb_list_notifications',{accountId:account.id})).notifications.some(n=>n.id===first.id));
  assert.ok((await service.call('vb_list_notifications',{accountId:account.id,unreadOnly:false})).notifications.some(n=>n.id===first.id));
  await service.call('vb_set_applicability',{accountId:account.id,id:item.id,applicability:'unknown'});
  assert.ok((await service.call('vb_check_notifications')).notifications.some(n=>n.obligationId===item.id&&n.applicability==='unknown'));
});
test('unfinished monthly checks persist across rollover, while done checks stay done', async t=>{
  const {dir}=await fixture(t);let asOf='2026-11-25T10:00:00Z';const service=createService({stateDir:join(dir,'state'),now:()=>new Date(asOf)});
  const account=(await service.call('vb_create_company',{name:'Payroll',registrationDate:'2026-10-01',hasEmployees:true,taxRegime:'simplified'})).account;
  const october=(await service.call('vb_list_obligations')).obligations.filter(o=>o.origin==='personal-reminder'&&o.period==='2026-10');assert.equal(october.length,3);
  const done=october.find(o=>o.id.endsWith(':statement'));
  await service.call('vb_update_obligation',{accountId:account.id,id:done.id,status:'done'});
  asOf='2026-12-01T10:00:00Z';
  const later=(await service.call('vb_list_obligations')).obligations;
  assert.ok(later.some(o=>o.id===october.find(o=>o.id.endsWith(':salary')).id));assert.ok(!later.some(o=>o.id===done.id));
  assert.equal((await service.call('vb_get_obligation',{accountId:account.id,id:done.id})).obligation.lifecycle,'done');
});
test('one BNS assignment does not prove full selection; unknown staff and registration stay visible',async t=>{
  const {dir,service}=await fixture(t);const account=await company(service);
  let rows=(await service.call('vb_list_obligations')).obligations;
  assert.ok(rows.some(o=>o.id==='check:staff-scope'&&o.applicability==='unknown'));assert.ok(rows.some(o=>o.id==='check:registration-date'&&o.applicability==='unknown'));
  const path=join(dir,'source.json');await writeFile(path,JSON.stringify({version:6,accounts:[{id:'a',name:'Imported',data:{company:{taxRegime:'simplified'},transactions:[],reporting:{documents:[{id:'doc',kind:'respondent'}],reports:[],assignments:[{form:'2-МП',period:'2026-Q3',status:'not-required',reference:'selection result',documentId:'doc'}]}}}]}));
  await service.call('vb_connect_workspace',{path});rows=(await service.call('vb_list_obligations')).obligations;
  assert.ok(rows.some(o=>o.id==='check:bns:2026-Q3'&&o.accountId!==account.id));
});
test('a changed source report reopens stale local acceptance and preserves prior proof', async t=>{
  const {dir,service}=await fixture(t);const path=join(dir,'source.json');
  const report={form:'910.00',period:'2026-H1',status:'sent',submissionRef:'submission-1'};
  const source={version:6,accounts:[{id:'source',name:'Source',data:{company:{taxRegime:'simplified',registrationDate:'2026-01-01',hasEmployees:false},transactions:[],reporting:{documents:[],assignments:[],reports:[report]}}}]};
  await writeFile(path,JSON.stringify(source));await service.call('vb_connect_workspace',{path});
  const item=(await service.call('vb_list_obligations')).obligations.find(o=>o.id==='2026-910-h1-file');
  const receipt=join(dir,'receipt.txt');await writeFile(receipt,'User proof of acceptance');
  await service.call('vb_update_obligation',{accountId:item.accountId,id:item.id,status:'accepted',evidencePath:receipt});
  report.status='rejected';report.receipt={status:'rejected',reference:'rejection-2',date:'2026-11-06'};
  await writeFile(path,JSON.stringify(source));
  const changed=(await service.call('vb_get_obligation',{accountId:item.accountId,id:item.id})).obligation;
  assert.equal(changed.closed,false);assert.equal(changed.lifecycle,'rejected');assert.ok(changed.conflict);assert.ok(changed.previousLocalEvidence?.sha256);
  assert.ok((await service.call('vb_check_notifications')).notifications.some(n=>n.obligationId===item.id&&n.lifecycle==='rejected'));
});
test('unknown applicability remains visible even if imported filing has an accepted receipt',async t=>{
  const {dir,service}=await fixture(t);const path=join(dir,'source.json');
  await writeFile(path,JSON.stringify({version:6,accounts:[{id:'a',name:'Unknown assignment',data:{company:{taxRegime:'general'},transactions:[],reporting:{documents:[{id:'receipt',kind:'receipt'}],assignments:[{form:'2-МП',period:'2026-Q3',status:'unknown'}],reports:[{form:'2-МП',period:'2026-Q3',status:'accepted',receipt:{status:'accepted',documentId:'receipt'}}]}}}]}));
  await service.call('vb_connect_workspace',{path});
  const item=(await service.call('vb_list_obligations')).obligations.find(o=>o.id==='bns:2-МП:2026-Q3');
  assert.ok(item);assert.equal(item.applicability,'unknown');assert.equal(item.closed,false);
  const resolved=(await service.call('vb_set_applicability',{accountId:item.accountId,id:item.id,applicability:'required',notes:'Подтверждено назначение в кабинете'})).obligation;
  assert.equal(resolved.applicability,'required');assert.equal(resolved.lifecycle,'accepted');assert.equal(resolved.closed,true);
});
test('local unknown company profile can be completed, imported profiles remain read only',async t=>{
  const {dir,service}=await fixture(t);const account=await company(service);
  await service.call('vb_update_company',{accountId:account.id,name:'Updated',bin:'123456789012',taxRegime:'simplified',registrationDate:'2026-10-01',hasEmployees:true});
  const rows=(await service.call('vb_list_obligations',{horizonDays:366})).obligations.filter(o=>o.accountId===account.id);
  assert.ok(rows.some(o=>o.id==='2026-200-q4-file'));assert.ok(!rows.some(o=>['check:tax-scope','check:registration-date','check:staff-scope'].includes(o.id)));
  assert.equal((await service.call('vb_status')).accounts.find(a=>a.id===account.id).name,'Updated');
  await assert.rejects(service.call('vb_update_company',{accountId:account.id,registrationDate:'2026-02-30'}),/дат|date/i);
  const other=await company(service);await assert.rejects(service.call('vb_update_company',{accountId:other.id,bin:'123456789012'}),/БИН|BIN/i);
  const path=join(dir,'source.json');await writeFile(path,JSON.stringify({version:6,accounts:[{id:'a',name:'Imported',data:{company:{taxRegime:'unknown'},transactions:[]}}]}));
  const imported=(await service.call('vb_connect_workspace',{path})).accounts[0];
  await assert.rejects(service.call('vb_update_company',{accountId:imported.id,hasEmployees:true}),/read.only|источник|исходн|локальн/i);
});
test('unresolved NB and BNS assignment checks survive a quarter rollover',async t=>{
  const {dir}=await fixture(t);let asOf='2026-12-20T10:00:00Z';
  const service=createService({stateDir:join(dir,'state'),now:()=>new Date(asOf)});
  const account=(await service.call('vb_create_company',{name:'Quarter history',registrationDate:'2026-07-01',hasEmployees:false})).account;
  const first=(await service.call('vb_list_obligations')).obligations;
  assert.ok(first.some(o=>o.id==='nb:2026-Q3:1-ПБ'));assert.ok(first.some(o=>o.id==='check:bns:2026-Q3'));
  asOf='2027-01-01T10:00:00Z';
  const next=(await service.call('vb_list_obligations')).obligations.filter(o=>o.accountId===account.id);
  assert.ok(next.some(o=>o.id==='nb:2026-Q3:1-ПБ'));assert.ok(next.some(o=>o.id==='check:bns:2026-Q3'));
  assert.ok(next.some(o=>o.id==='nb:2026-Q4:1-ПБ'));assert.ok(next.some(o=>o.id==='check:bns:2026-Q4'));
});

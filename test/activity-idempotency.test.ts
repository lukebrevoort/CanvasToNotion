import test from 'node:test';
import assert from 'node:assert/strict';
import type {Client} from '@notionhq/client';
import {projectionActivity,ensureRevisionActivity} from '../src/notion/activity.js';
const revision='11111111-2222-4333-8444-555555555555';
const activity=()=>projectionActivity({assignmentId:42,revision,changedFields:['sub_score','sub_grade','sub_score','description_html'],isNew:false})!;
const block=(id:string,text:string,type='paragraph',extra={})=>({id,type,[type]:{rich_text:[{plain_text:text,text:{content:text}}]},...extra});
const initial=()=>[block('notes','🗒️ Notes','heading_2'),block('note','USER NOTE'),block('nested','USER NESTED','toggle',{has_children:true}),block('activity','🕘 Activity','heading_2'),block('historical','OLD USER ACTIVITY')];
function mock(options:{pageSize?:number;commitThenThrow?:boolean;discardAppend?:boolean;freezeAt?:number;malformedPagination?:boolean}={}) {
 const state={blocks:initial(),appends:0,reads:0,properties:{'Do Not Sync':{type:'checkbox',checkbox:false},Hidden:{type:'checkbox',checkbox:true},'In Progress':{type:'checkbox',checkbox:true}}};
 const client={pages:{retrieve:async()=>{state.reads++;return {id:'page',archived:false,in_trash:false,properties:{...state.properties,'Do Not Sync':{type:'checkbox',checkbox:options.freezeAt!==undefined&&state.reads>=options.freezeAt}}};}},blocks:{children:{
  list:async({start_cursor}:{start_cursor?:string})=>{const n=options.pageSize??100,start=Number(start_cursor??0),end=start+n;return {results:structuredClone(state.blocks.slice(start,end)),has_more:end<state.blocks.length,next_cursor:options.malformedPagination?null:end<state.blocks.length?String(end):null};},
  append:async({children}:{children:any[]})=>{state.appends++;if(!options.discardAppend)state.blocks.push(...children.map((b,i)=>({...structuredClone(b),id:`append-${state.appends}-${i}`})));if(options.commitThenThrow)throw Error('synthetic response loss');return {results:[]};}
 }}} as unknown as Client;
 return {client,state};
}
test('uses the exact existing recovery key and sorted unique changed fields',()=>{
 assert.equal(activity().text,`Canvas recovery [assignment=42;revision=${revision}] changed: sub_grade, sub_score`);
});
test('no Activity for new assignments or description-only changes',()=>{
 for(const spec of [{isNew:true,changedFields:['sub_score']},{isNew:false,changedFields:['description_html','__new__']}])assert.equal(projectionActivity({assignmentId:42,revision,...spec}),null);
});
test('requires stable valid identity before remote work',()=>{
 for(const spec of [{assignmentId:0,revision},{assignmentId:42,revision:''},{assignmentId:42,revision:'timestamp'}])assert.throws(()=>projectionActivity({...spec,changedFields:['sub_score'],isNew:false}));
});
test('sequential replay across complete pagination appends only once and preserves historical content',async()=>{
 const {client,state}=mock({pageSize:2});const before=structuredClone(state);
 assert.equal(await ensureRevisionActivity(client,'page',activity()),'appended');
 assert.equal(await ensureRevisionActivity(client,'page',activity()),'reused');
 assert.equal(state.appends,1);assert.deepEqual(state.blocks.slice(0,before.blocks.length),before.blocks);assert.deepEqual(state.properties,before.properties);
});
test('committed append with lost response is not retried; later projection reuses it',async()=>{
 const {client,state}=mock({commitThenThrow:true});await assert.rejects(ensureRevisionActivity(client,'page',activity()),/response loss/);assert.equal(state.appends,1);
 assert.equal(await ensureRevisionActivity(client,'page',activity()),'reused');assert.equal(state.appends,1);
});
test('existing strict recovery entry is reused',async()=>{
 const {client,state}=mock();state.blocks.push(block('prior-recovery',activity().text));assert.equal(await ensureRevisionActivity(client,'page',activity()),'reused');assert.equal(state.appends,0);
});
test('duplicate same revision entries refuse without deleting either',async()=>{
 const {client,state}=mock();state.blocks.push(block('a',activity().text),block('b',activity().text));const before=structuredClone(state.blocks);await assert.rejects(ensureRevisionActivity(client,'page',activity()),/Duplicate/);assert.equal(state.appends,0);assert.deepEqual(state.blocks,before);
});
test('same revision with different fields refuses',async()=>{
 const {client,state}=mock();state.blocks.push(block('a',activity().text.replace('sub_grade, sub_score','name')));await assert.rejects(ensureRevisionActivity(client,'page',activity()),/Conflicting/);assert.equal(state.appends,0);
});
test('matching marker in Notes is not treated as an Activity receipt',async()=>{
 const {client,state}=mock();state.blocks.splice(1,0,block('a',activity().text));await assert.rejects(ensureRevisionActivity(client,'page',activity()),/Conflicting/);assert.equal(state.appends,0);
});
test('missing Notes or duplicate Activity boundary refuses',async()=>{
 for(const duplicate of [false,true]){const {client,state}=mock();if(duplicate)state.blocks.push(block('dup','🕘 Activity','heading_2'));else state.blocks=state.blocks.filter(b=>b.id!=='notes');await assert.rejects(ensureRevisionActivity(client,'page',activity()),/boundaries/);assert.equal(state.appends,0);}
});
test('missing Activity heading is initialized after existing Notes without modifying content',async()=>{
 const {client,state}=mock();state.blocks=state.blocks.filter(b=>b.id!=='activity');const before=structuredClone(state.blocks);
 assert.equal(await ensureRevisionActivity(client,'page',activity()),'appended');assert.equal(await ensureRevisionActivity(client,'page',activity()),'reused');assert.equal(state.appends,1);assert.deepEqual(state.blocks.slice(0,before.length),before);assert.equal(state.blocks.length,before.length+2);
});
test('lost response after new heading and receipt commit reuses both on later observation',async()=>{
 const {client,state}=mock({commitThenThrow:true});state.blocks=state.blocks.filter(b=>b.id!=='activity');await assert.rejects(ensureRevisionActivity(client,'page',activity()));assert.equal(await ensureRevisionActivity(client,'page',activity()),'reused');assert.equal(state.appends,1);
});
test('malformed pagination and repeated block identities refuse',async()=>{
 const m=mock({pageSize:2,malformedPagination:true});await assert.rejects(ensureRevisionActivity(m.client,'page',activity()),/pagination/);assert.equal(m.state.appends,0);
 const n=mock();n.state.blocks.push(n.state.blocks[0]!);await assert.rejects(ensureRevisionActivity(n.client,'page',activity()),/identity/);assert.equal(n.state.appends,0);
});
test('Do Not Sync respected initially and immediately before append',async()=>{
 for(const freezeAt of [1,2]){const {client,state}=mock({freezeAt});assert.equal(await ensureRevisionActivity(client,'page',activity()),'frozen');assert.equal(state.appends,0);}
});
test('append without matching persisted readback fails without retry',async()=>{
 const {client,state}=mock({discardAppend:true});await assert.rejects(ensureRevisionActivity(client,'page',activity()),/not verified/);assert.equal(state.appends,1);
});
test('legacy timestamp history remains unchanged and is not guessed to be this revision',async()=>{
 const {client,state}=mock();state.blocks.push(block('legacy','2026-11-03 18:56 — changed: sub_grade, sub_score'));const before=structuredClone(state.blocks);await ensureRevisionActivity(client,'page',activity());assert.deepEqual(state.blocks.slice(0,before.length),before);
});
test('different revision receives a separate Activity receipt',async()=>{
 const {client,state}=mock();await ensureRevisionActivity(client,'page',activity());const next=projectionActivity({assignmentId:42,revision:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',changedFields:['sub_score'],isNew:false})!;await ensureRevisionActivity(client,'page',next);assert.equal(state.appends,2);
});

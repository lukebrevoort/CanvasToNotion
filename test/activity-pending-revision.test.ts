import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import Database from 'better-sqlite3';
import type {AssignmentInput} from '../src/store/db.js';
import type {Client} from '@notionhq/client';
import {projectionActivity,ensureRevisionActivity} from '../src/notion/activity.js';
test('unchanged forced projection retains pending revision after committed Activity response loss',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'activity-pending-'));
 const {config}=await import('../src/config.js');config.dbPath=path.join(dir,'test.sqlite');new Database(config.dbPath).close();
 const {db,upsertAssignment,pendingProjectionsForCourse,completeProjection}=await import('../src/store/db.js');
 try {
 db.prepare('INSERT INTO courses(canvas_id,name,active,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)').run(1,'FAKE',1,'2026-01-01','2026-01-01');
 const input:AssignmentInput={canvas_id:42,course_id:1,name:'FAKE',due_at:null,calendar_due_at:null,unlock_at:null,lock_at:null,points_possible:10,description_html:null,submission_types:'[]',group_id:null,group_name:null,group_weight:null,is_quiz:false,position:null,updated_at:null,sub_workflow_state:null,sub_score:null,sub_grade:null,sub_submitted_at:null,sub_graded_at:null,sub_attempts:null,sub_late:null,sub_excused:null,sub_missing:null};
 upsertAssignment(input);completeProjection(pendingProjectionsForCourse(1)[0]!);
 input.sub_score=8;upsertAssignment(input);const before=pendingProjectionsForCourse(1)[0]!;
 const spec=(p:typeof before)=>projectionActivity({assignmentId:p.assignment_id,revision:p.revision,changedFields:JSON.parse(p.changed_fields),isNew:Boolean(p.is_new)})!;
 const b=(id:string,s:string,type='paragraph')=>({id,type,[type]:{rich_text:[{text:{content:s}}]}});
 const blocks:any[]=[b('notes','🗒️ Notes','heading_2'),b('activity','🕘 Activity','heading_2')];let appends=0;
 const client={pages:{retrieve:async()=>({properties:{'Do Not Sync':{type:'checkbox',checkbox:false}}})},blocks:{children:{list:async()=>({results:blocks,has_more:false,next_cursor:null}),append:async({children}:any)=>{appends++;blocks.push(...children.map((x:any)=>({...x,id:'receipt'})));throw Error('committed response lost');}}}} as unknown as Client;
 await assert.rejects(ensureRevisionActivity(client,'page',spec(before)),/response lost/);
 upsertAssignment(input,{forceProjection:true});const forced=pendingProjectionsForCourse(1)[0]!;
 assert.equal(forced.revision,before.revision);assert.equal(forced.force_details,1);assert.equal(forced.changed_fields,before.changed_fields);
 assert.equal(await ensureRevisionActivity(client,'page',spec(forced)),'reused');assert.equal(appends,1);
 input.sub_score=9;upsertAssignment(input);const newer=pendingProjectionsForCourse(1)[0]!;assert.notEqual(newer.revision,before.revision);
 completeProjection(before);assert.equal(pendingProjectionsForCourse(1)[0]!.revision,newer.revision);
 } finally {db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

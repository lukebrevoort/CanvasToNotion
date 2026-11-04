import test from 'node:test';
import assert from 'node:assert/strict';
import { toAssignmentInput } from '../src/sync/assignment-input.js';
import { notionCalendarDate } from '../src/notion/calendar-date.js';

test('portable assignment conversion preserves missing values and empty submission list',()=>{
  const result=toAssignmentInput({id:990000001,course_id:990000002,name:'Dummy'},null,new Map(),null);
  assert.equal(result.canvas_id,990000001);assert.equal(result.name,'Dummy');
  assert.equal(result.description_html,null);assert.equal(result.submission_types,'[]');assert.equal(result.sub_score,null);assert.equal(result.group_weight,null);
});
test('portable conversion preserves zero scores, false flags, group weight and source dates',()=>{
  const due='2026-11-03T23:59:59Z';
  const result=toAssignmentInput({id:990000001,course_id:990000002,name:'Dummy quiz',due_at:due,points_possible:0,assignment_group_id:7,submission_types:['online_quiz'],is_quiz_assignment:true},{assignment_id:990000001,score:0,grade:'0',attempt:0,late:false,excused:false,missing:false},new Map([[7,{name:'Quizzes',weight:0.2}]]),'America/New_York');
  assert.equal(result.sub_score,0);assert.equal(result.sub_grade,'0');assert.equal(result.sub_attempts,0);assert.equal(result.sub_late,false);assert.equal(result.points_possible,0);assert.equal(result.group_weight,0.2);assert.equal(result.is_quiz,true);assert.equal(result.due_at,due);assert.equal(result.calendar_due_at,notionCalendarDate(due,'America/New_York'));
});
test('portable conversion leaves inputs untouched',()=>{
  const a={id:990000001,course_id:990000002,name:'Dummy',submission_types:['online_upload']};const before=structuredClone(a);
  const result=toAssignmentInput(a,null,new Map(),null);assert.deepEqual(a,before);assert.equal(result.submission_types,'["online_upload"]');
});

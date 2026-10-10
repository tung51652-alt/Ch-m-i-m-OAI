"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
global.window = globalThis;
require('./site/grader.js');
require('./site/ghost-grader.js');
const truth = { ids: ['a','b'], labels: ['200','400'], text_lengths: [1000,2000] };
const sub = (a,b) => ({ columns:['id','boundary_char_index'], rows:[{id:'b',boundary_char_index:b},{id:'a',boundary_char_index:a}] });
test('Ghost scores match exponential decay, align by ID and report aggregate metrics',()=>{
  assert.equal(OAIGhostGrader.grade(sub(200,400),truth).score,100);
  const result=OAIGhostGrader.grade(sub(225,500),truth);
  assert.ok(Math.abs(result.score-50*(Math.exp(-.25)+Math.exp(-1)))<1e-12);
  assert.equal(result.secondary_metrics['Mean Absolute Error (chars)'],62.5);
  assert.equal(result.secondary_metrics['Exact Match (%)'],0);
});
test('Ghost rejects missing, duplicate, unknown IDs and invalid boundaries',()=>{
  for(const value of [-1,1001,1.5,true,null,'','NaN','Infinity','1.0','1e2',[],{}]){
    assert.equal(OAIGhostGrader.grade(sub(value,400),truth).valid,false);
  }
  for(const id of ['b','unknown','',null]){
    const input=sub(200,400);input.rows[1].id=id;
    assert.equal(OAIGhostGrader.grade(input,truth).valid,false);
  }
  const input=sub(200,400);input.rows.pop();
  assert.equal(OAIGhostGrader.grade(input,truth).valid,false);
});
test('Ghost JSONL and CSV support Unicode IDs, integer endpoints and reject malformed records',async()=>{
  const frame=OAIGrader.parseJsonl('\ufeff\n{"id":"a","boundary_char_index":200}\n{"id":"b","boundary_char_index":400}\n');
  assert.equal(OAIGhostGrader.grade(frame,truth).score,100);
  assert.equal(OAIGhostGrader.grade(OAIGrader.parseCsv('id,boundary_char_index\na,200\nb,400\n','output.csv'),truth).score,100);
  const file=new Blob(['{"id":"a","boundary_char_index":200}\n{"id":"b","boundary_char_index":400}']);file.name='answers.jsonl';
  assert.equal(OAIGhostGrader.grade(await OAIGrader.readSubmission(file),truth).score,100);
  for(const value of ['broken','[]','{}','{"id":"a"}','{"id":null,"boundary_char_index":1}',' \n'])assert.throws(()=>OAIGrader.parseJsonl(value));
  assert.equal(OAIGhostGrader.grade(sub('0','2000'),truth).valid,true);
  const unicodeTruth={ids:['😀'],labels:['2'],text_lengths:[3]};
  assert.equal(OAIGhostGrader.grade({columns:['id','boundary_char_index'],rows:[{id:'😀',boundary_char_index:2}]},unicodeTruth).score,100);
  assert.equal(OAIGhostGrader.grade({columns:['id','boundary_char_index'],rows:[{id:'😀',boundary_char_index:4}]},unicodeTruth).valid,false);
});

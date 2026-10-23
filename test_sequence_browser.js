'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
global.window=globalThis;require('./site/grader.js');require('./site/sequence-grader.js');
const frame=rows=>({columns:['id','text'],rows});
test('sequence metrics preserve Unicode, LaTeX text spaces and clip CER per sample',()=>{
 const t={ids:['a','b'],labels:['Hôm nay','😀']};
 let r=OAISequenceGrader.grade(frame([{id:'b',text:'😀'},{id:'a',text:'Hôm  nay'}]),t,'text_restoration');assert.equal(r.score,100);assert.equal(r.secondary_metrics.WER,0);
 r=OAISequenceGrader.grade(frame([{id:'b',text:'abcdef'},{id:'a',text:'Hôm nay'}]),t,'text_restoration');assert.equal(r.score,50);
 const m={ids:['a'],labels:['\\text{ab}']};assert.ok(OAISequenceGrader.grade(frame([{id:'a',text:'\\text{a b}'}]),m,'latex_recognition').score<100);
 assert.deepEqual(OAISequenceGrader.tokens('\\frac{a}{b}'),['\\frac','{','a','}','{','b','}']);
});
test('reject missing/duplicate/extra IDs, empty predictions, extra/reversed columns; preserve literal NA',()=>{
 const truth={ids:['a','b'],labels:['NA','x']};
 const p=OAIGrader.parseCsv('id,text\na,NA\nb,x\n','submission.csv',{preserveStrings:true,strictFields:true});assert.equal(OAISequenceGrader.grade(p,truth,'text_restoration').score,100);
 for(const rows of [[{id:'a',text:'x'}],[{id:'a',text:'x'},{id:'a',text:'x'}],[{id:'z',text:'x'},{id:'b',text:'x'}],[{id:'a',text:' '},{id:'b',text:'x'}]])assert.equal(OAISequenceGrader.grade(frame(rows),truth,'text_restoration').valid,false);
 assert.equal(OAISequenceGrader.grade({...p,columns:['text','id']},truth,'text_restoration').valid,false);
 assert.throws(()=>OAIGrader.parseCsv('id,text\na\n','x.csv',{strictFields:true}));
});

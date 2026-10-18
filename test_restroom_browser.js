"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
global.window=globalThis;
require('./site/grader.js');require('./site/restroom-grader.js');
const truth={ids:Array.from({length:10},(_,i)=>String(i+1)),labels:Array.from({length:10},(_,i)=>String(i+1))};
function npy(values,{dtype='<i8',version=1,shape=`(${values.length},)`,order='False'}={}) {
  const header=Buffer.from(`{'descr': '${dtype}', 'fortran_order': ${order}, 'shape': ${shape}, }\n`);
  const start=version===1?10:12, size=Number(dtype.slice(2)), kind=dtype[1], little=dtype[0]!=='>';
  const result=Buffer.alloc(start+header.length+values.length*size);
  result.set([0x93,78,85,77,80,89,version,0]);
  if(version===1)result.writeUInt16LE(header.length,8);else result.writeUInt32LE(header.length,8);
  result.set(header,start);
  const view=new DataView(result.buffer,result.byteOffset,result.byteLength);
  const methods={i:{1:'setInt8',2:'setInt16',4:'setInt32',8:'setBigInt64'},u:{1:'setUint8',2:'setUint16',4:'setUint32',8:'setBigUint64'},f:{4:'setFloat32',8:'setFloat64'}};
  values.forEach((value,i)=>view[methods[kind][size]](start+header.length+i*size,kind!=='f'&&size===8?BigInt(value):value,little));
  return result;
}
const ones=Array(10).fill(1),perfect=Array.from({length:10},(_,i)=>i+1);
test('Restroom native NPY integer/float/endian/version variants match official Precision@1',()=>{
  for(const dtype of ['|i1','|u1','<i2','>i2','<u4','>u4','<i8','>i8','<u8','>u8','<f4','>f4','<f8','>f8']) {
    for(const version of [1,2,3]){
      const sub=OAIRestroomGrader.parseNpy(npy(perfect,{dtype,version}),'public');
      assert.equal(OAIRestroomGrader.grade(sub,truth,'public').score,1);
    }
  }
  const sub=OAIRestroomGrader.parseNpy(npy(perfect),'public');
  sub.rows.slice(0,3).forEach(r=>r.gallery_id='20');
  const result=OAIRestroomGrader.grade(sub,truth,'public');
  assert.equal(result.valid,true);assert.equal(result.score,.7);
  assert.deepEqual(result.secondary_metrics,{'Correct Matches':7,'Total Queries':10});
  assert.equal(OAIRestroomGrader.grade(OAIRestroomGrader.parseNpy(npy(ones),'public'),truth,'public').score,.1);
});
test('Restroom rejects invalid NPY dtype, shape, length and gallery IDs',()=>{
  for(const shape of ['(10,1)','(1,10)','()','(1000000000000,)'])assert.throws(()=>OAIRestroomGrader.parseNpy(npy(ones,{shape}),'public'));
  for(const value of [0,-1,21,NaN,Infinity,1.5])assert.throws(()=>OAIRestroomGrader.parseNpy(npy(Array(10).fill(value),{dtype:'<f8'}),'public'));
  const object=npy(ones);object.write('|O8',object.indexOf('<i8'));assert.throws(()=>OAIRestroomGrader.parseNpy(object,'public'));
  const bytes=npy(ones);
  for(const raw of [Buffer.alloc(0),Buffer.from('garbage'),bytes.subarray(0,bytes.length-1),Buffer.concat([bytes,Buffer.from('extra')])])assert.throws(()=>OAIRestroomGrader.parseNpy(raw,'public'));
});
test('Restroom CSV aligns by query ID; rejects missing/duplicate/unknown queries and invalid galleries',()=>{
  const sub=OAIGrader.parseCsv('query_id,gallery_id\n'+perfect.map(i=>`${i},${i}`).reverse().join('\n'),'output.csv');
  assert.equal(OAIRestroomGrader.grade(sub,truth,'public').score,1);
  for(const id of ['1','11','']){
    const copy=structuredClone(sub);copy.rows[0].query_id=id;
    assert.equal(OAIRestroomGrader.grade(copy,truth,'public').valid,false);
  }
  for(const value of ['0','21','1.5','1e1','NaN','inf','True','']){
    const copy=structuredClone(sub);copy.rows[0].gallery_id=value;
    assert.equal(OAIRestroomGrader.grade(copy,truth,'public').valid,false);
  }
  const missing=structuredClone(sub);missing.rows.pop();assert.equal(OAIRestroomGrader.grade(missing,truth,'public').valid,false);
});
test('Restroom native file reading selects correct A/B file names',async()=>{
  const file=new Blob([npy(perfect)]);file.name='submission_a.npy';
  assert.equal((await OAIRestroomGrader.readSubmission(file,'public')).rows.length,10);
  await assert.rejects(()=>OAIRestroomGrader.readSubmission(file,'private'));
  file.name='output.txt';await assert.rejects(()=>OAIRestroomGrader.readSubmission(file,'public'));
});

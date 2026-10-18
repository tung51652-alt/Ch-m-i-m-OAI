/* Chromium smoke of Restroom native .npy, both-file ZIP selection and saved form. */
"use strict";
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const {pbkdf2Sync,createDecipheriv}=require('node:crypto');
const {execFileSync}=require('node:child_process');
function npy(values) {
  const header=Buffer.from(`{'descr': '<f8', 'fortran_order': False, 'shape': (${values.length},), }\n`);
  const bytes=Buffer.alloc(10+header.length+8*values.length);
  bytes.set([0x93,78,85,77,80,89,1,0]);bytes.writeUInt16LE(header.length,8);bytes.set(header,10);
  values.forEach((v,i)=>bytes.writeDoubleLE(v,10+header.length+i*8));return bytes;
}
async function main(){
  const base=process.env.SITE_URL,password=process.env.GRADER_PASSWORD;
  if(!base||!password)throw new Error('SITE_URL and GRADER_PASSWORD required');
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const envelope=await(await fetch(new URL('leaderboard.json?smoke='+Date.now(),base))).json();assert.equal(envelope.encrypted,true);
    const key=pbkdf2Sync(password,Buffer.from(envelope.salt,'base64'),envelope.iterations,32,'sha256');
    const encrypted=Buffer.from(envelope.data,'base64');const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decipher.setAuthTag(encrypted.subarray(-16));
    const data=JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]).toString('utf8'));
    const a=data.ground_truth.restroom.public.labels.map(Number),b=data.ground_truth.restroom.private.labels.map(Number);
    const zip=execFileSync(process.env.PYTHON||'python3',['-c','import io,sys,zipfile,json,base64; d=json.load(sys.stdin); b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); [z.writestr("nested/"+name,base64.b64decode(raw)) for name,raw in d.items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],{input:JSON.stringify({'submission_a.npy':npy(a).toString('base64'),'submission_b.npy':npy(b).toString('base64')})});
    await page.goto(base);await page.fill('#login-pw',password);await page.click('#login-btn');await page.locator('#task').waitFor({state:'visible'});
    await page.selectOption('#task','restroom');await page.selectOption('#team',data.teams[0]);
    assert.match(await page.locator('#metric-card').innerText(),/Precision@1/);
    assert.match(await page.locator('#req-card').innerText(),/328/);
    const grade=async(buffer,name)=>{
      await page.setInputFiles('#file',{name,mimeType:'application/octet-stream',buffer});await page.click('#submit-btn');
      await page.waitForFunction(()=>!document.getElementById('submit-btn').disabled);
    };
    for(const [split,letter,values] of [['public','a',a],['private','b',b]]){
      await page.selectOption('#split',split);
      await grade(npy(values),`submission_${letter}.npy`);assert.equal(await page.locator('#result .score').innerText(),'1.000000');
      assert.match(await page.locator('#result').innerText(),/Correct Matches/);
      assert.match(await page.locator('#result').innerText(),/Total Queries/);
      const save=new URL(await page.locator('#result .save-box a').getAttribute('href'));
      assert.equal(save.searchParams.get('task'),'Tác vụ 5 — Computer Vision: Restroom Icon Matching');
      assert.equal(save.searchParams.get('split'),split==='public'?'Public Test':'Private Test');
      await grade(zip,'submission.zip');assert.equal(await page.locator('#result .score').innerText(),'1.000000');
      const csv='query_id,gallery_id\n'+values.map((v,i)=>`${i+1},${v}`).reverse().join('\n');
      await grade(Buffer.from(csv),'output.csv');assert.equal(await page.locator('#result .score').innerText(),'1.000000');
      await grade(npy(values.slice(1)),`submission_${letter}.npy`);assert.equal(await page.locator('#result .bad').count(),1);
      await grade(npy(Array(values.length).fill(0)),`submission_${letter}.npy`);assert.equal(await page.locator('#result .bad').count(),1);
      console.log(`${split}: NPY/CSV/ZIP perfect=1, both-file ZIP selects correct split, malformed/zero-based NPY rejected, GitHub form prefilled.`);
    }
    await page.selectOption('#split','public');
    const partial=[...a];for(let i=0;i<3;i++)partial[i]=partial[i]%20+1;
    await grade(npy(partial),'submission_a.npy');assert.equal(await page.locator('#result .score').innerText(),'.700000'.replace(/^\./,'0.'));
    await page.click('#tabs button[data-view="rank"]');assert.equal(await page.locator('#board-restroom').count(),1);
    await page.click('#tabs button[data-view="submit"]');
    if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);console.log('Restroom Pages smoke PASS.');
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

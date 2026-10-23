/* End-to-end browser check. Answers/password never leave memory or enter logs. */
'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const {pbkdf2Sync,createDecipheriv}=require('node:crypto');
const {execFileSync}=require('node:child_process');
async function main(){
 const base=process.env.SITE_URL,password=process.env.GRADER_PASSWORD;
 if(!base||!password)throw new Error('SITE_URL and GRADER_PASSWORD required');
 const response=await fetch(new URL('leaderboard.json',base));assert.equal(response.ok,true);
 const envelope=await response.json();assert.equal(envelope.encrypted,true);
 const encrypted=Buffer.from(envelope.data,'base64'),decipher=createDecipheriv('aes-256-gcm',pbkdf2Sync(password,Buffer.from(envelope.salt,'base64'),envelope.iterations,32,'sha256'),Buffer.from(envelope.iv,'base64'));
 decipher.setAuthTag(encrypted.subarray(-16));
 const data=JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]).toString());
 assert.ok(!data.tasks.some(t=>t.key==='bana'));
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH,args:JSON.parse(process.env.CHROMIUM_ARGS||'[]')}:{})});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.fill('#login-pw',password);await page.click('#login-btn');await page.locator('#task').waitFor({state:'visible'});
  await page.selectOption('#team',data.teams[0]);
  for(const task of ['math_ocr','vietnamese_restoration']){
   await page.selectOption('#task',task);
   for(const split of ['public','private']){
    await page.selectOption('#split',split);
    const truth=data.ground_truth[task][split];assert.ok(truth.ids.length>700);
    assert.match(await page.locator('#req-card').innerText(),/id,text/);
    assert.equal(await page.locator('#req-card a[download="submission.csv"]').count(),1);
    const buffer=execFileSync(process.env.PYTHON||'python3',['-c','import csv,io,json,sys; d=json.load(sys.stdin); f=io.StringIO(); w=csv.writer(f); w.writerow(["id","text"]); w.writerows(reversed(list(zip(d["ids"],d["labels"])))); sys.stdout.buffer.write(f.getvalue().encode())'],{input:JSON.stringify(truth)});
    async function grade(bytes,name){await page.setInputFiles('#file',{name,mimeType:'application/octet-stream',buffer:bytes});await page.click('#submit-btn');await page.waitForFunction(()=>!document.querySelector('#submit-btn').disabled);}
    await grade(buffer,'submission.csv');assert.equal(await page.locator('#result .score').innerText(),'100.000000');
    const link=new URL(await page.locator('#result .save-box a').getAttribute('href'));assert.match(link.searchParams.get('task'),task==='math_ocr'?/Mathematical Expression/:/Vietnamese Noisy/);assert.equal(link.searchParams.get('split'),split==='public'?'Public Test':'Private Test');
    const zipped=execFileSync(process.env.PYTHON||'python3',['-c','import io,zipfile,sys; f=io.BytesIO(); z=zipfile.ZipFile(f,"w"); z.writestr("nested/submission.csv",sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(f.getvalue())'],{input:buffer});
    await grade(zipped,'submission.zip');assert.equal(await page.locator('#result .score').innerText(),'100.000000');
    await grade(Buffer.from('id,text\nmissing_id,x\n'),'submission.csv');assert.equal(await page.locator('#result .bad').count(),1);
    const sample=await (await fetch(new URL(`${task}/sample_submission_${split}.csv`,base))).text();await grade(Buffer.from(sample),'submission.csv');assert.equal(await page.locator('#result .bad').count(),0);
    console.log(`${task}/${split}: perfect CSV/ZIP=100, invalid IDs rejected, real sample accepted, save form correct`);
   }
  }
  await page.click('#tabs button[data-view="rank"]');for(const task of ['math_ocr','vietnamese_restoration'])assert.equal(await page.locator('#board-'+task).count(),1);
  assert.deepEqual(errors,[]);console.log('Sequence Pages smoke PASS; Ba Na absent.');
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

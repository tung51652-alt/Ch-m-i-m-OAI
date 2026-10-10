/* Chromium smoke for the encrypted Ghost grading UI. Never logs answers or passwords. */
"use strict";
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { pbkdf2Sync, createDecipheriv } = require("node:crypto");
const { execFileSync } = require("node:child_process");
async function main() {
  const base=process.env.SITE_URL, password=process.env.GRADER_PASSWORD;
  if(!base || !password) throw new Error("SITE_URL and GRADER_PASSWORD required");
  const browser=await chromium.launch({headless:true, ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH}: {})});
  try {
    const context=await browser.newContext();
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const envelope=await (await fetch(new URL('leaderboard.json',base))).json();
    assert.equal(envelope.encrypted,true);
    const key=pbkdf2Sync(password,Buffer.from(envelope.salt,'base64'),envelope.iterations,32,'sha256');
    const encrypted=Buffer.from(envelope.data,'base64');
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
    decipher.setAuthTag(encrypted.subarray(-16));
    const payload=JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]).toString('utf8'));
    // Link appears after authentication and navigates directly to the separate chatbot.
    await page.goto(base);
    assert.equal(await page.locator('#chat-link').isVisible(),false);
    await page.fill('#login-pw',password);await page.click('#login-btn');
    await page.locator('#task').waitFor({state:'visible'});
    assert.equal(await page.locator('#chat-link').getAttribute('href'),'https://chatbot-gamma-plum-29.vercel.app/');
    await page.selectOption('#task','ghost');await page.selectOption('#team',payload.teams[0]);
    assert.match(await page.locator('#req-card').innerText(),/Leaderboard A/);
    assert.match(await page.locator('#metric-card').innerText(),/Boundary Score/);
    for (const split of ['public','private']) {
      await page.selectOption('#split',split);
      const truth=payload.ground_truth.ghost[split];assert.equal(truth.ids.length,380);
      const raw=truth.ids.map((id,i)=>JSON.stringify({id,boundary_char_index:Number(truth.labels[i])})).reverse().join('\n');
      async function grade(buffer,name='answers.jsonl') {
        await page.setInputFiles('#file',{name,mimeType:'application/octet-stream',buffer});
        await page.click('#submit-btn');
        await page.waitForFunction(()=>!document.getElementById('submit-btn').disabled);
      }
      await grade(Buffer.from(raw));
      assert.equal(await page.locator('#result .score').innerText(),'100.000000');
      assert.match(await page.locator('#result').innerText(),/Mean Absolute Error/);
      assert.match(await page.locator('#result').innerText(),/Exact Match/);
      const saveUrl=new URL(await page.locator('#result .save-box a').getAttribute('href'));
      assert.equal(saveUrl.searchParams.get('task'),'Tác vụ 4 — NLP: Ghost of the Machine');
      assert.equal(saveUrl.searchParams.get('split'),split==='public'?'Public Test':'Private Test');
      const csv='id,boundary_char_index\n'+truth.ids.map((id,i)=>`${id},${truth.labels[i]}`).join('\n');
      await grade(Buffer.from(csv),'output.csv');
      assert.equal(await page.locator('#result .score').innerText(),'100.000000');
      const zip=execFileSync(process.env.PYTHON || 'python3',['-c','import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("nested/answers.jsonl",sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(b.getvalue())'],{input:raw});
      await grade(zip,'prediction.zip');
      assert.equal(await page.locator('#result .score').innerText(),'100.000000');
      await grade(Buffer.from(raw.split('\n').slice(1).join('\n')));
      assert.equal(await page.locator('#result .bad').count(),1);
      console.log(`${split}: perfect JSONL/CSV/ZIP = 100, shuffled IDs aligned, missing ID rejected, GitHub form prefilled.`);
    }
    await page.click('#tabs button[data-view="rank"]');
    assert.equal(await page.locator('#board-ghost').count(),1);
    assert.deepEqual(errors,[]);
    if(process.env.SCREENSHOT_PATH) {
      await page.click('#tabs button[data-view="submit"]');
      await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
    }
    console.log('Ghost Pages smoke PASS.');
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

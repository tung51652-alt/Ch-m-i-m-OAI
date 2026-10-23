/* Matches the released Python score.py tools, including Unicode code points. */
(function () {
  'use strict';
  const ws = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
  const trim = x => x.replace(new RegExp(`^${ws}+|${ws}+$`, 'gu'), '');
  function normalize(x, kind) {
    x = x.normalize('NFC');
    return trim(kind === 'latex_recognition' ? x : x.replace(new RegExp(`${ws}+`, 'gu'), ' '));
  }
  function tokens(x) { return x.match(/\\[a-zA-Z]+|\\[^a-zA-Z]|[\s\S]/gu) || []; }
  function distance(a, b) {
    if (a.length > b.length) [a,b]=[b,a];
    let previous=Array.from({length:a.length+1},(_,i)=>i);
    for(let j=1;j<=b.length;j++) {
      const current=[j];
      for(let i=1;i<=a.length;i++) current[i]=Math.min(current[i-1]+1,previous[i]+1,previous[i-1]+(a[i-1]===b[j-1]?0:1));
      previous=current;
    }
    return previous[a.length];
  }
  function grade(sub, truth, kind) {
    if (!['latex_recognition','text_restoration'].includes(kind)) throw new Error('Unknown sequence metric');
    const checked={columns:sub.columns,rows:sub.rows.map(r=>({...r,text:typeof r.text==='string'&&trim(r.text)?'prediction':null}))};
    const result={...OAIGrader.validate(checked,truth,'id','text',{validateLabelDomain:false,rejectExtraColumns:true}),
      score:null,metric_name:kind==='latex_recognition'?'Normalized LaTeX Token Edit Similarity':'Clipped CER Similarity',secondary_metrics:null};
    if(sub.columns.join(',')!=='id,text') {result.valid=false;result.errors.push('Cần đúng header id,text theo thứ tự.');}
    if(sub.rows.some(r=>typeof r.id!=='string'||typeof r.text!=='string')) {result.valid=false;result.errors.push('ID và prediction phải là chuỗi.');}
    if(!result.valid)return result;
    const pred=new Map(sub.rows.map(r=>[r.id,r.text]));let sum=0,exact=0,wordErrors=0,wordCount=0;
    truth.ids.forEach((id,i)=>{
      const p=normalize(pred.get(id),kind),y=normalize(truth.labels[i],kind);
      const a=kind==='latex_recognition'?tokens(p):Array.from(p),b=kind==='latex_recognition'?tokens(y):Array.from(y);
      const d=distance(a,b);
      sum+=1-(kind==='latex_recognition'?d/Math.max(a.length,b.length,1):Math.min(1,d/Math.max(b.length,1)));
      exact+=d===0?1:0;
      if(kind==='text_restoration') {const pw=p.split(' '),yw=y.split(' ');wordErrors+=distance(pw,yw);wordCount+=yw.length;}
    });
    result.score=100*sum/truth.ids.length;
    result.secondary_metrics={'Exact Match (%)':100*exact/truth.ids.length};
    if(kind==='text_restoration')result.secondary_metrics.WER=wordErrors/wordCount;
    return result;
  }
  window.OAISequenceGrader={grade,normalize,tokens,distance};
})();

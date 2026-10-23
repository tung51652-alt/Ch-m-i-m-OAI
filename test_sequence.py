import importlib.util,json,subprocess,unittest
from pathlib import Path
import pandas as pd
from scoring import grade_submission,read_submission,TASKS
from sequence_scoring import score
from leaderboard import task_requirements,task_splits,ranking_split,export_site_data

class SequenceTests(unittest.TestCase):
    def test_metrics_and_validation(self):
        truth=pd.DataFrame({'id':['a','b'],'text':['Hôm nay','😀']})
        pred=pd.DataFrame({'id':['b','a'],'text':['😀','Hôm  nay']})
        self.assertEqual(score(pred,truth,'text_restoration')['score'],100)
        pred.loc[0,'text']='abcdef'
        self.assertEqual(score(pred,truth,'text_restoration')['score'],50)
        for p in [pred.iloc[:1],pd.DataFrame({'id':['a','a'],'text':['x','x']}),pd.DataFrame({'id':['a','z'],'text':['x','x']}),pd.DataFrame({'id':['a','b'],'text':[' ','x']})]:
            self.assertFalse(score(p,truth,'text_restoration')['valid'])
    def test_task_contract_without_labels_in_public_metadata(self):
        for task in ['math_ocr','vietnamese_restoration']:
            r=task_requirements(task)
            self.assertEqual(r['columns'],['id','text']);self.assertIsNone(r['labels'])
            self.assertEqual(task_splits(task),['public','private']);self.assertEqual(ranking_split(task),'private')
        self.assertNotIn('bana',[x['key'] for x in export_site_data([])['tasks']])
    def test_python_javascript_parity(self):
        fixtures=[['latex_recognition',[r'\frac{a}{b}',r'\text{a b}','😀'],[r'\frac{a}{c}',r'\text{ab}','😃']],['text_restoration',['Hôm nay','😀','NA','x\u0085y'],['Hôm  nay','abcdef','NA','x y']]]
        js="global.window=globalThis;require('./site/grader.js');require('./site/sequence-grader.js');const [kind,ys,ps]=JSON.parse(process.argv[1]);console.log(JSON.stringify(OAISequenceGrader.grade({columns:['id','text'],rows:ps.map((text,i)=>({id:String(i),text}))},{ids:ys.map((_,i)=>String(i)),labels:ys},kind)));"
        for kind,ys,ps in fixtures:
            py=score(pd.DataFrame({'id':list(map(str,range(len(ps)))),'text':ps}),pd.DataFrame({'id':list(map(str,range(len(ys)))),'text':ys}),kind)
            browser=json.loads(subprocess.check_output(['node','-e',js,json.dumps([kind,ys,ps])]))
            self.assertAlmostEqual(py['score'],browser['score'],12)
            self.assertEqual(py['secondary_metrics'],browser['secondary_metrics'])
if __name__=='__main__':unittest.main()

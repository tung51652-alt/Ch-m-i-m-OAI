"""Boundary metric, JSONL transport, split routing and prediction validation."""
from dataclasses import replace
from io import BytesIO
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import pandas as pd

from ghost_scoring import load_truth, score
from scoring import TASKS, SubmissionReadError, grade_submission, read_submission
from leaderboard import ACTIVE_TASKS, build_leaderboard, task_requirements, task_splits
from scripts.grade_issue import resolve_task_split, find_attachment


class Upload(BytesIO):
    def __init__(self, data, name='answers.jsonl'):
        super().__init__(data)
        self.name = name


class GhostTests(unittest.TestCase):
    def setUp(self):
        self.truth = pd.DataFrame({'id':['a','b'], 'boundary_char_index':[200,400], 'text_length':[1000,2000]})
        self.pred = self.truth[['id','boundary_char_index']].copy()

    def test_metric_scale_and_alignment(self):
        self.assertEqual(score(self.pred.iloc[::-1], self.truth)['score'],100)
        self.pred['boundary_char_index'] = [225,500]
        result=score(self.pred,self.truth)
        self.assertAlmostEqual(result['score'],50*(math.exp(-.25)+math.exp(-1)))
        self.assertEqual(result['secondary_metrics']['Mean Absolute Error (chars)'],62.5)
        self.assertEqual(result['secondary_metrics']['Exact Match (%)'],0)

    def test_invalid_predictions_and_ids(self):
        for value in [-1,1001,1.5,True,None,'','NaN','Infinity','1.0','1e2',[],{}]:
            with self.subTest(value=value):
                pred=self.pred.astype(object).copy()
                pred.at[0,'boundary_char_index']=value
                self.assertFalse(score(pred,self.truth)['valid'])
        for ids in [['a','a'],['a','unknown'],['a',''],['a',None],['a',[]]]:
            pred=self.pred.copy();pred['id']=ids
            self.assertFalse(score(pred,self.truth)['valid'])
        self.assertFalse(score(self.pred.iloc[:1],self.truth)['valid'])
        self.assertFalse(score(self.pred.assign(debug='x'),self.truth)['valid'])

    def test_endpoints_and_csv_strings(self):
        for values in [[0,2000],['0','2000'],['+0',' 2000 ']]:
            pred=self.pred.copy();pred['boundary_char_index']=values
            self.assertTrue(score(pred,self.truth)['valid'])

    def test_jsonl_csv_and_zip(self):
        records=self.pred.to_dict('records')
        raw=('\ufeff\n'+'\n'.join(json.dumps(r) for r in records)+'\n').encode('utf-8')
        frame,_=read_submission(Upload(raw))
        self.assertEqual(score(frame,self.truth)['score'],100)
        csv=self.pred.to_csv(index=False).encode()
        frame,_=read_submission(Upload(csv,'output.csv'))
        self.assertEqual(score(frame,self.truth)['score'],100)
        buf=BytesIO()
        with ZipFile(buf,'w') as z:z.writestr('nested/answers.jsonl',raw)
        frame,name=read_submission(Upload(buf.getvalue(),'predictions.zip'))
        self.assertEqual(name,'nested/answers.jsonl')
        self.assertEqual(score(frame,self.truth)['score'],100)
        with ZipFile(buf:=BytesIO(),'w') as z:
            z.writestr('answers.jsonl',raw);z.writestr('output.csv',csv)
        with self.assertRaises(SubmissionReadError):read_submission(Upload(buf.getvalue(),'predictions.zip'))
        for raw in [b'broken',b'[]',b'{}',b'{"id":"a"}',b'{"id":null,"boundary_char_index":1}',b'\xff',b' \n']:
            with self.assertRaises(SubmissionReadError):read_submission(Upload(raw))

    def test_routing_truth_unicode_and_requirements(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for subset in ['test_leaderboard_a','test_leaderboard_b']:
                p=root/'private'/subset;p.mkdir(parents=True)
                (p/'data.jsonl').write_text(json.dumps({'id':'a','text':'a😀b'})+'\n')
                (p.parent/f'{subset}_answers.jsonl').write_text(json.dumps({'id':'a','boundary_char_index':2})+'\n')
            config=replace(TASKS['ghost'],organizer_dir=root)
            with patch.dict(TASKS,ghost=config):
                self.assertEqual(load_truth(root,'public').text_length.tolist(),[3])
                self.assertEqual(grade_submission('ghost','private',pd.DataFrame({'id':['a'],'boundary_char_index':[2]}))['score'],100)
                req=task_requirements('ghost')
                self.assertIsNone(req['labels'])
                self.assertEqual(req['example'],[['a',0]])
                self.assertEqual(req['rows'],{'public':1,'private':1})
        self.assertIn('ghost',ACTIVE_TASKS)
        self.assertEqual(task_splits('ghost'),['public','private'])
        self.assertEqual(resolve_task_split({'Tác vụ':'Tác vụ 4 — NLP: Ghost of the Machine','Tập đánh giá':'Private Test'}),('ghost','private'))
        self.assertEqual(find_attachment('https://github.com/user-attachments/files/123/answers.jsonl','owner/repo')[1],'answers.jsonl')

    def test_private_ranking_before_public(self):
        records=[{'team':'A','task':'ghost','split':'public','score':99,'valid':True,'submitted_at':'2026-10-10T00:00:00Z'},
                 {'team':'A','task':'ghost','split':'private','score':50,'valid':True,'submitted_at':'2026-10-10T00:00:00Z'},
                 {'team':'B','task':'ghost','split':'private','score':60,'valid':True,'submitted_at':'2026-10-10T00:00:01Z'}]
        self.assertEqual(build_leaderboard(records,'ghost')[0]['team'],'B')


if __name__=='__main__':unittest.main()

"""Restroom native NPY transport, metric, validation and GitHub routing."""
from dataclasses import replace
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import numpy as np
import pandas as pd

from scoring import TASKS, SubmissionReadError, grade_submission, load_ground_truth, read_submission, score_restroom_submission
from leaderboard import ACTIVE_TASKS, build_leaderboard, task_requirements
from scripts.grade_issue import resolve_task_split, find_attachment, grade_issue


class Upload(BytesIO):
    def __init__(self, data, name):
        super().__init__(data)
        self.name=name


def npy(values, version=None):
    stream=BytesIO()
    np.lib.format.write_array(stream,np.asarray(values),version=version,allow_pickle=True)
    return stream.getvalue()


def read(data, name='submission_a.npy', split='public'):
    return read_submission(Upload(data,name),task='restroom',split=split)


class RestroomTests(unittest.TestCase):
    def setUp(self):
        self.truth=pd.DataFrame({'query_id':[str(i) for i in range(1,11)],'gallery_id':[str(i) for i in range(1,11)]})

    def test_native_numeric_dtypes_endianness_and_versions(self):
        for dtype in ['i1','u1','<i2','>i2','<u4','>u4','<i8','>i8','<u8','>u8','<f4','>f4','<f8','>f8']:
            for version in [(1,0),(2,0),(3,0)]:
                with self.subTest(dtype=dtype,version=version):
                    frame,_=read(npy(np.arange(1,11,dtype=dtype),version))
                    self.assertEqual(score_restroom_submission(frame,self.truth,'public')['score'],1)

    def test_metric_scale_order_and_all_gallery_ids_allowed(self):
        perfect=self.truth.iloc[::-1]
        self.assertEqual(score_restroom_submission(perfect,self.truth,'public')['score'],1)
        wrong=self.truth.copy();wrong.loc[:2,'gallery_id']='20'
        result=score_restroom_submission(wrong,self.truth,'public')
        self.assertTrue(result['valid'])
        self.assertEqual(result['score'],.7)
        self.assertEqual(result['secondary_metrics'],{'Correct Matches':7,'Total Queries':10})
        reused=self.truth.copy();reused['gallery_id']='1'
        self.assertTrue(score_restroom_submission(reused,self.truth,'public')['valid'])
        self.assertEqual(score_restroom_submission(reused,self.truth,'public')['score'],.1)

    def test_wrong_npy_shape_dtype_values_and_split_rejected(self):
        arrays=[np.zeros(10),np.ones(9),np.ones((10,1)),np.ones((1,10)),np.array(1),
                np.ones(10,dtype=bool),np.ones(10,dtype=complex),np.array(['1']*10),
                np.array([{}]*10,dtype=object),np.full(10,np.nan),np.full(10,np.inf),
                np.full(10,1.5),np.full(10,-1),np.full(10,21)]
        for values in arrays:
            with self.subTest(shape=values.shape,dtype=values.dtype):
                with self.assertRaises(SubmissionReadError):read(npy(values))
        for data in [b'',b'not-npy',npy(np.ones(10))[:-1],npy(np.ones(10))+b'extra']:
            with self.assertRaises(SubmissionReadError):read(data)
        # A huge declared shape is rejected from its header, before allocating it.
        stream=BytesIO();np.lib.format.write_array_header_1_0(stream,{'descr':'<i8','fortran_order':False,'shape':(10**12,)})
        with self.assertRaises(SubmissionReadError):read(stream.getvalue())
        with self.assertRaises(SubmissionReadError):read(npy(np.ones(10)),'submission_b.npy')

    def test_zip_both_splits_and_csv(self):
        stream=BytesIO()
        with ZipFile(stream,'w') as z:
            z.writestr('nested/submission_a.npy',npy(np.arange(1,11)))
            z.writestr('nested/submission_b.npy',npy(np.arange(1,31,dtype=float)))
        for split,count in [('public',10),('private',30)]:
            frame,name=read(stream.getvalue(),'submission.zip',split)
            self.assertEqual(len(frame),count)
            self.assertEqual(frame.gallery_id.tolist(),[str(i) for i in range(1,count+1)])
        frame,_=read(self.truth.iloc[::-1].to_csv(index=False).encode(),'output.csv')
        self.assertEqual(score_restroom_submission(frame,self.truth,'public')['score'],1)
        for members in [ [('submission_b.npy',npy(np.ones(30)))], [('a/submission_a.npy',npy(np.ones(10))),('b/submission_a.npy',npy(np.ones(10)))], [('submission_a.npy',npy(np.ones(10))),('output.csv',b'query_id,gallery_id\n')]]:
            stream=BytesIO()
            with ZipFile(stream,'w') as z:
                for name,data in members:z.writestr(name,data)
            with self.assertRaises(SubmissionReadError):read(stream.getvalue(),'submission.zip')

    def test_bad_csv_ids_values_and_schema_rejected(self):
        for ids in [['1']*10,[str(i) for i in range(2,12)],['']*10]:
            frame=self.truth.copy();frame.query_id=ids
            self.assertFalse(score_restroom_submission(frame,self.truth,'public')['valid'])
        for value in ['0','21','1.5','1e1','NaN','inf','True','']:
            frame=self.truth.copy();frame.loc[0,'gallery_id']=value
            self.assertFalse(score_restroom_submission(frame,self.truth,'public')['valid'])
        self.assertFalse(score_restroom_submission(self.truth.assign(debug=1),self.truth,'public')['valid'])
        self.assertFalse(score_restroom_submission(self.truth.iloc[:-1],self.truth,'public')['valid'])

    def test_truth_requirements_and_issue_grading(self):
        self.assertIn('restroom',ACTIVE_TASKS)
        req=task_requirements('restroom')
        self.assertIsNone(req['labels'])
        self.assertEqual(req['gallery_counts'],{'public':20,'private':60})
        self.assertEqual(resolve_task_split({'Tác vụ':'Tác vụ 5 — Computer Vision: Restroom Icon Matching','Tập đánh giá':'Private Test'}),('restroom','private'))
        self.assertEqual(find_attachment('https://github.com/user-attachments/files/42/submission_a.npy','owner/repo')[1],'submission_a.npy')
        with tempfile.TemporaryDirectory() as tmp:
            organizer=Path(tmp)/'Scoring';organizer.mkdir()
            for letter,n in [('a',10),('b',30)]:np.save(organizer/f'answer_{letter}.npy',np.arange(1,n+1))
            config=replace(TASKS['restroom'],organizer_dir=organizer)
            with patch.dict(TASKS,restroom=config):
                self.assertEqual(len(load_ground_truth('restroom','private')),30)
                self.assertEqual(grade_submission('restroom','public',self.truth)['score'],1)
                event={'issue':{'number':123456,'user':{'login':'test'},'body':'### Đội\nTùng\n### Tác vụ\nTác vụ 5 — Computer Vision: Restroom Icon Matching\n### Tập đánh giá\nPublic Test\n### File submission\nhttps://github.com/user-attachments/files/42/submission_a.npy'}}
                status,_=grade_issue(event,repository='owner/repo',token=None,site_url=None,daily_limit=5,teams_path=Path('teams.json'),results_dir=Path(tmp)/'results',fetch=lambda *_:npy(np.arange(1,11)))
                self.assertEqual(status,'graded')

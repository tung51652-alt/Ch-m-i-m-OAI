"""Regression tests for all local-grader tasks, including ViLexNorm."""
from __future__ import annotations

from io import BytesIO
import unittest
from zipfile import ZIP_DEFLATED, ZipFile

import pandas as pd

from scoring import TASKS, SPLIT_FILES, grade_submission, load_ground_truth, read_submission


def _has_data(task: str, *files: str) -> bool:
    return all((TASKS[task].organizer_dir / name).is_file() for name in files)


HAS_VILEXNORM = _has_data("vilexnorm", "test_ground_truth.csv", "evaluate.py")
HAS_CLASSIFICATION = all(_has_data(task, *SPLIT_FILES.values()) for task in ["cv", "nlp"])


class NamedBytesIO(BytesIO):
    def __init__(self, data: bytes, name: str):
        super().__init__(data)
        self.name = name


@unittest.skipUnless(HAS_VILEXNORM, "Thiếu ground truth ViLexNorm (GRADER_DATA_ROOT)")
class ViLexNormGraderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.truth = load_ground_truth("vilexnorm", "test")
        config_test = pd.read_csv(
            __import__("scoring").TASKS["vilexnorm"].test_input_path,
            encoding="utf-8-sig",
            dtype=str,
        )
        cls.test_input = config_test

    def test_perfect(self) -> None:
        result = grade_submission("vilexnorm", "test", self.truth.copy())
        self.assertTrue(result["valid"])
        self.assertAlmostEqual(result["score"], 1.0)

    def test_leave_as_is(self) -> None:
        submission = self.test_input.rename(columns={"original": "normalized"})
        result = grade_submission("vilexnorm", "test", submission)
        self.assertTrue(result["valid"])
        self.assertAlmostEqual(result["score"], 0.0)

    def test_shuffled_rows_are_invariant(self) -> None:
        shuffled = self.truth.sample(frac=1.0, random_state=42).reset_index(drop=True)
        result = grade_submission("vilexnorm", "test", shuffled)
        self.assertTrue(result["valid"])
        self.assertAlmostEqual(result["score"], 1.0)

    def test_missing_row_rejected(self) -> None:
        result = grade_submission("vilexnorm", "test", self.truth.iloc[:-1].copy())
        self.assertFalse(result["valid"])
        self.assertGreater(result["stats"]["missing_ids"], 0)

    def test_duplicate_id_rejected(self) -> None:
        submission = self.truth.copy()
        submission.loc[1, "id"] = submission.loc[0, "id"]
        result = grade_submission("vilexnorm", "test", submission)
        self.assertFalse(result["valid"])
        self.assertGreater(result["stats"]["duplicate_ids"], 0)

    def test_extra_id_rejected(self) -> None:
        extra = pd.DataFrame([{"id": "not-a-test-id", "normalized": "dự đoán"}])
        submission = pd.concat([self.truth, extra], ignore_index=True)
        result = grade_submission("vilexnorm", "test", submission)
        self.assertFalse(result["valid"])
        self.assertGreater(result["stats"]["unknown_ids"], 0)

    def test_empty_prediction_rejected(self) -> None:
        submission = self.truth.copy()
        submission.loc[0, "normalized"] = "  "
        result = grade_submission("vilexnorm", "test", submission)
        self.assertFalse(result["valid"])
        self.assertEqual(result["stats"]["missing_predictions"], 1)

    def test_extra_column_rejected(self) -> None:
        submission = self.truth.assign(debug="not allowed")
        result = grade_submission("vilexnorm", "test", submission)
        self.assertFalse(result["valid"])

    def test_zip_accepts_submission_and_output_names(self) -> None:
        csv_bytes = self.truth.to_csv(index=False).encode("utf-8")
        for filename in ["submission.csv", "nested/output.csv"]:
            buffer = BytesIO()
            with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
                archive.writestr(filename, csv_bytes)
                archive.writestr("notes.txt", "ignored")
            frame, internal_name = read_submission(NamedBytesIO(buffer.getvalue(), "upload.zip"))
            self.assertEqual(internal_name, filename)
            self.assertEqual(frame.shape, self.truth.shape)
            self.assertTrue(grade_submission("vilexnorm", "test", frame)["valid"])


@unittest.skipUnless(HAS_CLASSIFICATION, "Thiếu ground truth DeepWeeds/Spam (GRADER_DATA_ROOT)")
class ExistingTaskRegressionTests(unittest.TestCase):
    def test_deepweeds_and_spam_perfect_submissions_still_work(self) -> None:
        for task in ["cv", "nlp"]:
            for split in ["public", "private"]:
                with self.subTest(task=task, split=split):
                    truth = load_ground_truth(task, split)
                    result = grade_submission(task, split, truth.copy())
                    self.assertTrue(result["valid"])
                    self.assertAlmostEqual(result["score"], 1.0)


if __name__ == "__main__":
    unittest.main()

"""OAI sequence metrics, matching the two released dataset score.py tools."""
import re
import unicodedata
from rapidfuzz.distance import Levenshtein
from scoring import validate_submission

METRICS = {'latex_recognition': 'Normalized LaTeX Token Edit Similarity',
           'text_restoration': 'Clipped CER Similarity'}

def normalize(text, kind):
    text = unicodedata.normalize('NFC', text)
    return text.strip() if kind == 'latex_recognition' else ' '.join(text.split())

def latex_tokens(text):
    return re.findall(r'\\[a-zA-Z]+|\\[^a-zA-Z]|[\s\S]', text)

def score(submission, truth, kind):
    result = {**validate_submission(submission, truth, 'id', 'text', validate_label_domain=False,
                                   reject_extra_columns=True), 'score': None,
              'metric_name': METRICS[kind], 'secondary_metrics': None,
              'classwise': None, 'confusion_matrix': None}
    if list(submission.columns) != ['id', 'text']:
        result['valid'] = False
        result['errors'].append('Cần đúng header id,text theo thứ tự.')
    if list(submission.columns) == ['id', 'text'] and any(not isinstance(v, str) for col in ['id', 'text'] for v in submission[col]):
        result['valid'] = False
        result['errors'].append('ID và prediction phải là chuỗi.')
    if not result['valid']:
        return result
    lookup = dict(zip(submission.id, submission.text))
    values, exact, word_errors, word_count = [], 0, 0, 0
    for row in truth.itertuples(index=False):
        p, y = (normalize(v, kind) for v in (lookup[row.id], row.text))
        if kind == 'latex_recognition':
            a, b = latex_tokens(p), latex_tokens(y)
            values.append(1 - Levenshtein.distance(a, b) / max(len(a), len(b), 1))
            exact += a == b
        else:
            values.append(1 - min(1, Levenshtein.distance(p, y) / max(len(y), 1)))
            exact += p == y
            word_errors += Levenshtein.distance(p.split(), y.split())
            word_count += len(y.split())
    secondary = {'Exact Match (%)': 100 * exact / len(truth)}
    if kind == 'text_restoration':
        secondary['WER'] = word_errors / word_count
    result.update(score=100 * sum(values) / len(values), secondary_metrics=secondary)
    return result

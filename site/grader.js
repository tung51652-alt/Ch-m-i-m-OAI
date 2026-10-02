/*
 * In-browser grader for the static (GitHub Pages) site.
 * A line-by-line port of scoring.py: same parsing rules (pandas read_csv with dtype=str),
 * same validation, Macro-F1 for classification, and canonical ERR for ViLexNorm.
 */
(function () {
  "use strict";

  class SubmissionReadError extends Error {}

  // Strings pandas.read_csv turns into NaN by default (keep_default_na=True).
  const NA_VALUES = new Set(["", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan", "1.#IND",
    "1.#QNAN", "<NA>", "N/A", "NA", "NULL", "NaN", "None", "n/a", "nan", "null"]);
  const ACCEPTED_ZIP_NAMES = new Set(["output.csv", "submission.csv"]);
  const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

  const n = (v) => Number(v).toLocaleString("en-US");          // Python f"{v:,}"
  const repr = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const reprList = (items) => `[${items.map(repr).join(", ")}]`;
  const sortStr = (arr) => [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // ---------- CSV (RFC 4180, like pandas' C parser for well-formed files) ----------
  function parseCsv(text, sourceName) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);  // utf-8-sig
    const rows = [];
    let row = [], field = "", quoted = false, i = 0, fieldQuoted = false;
    const endField = () => { row.push({ value: field, quoted: fieldQuoted }); field = ""; fieldQuoted = false; };
    const endRow = () => {
      endField();
      // pandas skips blank lines (skip_blank_lines=True).
      if (!(row.length === 1 && row[0].value === "" && !row[0].quoted)) rows.push(row);
      row = [];
    };
    while (i < text.length) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i += 1; continue;
        }
        field += c; i += 1; continue;
      }
      if (c === '"' && field === "") { quoted = true; fieldQuoted = true; i += 1; continue; }
      if (c === ",") { endField(); i += 1; continue; }
      if (c === "\r") { endRow(); i += text[i + 1] === "\n" ? 2 : 1; continue; }
      if (c === "\n") { endRow(); i += 1; continue; }
      field += c; i += 1;
    }
    if (quoted) throw new SubmissionReadError(`CSV ${sourceName} sai cấu trúc: dấu ngoặc kép chưa đóng.`);
    if (field !== "" || fieldQuoted || row.length) endRow();
    if (!rows.length) throw new SubmissionReadError(`CSV ${sourceName} đang rỗng.`);

    const header = rows[0].map((f) => f.value);
    const records = [];
    for (let r = 1; r < rows.length; r += 1) {
      const cells = rows[r];
      if (cells.length > header.length) {
        throw new SubmissionReadError(`CSV ${sourceName} sai cấu trúc: Error tokenizing data. C error: ` +
          `Expected ${header.length} fields in line ${r + 1}, saw ${cells.length}.`);
      }
      const rec = {};
      header.forEach((name, k) => {
        const cell = cells[k];
        // Missing trailing cells and NA strings become NaN (null); quoted empty strings too, as in pandas.
        rec[name] = !cell || NA_VALUES.has(cell.value) ? null : cell.value;
      });
      records.push(rec);
    }
    return { columns: header, rows: records };
  }

  function decodeUtf8(bytes, sourceName) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      throw new SubmissionReadError(`Không đọc được ${sourceName}: CSV phải dùng encoding UTF-8.`);
    }
  }

  let jszipPromise = null;
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    jszipPromise = jszipPromise || new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = JSZIP_URL;
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => { jszipPromise = null; reject(new SubmissionReadError("Không tải được thư viện đọc ZIP; hãy nộp file .csv.")); };
      document.head.append(s);
    });
    return jszipPromise;
  }

  /** Read an uploaded File into {columns, rows, internalName}, like scoring.read_submission. */
  async function readSubmission(file) {
    const name = file.name || "";
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) throw new SubmissionReadError("File upload đang rỗng.");
    const lower = name.toLowerCase();
    if (lower.endsWith(".csv")) {
      return { ...parseCsv(decodeUtf8(bytes, name || "submission.csv"), name || "submission.csv"), internalName: name };
    }
    if (!lower.endsWith(".zip")) throw new SubmissionReadError("Chỉ hỗ trợ file .csv hoặc .zip.");

    const JSZip = await loadJSZip();
    let archive;
    try {
      archive = await JSZip.loadAsync(bytes);
    } catch (e) {
      throw new SubmissionReadError("File ZIP bị lỗi hoặc không đúng định dạng ZIP.");
    }
    const matches = Object.values(archive.files).filter((entry) =>
      !entry.dir && ACCEPTED_ZIP_NAMES.has(entry.name.split("/").pop().toLowerCase()));
    if (!matches.length) throw new SubmissionReadError("Không tìm thấy submission.csv hoặc output.csv trong ZIP.");
    if (matches.length > 1) throw new SubmissionReadError("ZIP chứa nhiều file submission.csv/output.csv; không thể chọn an toàn.");
    let inner;
    try {
      inner = await matches[0].async("uint8array");
    } catch (e) {
      throw new SubmissionReadError("Không đọc được output.csv trong ZIP; file có thể đã được mã hóa.");
    }
    return { ...parseCsv(decodeUtf8(inner, matches[0].name), matches[0].name), internalName: matches[0].name };
  }

  // ---------- validation (scoring.validate_submission) ----------
  const isMissing = (v) => v === null || v === undefined || String(v).trim() === "";

  function validate(sub, truth, idCol, labelCol, options = {}) {
    const validateLabelDomain = options.validateLabelDomain !== false;
    const rejectExtraColumns = options.rejectExtraColumns === true;
    const errors = [], warnings = [];
    const expected = truth.ids.length, submitted = sub.rows.length;
    const stats = { expected_samples: expected, submitted_samples: submitted, valid_samples: 0, missing_id_values: 0,
      duplicate_ids: 0, missing_ids: 0, unknown_ids: 0, missing_predictions: 0, invalid_labels: 0 };

    const required = [idCol, labelCol];
    const missingCols = required.filter((c) => !sub.columns.includes(c));
    missingCols.forEach((c) => errors.push(`Submission không có cột \`${c}\`.`));
    const extra = sub.columns.filter((c) => !required.includes(c));
    if (extra.length) {
      const message = `Submission có cột thừa: ${extra.map((c) => `\`${c}\``).join(", ")}.`;
      if (rejectExtraColumns) errors.push(message);
      else warnings.push(`${message} Các cột này sẽ bị bỏ qua.`);
    }
    if (submitted !== expected) errors.push(`Sai số dòng: cần ${n(expected)}, nhận ${n(submitted)}.`);
    if (missingCols.length) return { valid: false, errors, warnings, stats };

    const idMissing = sub.rows.map((r) => isMissing(r[idCol]));
    const labelMissing = sub.rows.map((r) => isMissing(r[labelCol]));
    stats.missing_id_values = idMissing.filter(Boolean).length;
    stats.missing_predictions = labelMissing.filter(Boolean).length;
    if (stats.missing_id_values) errors.push(`Có ${n(stats.missing_id_values)} dòng thiếu \`${idCol}\`.`);
    if (stats.missing_predictions) errors.push(`Có ${n(stats.missing_predictions)} prediction bị thiếu, rỗng hoặc NaN.`);

    const presentIds = sub.rows.filter((_, i) => !idMissing[i]).map((r) => String(r[idCol]));
    const counts = new Map();
    presentIds.forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
    stats.duplicate_ids = [...counts.values()].filter((c) => c > 1).length;
    if (stats.duplicate_ids) errors.push(`Phát hiện ${n(stats.duplicate_ids)} \`${idCol}\` bị trùng.`);

    const truthIds = new Set(truth.ids);
    const subIds = new Set(presentIds);
    stats.missing_ids = [...truthIds].filter((id) => !subIds.has(id)).length;
    stats.unknown_ids = [...subIds].filter((id) => !truthIds.has(id)).length;
    if (stats.missing_ids) errors.push(`Submission thiếu ${n(stats.missing_ids)} mẫu so với ground truth.`);
    if (stats.unknown_ids) errors.push(`Submission chứa ${n(stats.unknown_ids)} \`${idCol}\` không thuộc test set.`);

    const validLabels = new Set();
    if (validateLabelDomain) {
      truth.labels.forEach((label) => validLabels.add(label));
      const presentLabels = sub.rows.filter((_, i) => !labelMissing[i]).map((r) => String(r[labelCol]));
      const invalidValues = sortStr(new Set(presentLabels.filter((l) => !validLabels.has(l))));
      if (invalidValues.length) {
        const bad = new Set(invalidValues);
        stats.invalid_labels = presentLabels.filter((l) => bad.has(l)).length;
        const shown = invalidValues.slice(0, 8).map(repr).join(", ");
        const suffix = invalidValues.length > 8 ? " ..." : "";
        errors.push(`Có ${n(stats.invalid_labels)} prediction dùng label không hợp lệ: ${shown}${suffix}. ` +
          `Miền hợp lệ: ${reprList(sortStr(validLabels))}.`);
      }
    }

    stats.valid_samples = sub.rows.filter((r, i) => !idMissing[i] && !labelMissing[i]
      && truthIds.has(String(r[idCol]))
      && (!validateLabelDomain || validLabels.has(String(r[labelCol])))).length;
    return { valid: errors.length === 0, errors, warnings, stats };
  }

  // ---------- Macro-F1 (sklearn f1_score, average="macro", zero_division=0) ----------
  function macroF1(yTrue, yPred, labels) {
    let total = 0;
    for (const label of labels) {
      let tp = 0, fp = 0, fn = 0;
      for (let i = 0; i < yTrue.length; i += 1) {
        const t = yTrue[i] === label, p = yPred[i] === label;
        if (t && p) tp += 1; else if (p) fp += 1; else if (t) fn += 1;
      }
      const denom = 2 * tp + fp + fn;
      total += denom ? (2 * tp) / denom : 0;
    }
    return labels.length ? total / labels.length : 0;
  }

  /**
   * Grade a parsed submission against {ids, labels} ground truth (parallel arrays).
   * Returns the same shape as scoring.grade_submission (without per-class tables).
   */
  function grade(sub, truth, idCol, labelCol) {
    const validation = validate(sub, truth, idCol, labelCol);
    if (!validation.valid) return { ...validation, score: null, metric_name: "Macro F1" };
    const lookup = new Map(sub.rows.map((r) => [String(r[idCol]), String(r[labelCol])]));
    const yPred = truth.ids.map((id) => lookup.get(id));
    const labels = sortStr(new Set(truth.labels));
    return { ...validation, score: macroF1(truth.labels, yPred, labels), metric_name: "Macro F1" };
  }

  // ---------- ViLexNorm ERR (port of organizer/evaluate.py) ----------
  const normalizeText = (value) => String(value).normalize("NFC").trim().split(/\s+/u).filter(Boolean).join(" ");
  const tokenize = (value) => {
    const normalized = normalizeText(value);
    return normalized ? normalized.split(" ") : [];
  };

  function levenshteinDistance(left, right) {
    if (left.length < right.length) [left, right] = [right, left];
    let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= right.length; j += 1) {
        current.push(Math.min(
          previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
          previous[j] + 1,
          current[j - 1] + 1,
        ));
      }
      previous = current;
    }
    return previous[previous.length - 1];
  }

  function alignmentOperations(source, target) {
    const rows = source.length + 1, cols = target.length + 1;
    const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let i = 0; i < rows; i += 1) dp[i][0] = i;
    for (let j = 0; j < cols; j += 1) dp[0][j] = j;
    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (source[i - 1] === target[j - 1] ? 0 : 1),
        );
      }
    }
    const reversed = [];
    let i = source.length, j = target.length;
    while (i || j) {
      if (i && j && source[i - 1] === target[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
        reversed.push(["equal", target[j - 1]]); i -= 1; j -= 1;
      } else if (i && j && dp[i][j] === dp[i - 1][j - 1] + 1) {
        reversed.push(["replace", target[j - 1]]); i -= 1; j -= 1;
      } else if (i && dp[i][j] === dp[i - 1][j] + 1) {
        reversed.push(["delete", null]); i -= 1;
      } else {
        reversed.push(["insert", target[j - 1]]); j -= 1;
      }
    }
    return reversed.reverse();
  }

  function extractEdits(source, target) {
    const edits = [];
    let sourcePos = 0, activeStart = null, activeEnd = 0, replacement = [];
    const flush = () => {
      if (activeStart !== null) edits.push([activeStart, activeEnd, replacement]);
      activeStart = null; replacement = [];
    };
    for (const [operation, targetToken] of alignmentOperations(source, target)) {
      if (operation === "equal") { flush(); sourcePos += 1; continue; }
      if (activeStart === null) { activeStart = sourcePos; activeEnd = sourcePos; }
      if (operation === "replace" || operation === "delete") { sourcePos += 1; activeEnd = sourcePos; }
      if ((operation === "replace" || operation === "insert") && targetToken !== null) replacement.push(targetToken);
    }
    flush();
    return edits;
  }

  function editCounts(edits) {
    const counts = new Map();
    edits.forEach((edit) => {
      const key = JSON.stringify(edit);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }

  function evaluateLexicalNormalization(originals, references, predictions) {
    if (!(originals.length === references.length && references.length === predictions.length) || !originals.length) {
      throw new Error("Original/reference/prediction lengths must match and be non-empty.");
    }
    let systemDistance = 0, laiDistance = 0, referenceTokens = 0, tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < originals.length; i += 1) {
      const source = tokenize(originals[i]);
      const reference = tokenize(references[i]);
      const prediction = tokenize(predictions[i]);
      referenceTokens += reference.length;
      laiDistance += levenshteinDistance(source, reference);
      systemDistance += levenshteinDistance(prediction, reference);

      const gold = editCounts(extractEdits(source, reference));
      const predicted = editCounts(extractEdits(source, prediction));
      let correct = 0, goldTotal = 0, predictedTotal = 0;
      gold.forEach((count, key) => { goldTotal += count; correct += Math.min(count, predicted.get(key) || 0); });
      predicted.forEach((count) => { predictedTotal += count; });
      tp += correct; fp += predictedTotal - correct; fn += goldTotal - correct;
    }
    if (!referenceTokens) throw new Error("Ground truth contains no reference tokens.");
    if (!laiDistance) throw new Error("ERR is undefined because Leave-As-Is has no errors.");
    return {
      err: 1 - systemDistance / laiDistance,
      token_accuracy: 1 - systemDistance / referenceTokens,
      precision: tp + fp ? tp / (tp + fp) : 0,
      recall: tp + fn ? tp / (tp + fn) : 0,
    };
  }

  function gradeLexicalNormalization(sub, truth, idCol = "id", labelCol = "normalized") {
    const validation = validate(sub, truth, idCol, labelCol, { validateLabelDomain: false, rejectExtraColumns: true });
    if (!validation.valid) {
      return { ...validation, score: null, metric_name: "Error Reduction Rate (ERR)", secondary_metrics: null };
    }
    if (!Array.isArray(truth.originals) || truth.originals.length !== truth.ids.length) {
      throw new Error("Trang chưa có test input ViLexNorm đầy đủ.");
    }
    const lookup = new Map(sub.rows.map((r) => [String(r[idCol]), String(r[labelCol])]));
    const predictions = truth.ids.map((id) => lookup.get(id));
    const metrics = evaluateLexicalNormalization(truth.originals, truth.labels, predictions);
    return {
      ...validation,
      score: metrics.err,
      metric_name: "Error Reduction Rate (ERR)",
      secondary_metrics: {
        "Token Accuracy": metrics.token_accuracy,
        "Normalization Precision": metrics.precision,
        "Normalization Recall": metrics.recall,
      },
    };
  }

  // ---------- compact encoding for saving through a pre-filled GitHub issue ----------
  const PRED_PREFIX = "oai-pred:v1:";

  /**
   * Encode a VALID submission as "oai-pred:v1:<base64(gzip(json))>". Predictions are stored in
   * ground-truth ID order as one base-36 digit per row (index into the sorted label domain), so a
   * full test set fits in an issue URL; scripts/grade_issue.py rebuilds the file and re-grades it.
   */
  async function encodePrediction(sub, truth, idCol, labelCol, meta) {
    const labels = sortStr(new Set(truth.labels));
    if (labels.length > 36) throw new Error("Quá nhiều nhãn để mã hóa.");
    const index = new Map(labels.map((l, i) => [l, i]));
    const lookup = new Map(sub.rows.map((r) => [String(r[idCol]), String(r[labelCol])]));
    const pred = truth.ids.map((id) => index.get(lookup.get(id)).toString(36)).join("");
    const json = JSON.stringify({ v: 1, ...meta, labels, pred });
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return PRED_PREFIX + btoa(binary);
  }

  window.OAIGrader = {
    SubmissionReadError, readSubmission, parseCsv, validate, grade, macroF1,
    gradeLexicalNormalization, evaluateLexicalNormalization, levenshteinDistance, encodePrediction,
  };
})();

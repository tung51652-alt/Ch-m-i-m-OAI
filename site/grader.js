/*
 * In-browser grader for the static (GitHub Pages) site.
 * A line-by-line port of scoring.py: same parsing rules (pandas read_csv with dtype=str),
 * same validation, same Vietnamese messages and the same Macro-F1 as sklearn
 * f1_score(average="macro", labels=<truth labels>, zero_division=0).
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

  function validate(sub, truth, idCol, labelCol) {
    const errors = [], warnings = [];
    const expected = truth.ids.length, submitted = sub.rows.length;
    const stats = { expected_samples: expected, submitted_samples: submitted, valid_samples: 0, missing_id_values: 0,
      duplicate_ids: 0, missing_ids: 0, unknown_ids: 0, missing_predictions: 0, invalid_labels: 0 };

    const required = [idCol, labelCol];
    const missingCols = required.filter((c) => !sub.columns.includes(c));
    missingCols.forEach((c) => errors.push(`Submission không có cột \`${c}\`.`));
    const extra = sub.columns.filter((c) => !required.includes(c));
    if (extra.length) warnings.push(`Submission có cột thừa: ${extra.map((c) => `\`${c}\``).join(", ")}. Các cột này sẽ bị bỏ qua.`);
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

    const validLabels = new Set(truth.labels);
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

    stats.valid_samples = sub.rows.filter((r, i) => !idMissing[i] && !labelMissing[i]
      && truthIds.has(String(r[idCol])) && validLabels.has(String(r[labelCol]))).length;
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

  window.OAIGrader = { SubmissionReadError, readSubmission, parseCsv, validate, grade, macroF1 };
})();

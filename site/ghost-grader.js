/* IOAI Ghost metric: 100 * mean(exp(-abs(prediction - reference) / 100)). */
(function () {
  "use strict";
  function grade(sub, truth) {
    const validation = window.OAIGrader.validate(sub, truth, "id", "boundary_char_index", {
      validateLabelDomain: false, rejectExtraColumns: true,
    });
    const result = { ...validation, score: null, metric_name: "Boundary Score", secondary_metrics: null };
    if (sub.columns.length !== 2 && !result.errors.length) result.errors.push("Cần đúng hai cột: id,boundary_char_index.");
    if (!result.valid || result.errors.length) return { ...result, valid: false };
    if (!truth.text_lengths || truth.text_lengths.length !== truth.ids.length) throw new Error("Thiếu độ dài văn bản Ghost.");
    const lengths = new Map(truth.ids.map((id, i) => [id, truth.text_lengths[i]]));
    const predictions = new Map();
    let invalid = 0;
    for (const row of sub.rows) {
      const value = row.boundary_char_index;
      const numeric = typeof value === "number" || (typeof value === "string" && /^[+-]?[0-9]+$/.test(value.trim()));
      const boundary = numeric ? Number(value) : NaN;
      if (typeof row.id !== "string" || !Number.isSafeInteger(boundary) || boundary < 0 || boundary > lengths.get(row.id)) invalid += 1;
      else predictions.set(row.id, boundary);
    }
    result.stats.invalid_boundaries = invalid;
    if (invalid) {
      result.errors.push(`Boundary phải là số nguyên trong [0, len(text)]: ${invalid}.`);
      result.stats.valid_samples = 0;
      return { ...result, valid: false };
    }
    const distances = truth.ids.map((id, i) => Math.abs(predictions.get(id) - Number(truth.labels[i])));
    return { ...result, score: 100 * distances.reduce((sum, d) => sum + Math.exp(-d / 100), 0) / distances.length,
      secondary_metrics: {
        "Mean Absolute Error (chars)": distances.reduce((sum, d) => sum + d, 0) / distances.length,
        "Exact Match (%)": 100 * distances.filter((d) => d === 0).length / distances.length,
      } };
  }
  window.OAIGhostGrader = { grade };
})();

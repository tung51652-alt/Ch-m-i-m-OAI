"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

global.window = globalThis;
require("./site/grader.js");

const { evaluateLexicalNormalization, gradeLexicalNormalization } = global.OAIGrader;

test("ViLexNorm ERR matches the canonical evaluator on perfect, LAI and partial output", () => {
  const originals = ["k nên", "xin chao"];
  const references = ["không nên", "xin chào"];

  assert.deepEqual(evaluateLexicalNormalization(originals, references, references), {
    err: 1,
    token_accuracy: 1,
    precision: 1,
    recall: 1,
  });
  assert.deepEqual(evaluateLexicalNormalization(originals, references, originals), {
    err: 0,
    token_accuracy: 0.5,
    precision: 0,
    recall: 0,
  });
  assert.deepEqual(evaluateLexicalNormalization(originals, references, ["không nên", "xin chao"]), {
    err: 0.5,
    token_accuracy: 0.75,
    precision: 1,
    recall: 0.5,
  });
});

test("ViLexNorm browser grader aligns by ID and rejects extra columns", () => {
  const truth = {
    ids: ["0", "1"],
    originals: ["k nên", "xin chao"],
    labels: ["không nên", "xin chào"],
  };
  const shuffled = {
    columns: ["id", "normalized"],
    rows: [
      { id: "1", normalized: "xin chào" },
      { id: "0", normalized: "không nên" },
    ],
  };
  const perfect = gradeLexicalNormalization(shuffled, truth);
  assert.equal(perfect.valid, true);
  assert.equal(perfect.score, 1);
  assert.equal(perfect.secondary_metrics["Token Accuracy"], 1);

  const extraColumn = {
    columns: ["id", "normalized", "debug"],
    rows: shuffled.rows.map((row) => ({ ...row, debug: "x" })),
  };
  const invalid = gradeLexicalNormalization(extraColumn, truth);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /cột thừa/);
});

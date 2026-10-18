/* Restroom: safe numeric NPY reader and official Precision@1, entirely in-browser. */
(function () {
  "use strict";
  const columns = ["query_id", "gallery_id"];
  const splits = { public: { n: 10, max: 20, file: "submission_a.npy" }, private: { n: 30, max: 60, file: "submission_b.npy" } };
  const fail = (message) => { throw new window.OAIGrader.SubmissionReadError(message); };
  function config(split) { if (!splits[split]) fail("Chọn Public/A hoặc Private/B cho Restroom."); return splits[split]; }
  function parseNpy(bytes, split) {
    const c = config(split);
    if (bytes.length > 65536 || bytes.length < 10 || bytes[0] !== 0x93 || new TextDecoder().decode(bytes.subarray(1, 6)) !== "NUMPY") fail("File NPY không hợp lệ hoặc vượt 64 KB.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const major = bytes[6], minor = bytes[7];
    if (![1, 2, 3].includes(major) || minor !== 0) fail("Phiên bản NPY không được hỗ trợ.");
    const start = major === 1 ? 10 : 12;
    if (bytes.length < start) fail("NPY thiếu header.");
    const length = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
    const offset = start + length;
    if (length > 10000 || offset > bytes.length) fail("NPY header không hợp lệ.");
    const header = new TextDecoder().decode(bytes.subarray(start, offset));
    const dtype = /['"]descr['"]\s*:\s*['"]([<>|])([iuf])(1|2|4|8)['"]/.exec(header);
    const shape = /['"]shape['"]\s*:\s*\(\s*(\d+)\s*,\s*\)/.exec(header);
    const order = /['"]fortran_order['"]\s*:\s*(True|False)/.exec(header);
    if (!dtype || !shape || !order) fail("NPY cần mảng số một chiều, không dùng object/pickle.");
    const n = Number(shape[1]), kind = dtype[2], size = Number(dtype[3]);
    if (n !== c.n) fail(`NPY phải có shape (${c.n},).`);
    if ((kind === 'f' && ![4,8].includes(size)) || (dtype[1] === '|' && size !== 1) || offset + n * size !== bytes.length) fail("NPY dtype hoặc độ dài dữ liệu không hợp lệ.");
    const little = dtype[1] !== '>';
    const methods = { i: {1:'getInt8',2:'getInt16',4:'getInt32',8:'getBigInt64'}, u: {1:'getUint8',2:'getUint16',4:'getUint32',8:'getBigUint64'}, f: {4:'getFloat32',8:'getFloat64'} };
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      const value = Number(view[methods[kind][size]](offset + i * size, little));
      if (!Number.isSafeInteger(value) || value < 1 || value > c.max) fail(`Gallery ID phải là số nguyên từ 1 đến ${c.max}, không phải chỉ số bắt đầu từ 0.`);
      rows.push({query_id: String(i + 1), gallery_id: String(value)});
    }
    return {columns: [...columns], rows};
  }
  async function readSubmission(file, split) {
    const c = config(split), name = file.name || '', lower = name.toLowerCase();
    if (lower.endsWith('.csv')) return window.OAIGrader.readSubmission(file);
    if (!lower.endsWith('.zip') && !lower.endsWith('.npy')) fail("Restroom nhận NPY, CSV hoặc ZIP.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (lower.endsWith('.npy')) {
      if (lower.split('/').pop() !== c.file) fail(`Tập đã chọn cần ${c.file}; hãy chọn đúng tập A/B.`);
      return {...parseNpy(bytes, split), internalName: name};
    }
    const JSZip = await window.OAIGrader.loadJSZip();
    let archive;
    try { archive = await JSZip.loadAsync(bytes); }
    catch (error) { fail("File ZIP bị lỗi hoặc không đúng định dạng ZIP."); }
    const candidates = Object.values(archive.files).filter((entry) => !entry.dir && [c.file, 'output.csv', 'submission.csv'].includes(entry.name.split('/').pop().toLowerCase()));
    if (candidates.length !== 1) fail(`ZIP cần đúng một ${c.file} (có thể kèm NPY của tập còn lại), hoặc một output.csv/submission.csv.`);
    const member = candidates[0];
    // Bound decompression as well as the raw .npy size.
    let total = 0;
    const chunks = [];
    await new Promise((resolve, reject) => {
      const stream = member.internalStream('uint8array');
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > 65536) { stream.pause(); reject(new window.OAIGrader.SubmissionReadError('File dự đoán Restroom trong ZIP vượt 64 KB.')); }
        else chunks.push(chunk);
      }).on('error', reject).on('end', resolve).resume();
    });
    const inner = new Uint8Array(total);let pos = 0;
    chunks.forEach(chunk => { inner.set(chunk, pos); pos += chunk.length; });
    if (member.name.toLowerCase().endsWith('.npy')) return {...parseNpy(inner, split), internalName: member.name};
    let text;
    try { text = new TextDecoder('utf-8', {fatal:true}).decode(inner); }
    catch(error) { fail('CSV phải dùng encoding UTF-8.'); }
    return {...window.OAIGrader.parseCsv(text, member.name), internalName: member.name};
  }
  function grade(sub, truth, split) {
    const c = config(split);
    const validation = window.OAIGrader.validate(sub, truth, 'query_id', 'gallery_id', {validateLabelDomain:false, rejectExtraColumns:true});
    if (sub.columns.length !== 2) { validation.valid = false; validation.errors.push("Cần đúng hai cột query_id,gallery_id."); }
    const result = {...validation, score:null, metric_name:'Precision@1', secondary_metrics:null};
    if (!result.valid) return result;
    const lookup = new Map(sub.rows.map(row => [String(row.query_id), String(row.gallery_id)]));
    const values = truth.ids.map(id => lookup.get(id));
    if (values.some(value => !/^[0-9]{1,2}$/.test(value) || Number(value) < 1 || Number(value) > c.max)) {
      result.errors.push(`Gallery ID phải là số nguyên từ 1 đến ${c.max}.`);
      result.stats.valid_samples = 0;
      return {...result, valid:false};
    }
    const correct = values.filter((value, i) => Number(value) === Number(truth.labels[i])).length;
    return {...result, score:correct / truth.ids.length, secondary_metrics:{'Correct Matches':correct, 'Total Queries':truth.ids.length}};
  }
  window.OAIRestroomGrader = {parseNpy, readSubmission, grade};
})();

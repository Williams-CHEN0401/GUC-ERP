import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../project-report.js", import.meta.url), "utf8");
const sandbox = {};
vm.runInNewContext(source, sandbox);
const { buildProjectReport } = sandbox.GUCProjectReport;
const { csvCell } = sandbox.GUCProjectReport;

const base = {
  projectId: "p1",
  inventory: [
    { id: "i1", name: "網路線", brand: "A", model: "M1", unit: "米" },
    { id: "i2", name: "插座", brand: "B", model: "M2", unit: "件" },
  ],
  workers: [
    { id: "u1", displayName: "陳工程師", active: true },
    { id: "u2", displayName: "陳工程師", active: false },
  ],
  pickups: [
    { id: "m1", projectId: "p1", itemId: "i1", date: "2026-08-01", quantity: 20 },
    { id: "m2", projectId: "p1", itemId: "i2", date: "2026-08-02", quantity: 2 },
    { id: "m3", projectId: "p2", itemId: "i1", date: "2026-08-02", quantity: 99 },
  ],
  logs: [
    { id: "l1", projectId: "p1", log_date: "2026-08-01", workerIds: ["u1"], summary: "A", status: "in_progress" },
    { id: "l2", projectId: "p1", log_date: "2026-08-01", workerIds: ["u1", "u2"], summary: "B", status: "in_progress" },
    { id: "l3", projectId: "p1", log_date: "2026-08-02", workerIds: ["u1"], summary: "C", status: "completed" },
    { id: "l4", projectId: "p1", log_date: "2026-08-03", workerIds: [], summary: "D", status: "completed" },
    { id: "l5", projectId: "p2", log_date: "2026-08-03", workerIds: ["u1"], summary: "X", status: "completed" },
  ],
};

test("人員依 UUID 分組，同日多日誌只計一施工天與一人次", () => {
  const report = buildProjectReport(base);
  assert.equal(report.kpis.constructionDays, 3);
  assert.equal(report.kpis.workerCount, 2);
  assert.equal(report.kpis.workerDays, 3);
  assert.deepEqual(Array.from(report.workerStats, ({ id, constructionDays, recordCount }) => ({ id, constructionDays, recordCount })), [
    { id: "u1", constructionDays: 2, recordCount: 3 },
    { id: "u2", constructionDays: 1, recordCount: 1 },
  ]);
  assert.equal(report.dailyRows.find((row) => row.id === "l1").dailyHeadcount, 2);
  assert.deepEqual(Array.from(report.workerStats, ({ id, label }) => ({ id, label })), [
    { id: "u1", label: "陳工程師（u1）" },
    { id: "u2", label: "陳工程師（u2）" },
  ]);
  assert.deepEqual(Array.from(report.dailyRows.find((row) => row.id === "l1").workerNames), ["陳工程師（u1）"]);
  assert.equal(report.dailyRows.find((row) => row.id === "l4").dailyHeadcount, 0);
});

test("日期區間含起訖日，且不混入其他專案", () => {
  const report = buildProjectReport({ ...base, from: "2026-08-02", to: "2026-08-02" });
  assert.deepEqual(Array.from(report.materialRows, (row) => row.id), ["m2"]);
  assert.deepEqual(Array.from(report.dailyRows, (row) => row.id), ["l3"]);
  assert.equal(report.kpis.workerDays, 1);
});

test("不同材料單位分別彙總，不製造跨單位假總量", () => {
  const report = buildProjectReport(base);
  assert.deepEqual(Array.from(report.totalsByUnit, ({ unit, total }) => ({ unit, total })), [{ unit: "件", total: 2 }, { unit: "米", total: 20 }]);
  assert.equal(report.kpis.materialTypeCount, 2);
  assert.equal(report.kpis.primaryMaterial.recordCount, 1);
});

test("反向日期不產生假統計", () => {
  const report = buildProjectReport({ ...base, from: "2026-08-03", to: "2026-08-01" });
  assert.equal(report.error, "起始日期不可晚於結束日期。");
});

test("CSV 匯出中和公式前綴並保留雙引號", () => {
  assert.equal(csvCell("=HYPERLINK(\"https://example.invalid\")"), '"\'=HYPERLINK(""https://example.invalid"")"');
  assert.equal(csvCell("  +1+1"), '"\'  +1+1"');
  assert.equal(csvCell("normal"), '"normal"');
});

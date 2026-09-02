(function attachProjectReport(globalObject) {
  function text(value) { return String(value ?? "").trim(); }
  function quantity(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
  function inDateRange(value, from, to) {
    const date = text(value);
    return !!date && (!from || date >= from) && (!to || date <= to);
  }
  function compareDate(left, right) { return String(left).localeCompare(String(right)); }
  function csvCell(value) {
    let result = String(value ?? "");
    if (/^[\t\r\n ]*[=+\-@]/.test(result)) result = `'${result}`;
    return `"${result.replaceAll('"', '""')}"`;
  }

  function buildProjectReport({ projectId, pickups = [], logs = [], workers = [], inventory = [], from = "", to = "" } = {}) {
    const dateFrom = text(from), dateTo = text(to);
    if (dateFrom && dateTo && dateFrom > dateTo) {
      return { error: "起始日期不可晚於結束日期。" };
    }

    const itemById = new Map(inventory.map((item) => [item.id, item]));
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const workerNameCounts = workers.reduce((counts, worker) => {
      const name = text(worker.displayName) || "未命名施工人員";
      counts.set(name, (counts.get(name) || 0) + 1);
      return counts;
    }, new Map());
    const workerLabel = (workerId) => {
      const name = text(workerById.get(workerId)?.displayName) || "未命名施工人員";
      return (!workerById.has(workerId) || (workerNameCounts.get(name) || 0) > 1) ? `${name}（${text(workerId).slice(0, 8)}）` : name;
    };
    const materialRows = pickups
      .filter((row) => row.projectId === projectId && inDateRange(row.date, dateFrom, dateTo))
      .map((row) => ({ ...row, item: itemById.get(row.itemId) || null }))
      .sort((left, right) => compareDate(right.date, left.date));
    const filteredLogs = logs
      .filter((row) => row.projectId === projectId && inDateRange(row.log_date, dateFrom, dateTo))
      .sort((left, right) => compareDate(right.log_date, left.log_date));

    const materials = new Map(), unitTotals = new Map();
    materialRows.forEach((row) => {
      const item = row.item || {}, unit = text(item.unit) || "未標示單位", amount = quantity(row.quantity);
      const current = materials.get(row.itemId) || {
        id: row.itemId, name: text(item.name) || "未知品項", brand: text(item.brand), model: text(item.model),
        unit, quantity: 0, recordCount: 0, dates: [],
      };
      current.quantity += amount;
      current.recordCount += 1;
      current.dates.push(row.date);
      materials.set(row.itemId, current);
      unitTotals.set(unit, (unitTotals.get(unit) || 0) + amount);
    });
    const materialStats = [...materials.values()]
      .map((row) => ({ ...row, firstDate: [...row.dates].sort(compareDate)[0] || "", recentDate: [...row.dates].sort(compareDate).at(-1) || "" }))
      .sort((left, right) => right.recordCount - left.recordCount || left.name.localeCompare(right.name, "zh-Hant"));

    const workerStatsById = new Map(), projectDates = new Set(), workerDays = new Set(), dailyWorkers = new Map();
    filteredLogs.forEach((log) => {
      const logDate = text(log.log_date);
      if (logDate) projectDates.add(logDate);
      const ids = [...new Set((log.workerIds || []).filter(Boolean))];
      const dailySet = dailyWorkers.get(logDate) || new Set();
      ids.forEach((workerId) => {
        dailySet.add(workerId);
        workerDays.add(`${logDate}|${workerId}`);
        const worker = workerById.get(workerId) || {};
        const current = workerStatsById.get(workerId) || {
          id: workerId, name: text(worker.displayName) || "未命名施工人員", active: worker.active !== false,
          recordCount: 0, dates: new Set(),
        };
        current.recordCount += 1;
        if (logDate) current.dates.add(logDate);
        workerStatsById.set(workerId, current);
      });
      dailyWorkers.set(logDate, dailySet);
    });
    const workerStats = [...workerStatsById.values()].map((row) => {
      const dates = [...row.dates].sort(compareDate);
      return { id: row.id, name: row.name, label: workerLabel(row.id), active: row.active, constructionDays: dates.length, firstDate: dates[0] || "", lastDate: dates.at(-1) || "", recentDate: dates.at(-1) || "", recordCount: row.recordCount };
    }).sort((left, right) => right.constructionDays - left.constructionDays || right.recordCount - left.recordCount || left.name.localeCompare(right.name, "zh-Hant"));
    const dailyRows = filteredLogs.map((log) => {
      const ids = [...new Set((log.workerIds || []).filter(Boolean))];
      return {
        id: log.id, date: text(log.log_date), timePeriod: text(log.time_period), summary: text(log.summary) || text(log.title) || "未填寫工作摘要",
        status: log.status || "in_progress", workerIds: ids,
        workerNames: ids.map(workerLabel),
        dailyHeadcount: dailyWorkers.get(text(log.log_date))?.size || 0,
      };
    });
    const constructionDates = [...projectDates].sort(compareDate);
    const primaryMaterial = materialStats[0] || null;

    return {
      error: "", materialRows, materialStats, workerStats, dailyRows,
      totalsByUnit: [...unitTotals.entries()].map(([unit, total]) => ({ unit, total })).sort((left, right) => left.unit.localeCompare(right.unit, "zh-Hant")),
      kpis: {
        materialTypeCount: materialStats.length,
        materialRecordCount: materialRows.length,
        primaryMaterial,
        constructionDays: constructionDates.length,
        workerCount: workerStats.length,
        workerDays: workerDays.size,
        recentConstructionDate: constructionDates.at(-1) || "",
      },
    };
  }

  globalObject.GUCProjectReport = Object.freeze({ buildProjectReport, inDateRange, csvCell });
})(globalThis);

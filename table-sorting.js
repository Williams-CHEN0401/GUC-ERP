/* Header-only sorting. Paginated tables sort their source rows, never just a page. */
(function(root) {
  "use strict";
  const localTables = {
    productCategoryTable: 3, customerCategoryTable: 2, customerDepartmentTable: 2,
    contractServiceTable: 3, constructionProjectTable: 5,
    dashboardWorklogTable: 4, dashboardRepairTable: 4,
    materialStatsTable: 5, materialRowsTable: 5, workerStatsTable: 6, dailyRowsTable: 5
  };
  const collator = new Intl.Collator("zh-Hant", {numeric: true});
  function compareValues(a, b, direction) {
    const empty = value => value == null || value === "" || value === "—";
    if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1;
    const result = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
    return direction === "desc" ? -result : result;
  }
  function cellValue(cell) {
    if (!cell) return "";
    if (cell.dataset.sortType === "number") {
      const value = Number(cell.dataset.sortValue);
      return Number.isFinite(value) ? value : "";
    }
    return cell.dataset.sortValue ?? cell.textContent.trim().replace(/\s+/g, " ");
  }
  function enhance(document, adapter) {
    const content = document.querySelector(".content");
    if (!content || content.dataset.headerSorting) return;
    content.dataset.headerSorting = "true";
    const view = document.defaultView, states = new Map(), originalOrder = new WeakMap();
    let sequence = 0, scheduled = false;
    function decorate(header, state) {
      let button = header.querySelector(".table-sort-button");
      if (!button) {
        const label = header.textContent.trim();
        header.dataset.sortLabel = label;
        button = document.createElement("button");
        button.type = "button"; button.className = "table-sort-button";
        const text = document.createElement("span"); text.textContent = label;
        const arrow = document.createElement("span"); arrow.className = "table-sort-arrow"; arrow.setAttribute("aria-hidden", "true");
        button.append(text, arrow); header.replaceChildren(button);
        header.scope = "col";
      }
      const active = state?.sortKey === header.dataset.key;
      const direction = active ? state.direction : "";
      const next = direction === "asc" ? "降冪" : "升冪";
      header.setAttribute("aria-sort", direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none");
      button.setAttribute("aria-label", header.dataset.sortLabel + "，點擊以" + next + "排序");
      button.title = direction ? (direction === "asc" ? "目前升冪；" : "目前降冪；") + "點擊改為" + next : "點擊以升冪排序";
      button.lastElementChild.textContent = direction === "asc" ? "↑" : direction === "desc" ? "↓" : "↕";
    }
    function refresh() {
      observer.disconnect();
      try {
        for (const header of content.querySelectorAll("th[data-table-sort]")) decorate(header, adapter?.getState(header.dataset.tableSort));
        for (const [id, columns] of Object.entries(localTables)) {
          const body = document.getElementById(id), table = body?.closest("table");
          if (!table || !content.contains(table)) continue;
          const state = states.get(id);
          Array.from(table.tHead?.rows[0]?.cells || []).slice(0, columns).forEach((header, index) => {
            header.dataset.localSort = id; header.dataset.key = String(index); decorate(header, state);
          });
          // Empty/loading rows have colspan and must never be treated as data.
          const rows = Array.from(body.rows).filter(row => row.cells.length >= columns && row.cells[0].colSpan === 1);
          for (const row of rows) if (!originalOrder.has(row)) originalOrder.set(row, sequence++);
          if (!state || rows.length < 2) continue;
          const sorted = [...rows].sort((a, b) => compareValues(cellValue(a.cells[state.sortKey]), cellValue(b.cells[state.sortKey]), state.direction) || originalOrder.get(a) - originalOrder.get(b));
          if (sorted.some((row, index) => row !== rows[index])) body.append(...sorted);
        }
      } finally {
        observer.observe(content, {childList: true, subtree: true});
      }
    }
    const observer = new view.MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      view.queueMicrotask(() => { scheduled = false; refresh(); });
    });
    content.addEventListener("click", event => {
      const header = event.target.closest("th[data-table-sort], th[data-local-sort]");
      if (!header) return;
      if (header.dataset.tableSort) adapter?.sort(header.dataset.tableSort, header.dataset.key);
      else {
        const id = header.dataset.localSort, prior = states.get(id), sortKey = header.dataset.key;
        states.set(id, {sortKey, direction: prior?.sortKey === sortKey && prior.direction === "asc" ? "desc" : "asc"});
      }
      refresh();
    });
    refresh();
  }
  root.GucTableSorting = {localTables, compareValues, cellValue, enhance};
  if (root.document) enhance(root.document, root.GucTableSortAdapter);
})(globalThis);

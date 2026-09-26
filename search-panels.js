/* Presentation-only enhancement: keep the original controls, IDs and handlers. */
(function(root) {
  "use strict";
  const selector = ".content .filterbar, .content .report-selector, .content #auditFilters";
  const fieldLabels = {
    repairStatusFilter: "維修狀態", categoryFilter: "貨品種類", productCategoryStatus: "種類狀態",
    customerCategoryFilter: "客戶分類", worklogCustomerCategoryFilter: "客戶分類",
    worklogCustomerFilter: "客戶", worklogDepartmentFilter: "科室",
    worklogProjectFilter: "工作內容", worklogTypeFilter: "工作類型"
  };
  function defaultValue(control) {
    if (control.tagName === "SELECT") {
      return Array.from(control.options).find(option => option.defaultSelected)?.value ?? control.options[0]?.value ?? "";
    }
    return control.defaultValue || "";
  }
  function describeFilters(fields) {
    return fields.filter(({control, initial}) => !control.disabled && control.value !== initial &&
      // Empty is a real filter for construction's "未分類"; do not discard it.
      (control.tagName === "SELECT" || control.value.trim()))
      .map(({control, label}) => `${label}：${control.tagName === "SELECT" ? control.selectedOptions[0]?.textContent.trim() || control.value : control.value.trim()}`);
  }
  function resetFields(fields) {
    // DOM order preserves category -> customer -> department/project dependencies.
    for (const {control, initial} of fields) {
      if (control.tagName === "SELECT") {
        control.value = Array.from(control.options).some(option => option.value === initial) ? initial : control.options[0]?.value ?? "";
      } else control.value = initial;
      control.dispatchEvent(new control.ownerDocument.defaultView.Event(control.tagName === "SELECT" || control.type === "date" ? "change" : "input", {bubbles: true}));
    }
  }
  function enhance(document) {
    const view = document.defaultView;
    const panels = [];
    let active = null;
    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const update = panel => {
      const values = panel.applied || describeFilters(panel.fields);
      panel.summary.textContent = values.length ? values.join(" · ") : "點選展開篩選條件";
      panel.summary.title = panel.summary.textContent;
      panel.count.textContent = values.length ? `${values.length} 項` : "";
      panel.count.hidden = !values.length;
    };
    const position = panel => {
      const rect = panel.trigger.getBoundingClientRect();
      const viewport = view.visualViewport;
      const width = viewport?.width || view.innerWidth, height = viewport?.height || view.innerHeight;
      const offsetTop = viewport?.offsetTop || 0, offsetLeft = viewport?.offsetLeft || 0;
      const popupWidth = Math.min(640, width - 24);
      const top = Math.max(offsetTop + 12, Math.min(rect.bottom + 8, offsetTop + height - 200));
      panel.popup.style.width = `${popupWidth}px`;
      panel.popup.style.left = `${Math.max(offsetLeft + 12, Math.min(rect.left, offsetLeft + width - popupWidth - 12))}px`;
      panel.popup.style.top = `${top}px`;
      panel.popup.style.maxHeight = `${Math.max(150, offsetTop + height - top - 12)}px`;
    };
    const close = (panel, restoreFocus = false) => {
      if (!panel) return;
      panel.popup.hidden = true;
      panel.trigger.setAttribute("aria-expanded", "false");
      if (active === panel) active = null;
      update(panel);
      if (restoreFocus) panel.trigger.focus({preventScroll: true});
    };
    document.querySelectorAll(selector).forEach((container, index) => {
      if (container.closest(".search-panel")) return;
      const controls = Array.from(container.querySelectorAll("input, select"));
      if (!controls.length) return;
      const wrapper = element("div", "search-panel");
      container.before(wrapper);
      const trigger = element("button", "search-panel-trigger");
      trigger.type = "button";
      trigger.id = `search-panel-trigger-${index}`;
      trigger.setAttribute("aria-expanded", "false");
      const icon = element("span", "search-panel-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
      const text = element("span", "search-panel-text");
      text.append(element("strong", "", "搜尋／篩選"));
      const summary = element("span", "search-panel-summary");
      text.append(summary);
      const count = element("span", "search-panel-count");
      const chevron = element("span", "search-panel-chevron", "⌄");
      chevron.setAttribute("aria-hidden", "true");
      trigger.append(icon, text, count, chevron);
      const popup = element("div", "search-panel-popup");
      popup.id = `search-panel-popup-${index}`;
      popup.hidden = true;
      popup.setAttribute("role", "region");
      popup.setAttribute("aria-labelledby", trigger.id);
      trigger.setAttribute("aria-controls", popup.id);
      const header = element("div", "search-panel-heading");
      header.append(element("strong", "", "篩選條件"));
      const dismiss = element("button", "search-panel-dismiss", "×");
      dismiss.type = "button";
      dismiss.setAttribute("aria-label", "收合篩選條件");
      header.append(dismiss);
      popup.append(header, container);
      wrapper.append(trigger, popup);
      container.classList.add("search-panel-fields");
      const fields = controls.map(control => {
        let labelNode = control.closest("label");
        const search = labelNode?.classList.contains("search");
        const label = fieldLabels[control.id] || (search ? "關鍵字" : labelNode?.textContent.split(control.textContent || "\0")[0].trim()) || control.getAttribute("aria-label") || "關鍵字";
        if (!labelNode) {
          labelNode = element("label", "");
          control.before(labelNode);
          labelNode.append(element("span", "", label), control);
        } else if (search) {
          // Retain the input node (and its bound input listener), only replace the icon text.
          labelNode.classList.remove("search");
          labelNode.replaceChildren(element("span", "", label), control);
        }
        labelNode.classList.add("search-panel-field");
        return {control, label, initial: defaultValue(control)};
      });
      const actions = element("div", "search-panel-actions");
      const reset = element("button", "outline", "重設");
      reset.type = "button";
      const existingSubmit = container.matches("form") ? container.querySelector('button:not([type]), button[type="submit"]') : null;
      const apply = existingSubmit || element("button", "primary", "搜尋");
      apply.textContent = "搜尋";
      if (!existingSubmit) apply.type = "button";
      actions.append(reset, apply);
      if (existingSubmit) container.append(actions); // Preserve the audit form's submit ownership.
      else popup.append(actions);
      const panel = {wrapper, trigger, popup, fields, summary, count, applied: existingSubmit ? [] : null};
      panels.push(panel);
      trigger.addEventListener("click", () => {
        if (active === panel) { close(panel, true); return; }
        close(active);
        active = panel;
        update(panel);
        popup.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        position(panel);
        // Touch users may only want a dropdown; do not summon the keyboard on open.
        const focusTarget = view.matchMedia("(pointer: coarse)").matches ? dismiss : fields.find(({control}) => !control.disabled)?.control;
        focusTarget?.focus({preventScroll: true});
      });
      dismiss.addEventListener("click", () => close(panel, true));
      reset.addEventListener("click", () => {
        resetFields(fields);
        if (existingSubmit) container.requestSubmit(apply);
        update(panel);
      });
      if (existingSubmit) container.addEventListener("submit", () => {
        panel.applied = describeFilters(fields);
        close(panel, true);
      });
      else apply.addEventListener("click", () => close(panel, true));
      popup.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.isComposing && event.target.tagName === "INPUT" && !existingSubmit) {
          event.preventDefault();
          close(panel, true);
        }
      });
      // Option refreshes happen after data loads and cascading customer selections.
      const observer = new view.MutationObserver(() => update(panel));
      controls.forEach(control => observer.observe(control, {childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"]}));
      update(panel);
    });
    document.addEventListener("input", () => panels.forEach(update));
    document.addEventListener("change", () => panels.forEach(update));
    document.addEventListener("pointerdown", event => {
      if (active && !active.wrapper.contains(event.target)) close(active);
    });
    document.addEventListener("focusin", event => {
      if (active && !active.wrapper.contains(event.target)) close(active);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && active) { event.preventDefault(); close(active, true); }
    });
    // Navigation (including history and nested tabs) must never leave a floating panel behind.
    const navigationObserver = new view.MutationObserver(() => {
      if (active && !active.trigger.getClientRects().length) close(active);
    });
    document.querySelectorAll(".page, .tab-pane, [role=tabpanel]").forEach(node => navigationObserver.observe(node, {attributes: true, attributeFilter: ["class", "hidden"]}));
    const reposition = () => { if (active) position(active); };
    view.addEventListener("resize", reposition);
    view.addEventListener("scroll", reposition);
    view.visualViewport?.addEventListener("resize", reposition);
    view.visualViewport?.addEventListener("scroll", reposition);
    return panels;
  }
  root.GucSearchPanels = {selector, defaultValue, describeFilters, resetFields, enhance};
  if (root.document) enhance(root.document);
})(globalThis);

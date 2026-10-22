/* Native input values remain untouched; only committed text reaches existing handlers. */
(function (root) {
  'use strict';
  const normalize = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-Hant');
  const matches = (values, term) => { const query = normalize(term); return !query || values.some(value => normalize(value).includes(query)); };
  const composing = new WeakMap();
  const value = target => composing.has(target) ? composing.get(target) : target?.value || '';
  function hint(field) {
    if (!field?.matches?.('input,textarea')) return;
    const type = field.tagName === 'TEXTAREA' ? 'textarea' : field.getAttribute('type') || 'text';
    if (['text','search','textarea'].includes(type)) {
      if (type === 'text' && !field.hasAttribute('type')) field.type = 'text';
      if (!field.hasAttribute('lang')) field.lang = 'zh-TW';
      if (!field.hasAttribute('inputmode')) field.inputMode = 'text';
    } else if (type === 'number' && !field.hasAttribute('inputmode')) {
      const step = field.getAttribute('step');
      field.inputMode = step === 'any' || (step != null && Number(step) % 1 !== 0) ? 'decimal' : 'numeric';
    } else if (type === 'tel' && !field.hasAttribute('inputmode')) field.inputMode = 'tel';
  }
  function hints(node) { hint(node); node?.querySelectorAll?.('input,textarea').forEach(hint); }
  function install(document) {
    hints(document);
    if (document.defaultView?.MutationObserver) new document.defaultView.MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) hints(node);
    }).observe(document.documentElement, {childList:true,subtree:true});
    // Covers fields created and focused in the same synchronous event handler.
    document.addEventListener('focusin', event => hint(event.target), true);
    const textField = target => target?.matches?.('input:not([type]),input[type=text],input[type=search],textarea');
    document.addEventListener('compositionstart', event => { if (textField(event.target)) composing.set(event.target,event.target.value); }, true);
    document.addEventListener('input', event => {
      if (textField(event.target) && (event.isComposing || composing.has(event.target))) event.stopImmediatePropagation();
    }, true);
    document.addEventListener('compositionend', event => {
      if (!textField(event.target)) return;
      composing.delete(event.target);
      event.target.dispatchEvent(new document.defaultView.Event('input', {bubbles: true}));
    }, true);
    document.addEventListener('keydown', event => {
      if (event.isComposing || composing.has(event.target) || event.keyCode === 229) {
        // Keep the IME confirmation key from submitting a form or closing its search panel.
        if (event.key === 'Enter') event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }
  root.GucSearchInput = {normalize, matches, value, install, hints};
  if (root.document) install(root.document);
})(globalThis);

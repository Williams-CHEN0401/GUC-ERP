/* Native input values remain untouched; only committed text reaches existing handlers. */
(function (root) {
  'use strict';
  const normalize = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-Hant');
  const matches = (values, term) => { const query = normalize(term); return !query || values.some(value => normalize(value).includes(query)); };
  const composing = new WeakMap();
  const value = target => composing.has(target) ? composing.get(target) : target?.value || '';
  function install(document) {
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
      if (event.key === 'Enter' && (event.isComposing || composing.has(event.target) || event.keyCode === 229)) {
        // Keep the IME confirmation key from submitting a form or closing its search panel.
        event.stopImmediatePropagation();
      }
    }, true);
  }
  root.GucSearchInput = {normalize, matches, value, install};
  if (root.document) install(root.document);
})(globalThis);

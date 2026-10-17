const vscode = acquireVsCodeApi();
const original = document.getElementById('original');
const modified = document.getElementById('modified');
let page = 0;
let pendingFocus;
let alignFrame;
let synchronizing = false;
const expectedScroll = new WeakMap();

const alignRows = () => {
  const left = Array.from(original.querySelectorAll('tbody tr'));
  const right = Array.from(modified.querySelectorAll('tbody tr'));
  [...left, ...right].forEach(row => { row.style.height = ''; });
  left.forEach((row, index) => {
    if (!right[index]) return;
    const height = Math.ceil(Math.max(row.getBoundingClientRect().height, right[index].getBoundingClientRect().height));
    row.style.height = right[index].style.height = `${height}px`;
  });
  if (Number.isInteger(pendingFocus)) {
    [original, modified].forEach(pane => {
      const row = pane.querySelector(`[data-align="${pendingFocus}"]`);
      if (row) {
        row.classList.add('focused');
        const header = pane.querySelector('thead');
        pane.scrollTop = Math.max(0, pane.scrollTop + row.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop - (header?.getBoundingClientRect().height || 0));
      }
    });
    pendingFocus = undefined;
  }
};
const queueAlignment = () => {
  if (alignFrame) cancelAnimationFrame(alignFrame);
  alignFrame = requestAnimationFrame(alignRows);
};

[[original, modified], [modified, original]].forEach(([source, target]) => {
  source.addEventListener('scroll', () => {
    if (synchronizing) return;
    const expected = expectedScroll.get(source);
    if (expected && Math.abs(source.scrollTop - expected.top) < 1 && Math.abs(source.scrollLeft - expected.left) < 1) {
      expectedScroll.delete(source);
      return;
    }
    expectedScroll.set(target, { top: source.scrollTop, left: source.scrollLeft });
    synchronizing = true;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    synchronizing = false;
  }, { passive: true });
});

const buttons = ['previousPage', 'nextPage', 'previousChange', 'nextChange'].map(id => document.getElementById(id));
const request = message => {
  buttons.forEach(button => { button.disabled = true; });
  vscode.postMessage(message);
};
buttons[0].addEventListener('click', () => request({ type: 'page', index: page - 1 }));
buttons[1].addEventListener('click', () => request({ type: 'page', index: page + 1 }));
buttons[2].addEventListener('click', () => request({ type: 'change', direction: -1 }));
buttons[3].addEventListener('click', () => request({ type: 'change', direction: 1 }));
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type !== 'comparison') return;
  original.innerHTML = message.originalHtml;
  modified.innerHTML = message.modifiedHtml;
  [original, modified].forEach(pane => {
    const table = pane.querySelector('table');
    if (table) table.style.width = `${60 + Number(table.dataset.columns) * 180}px`;
    pane.scrollTop = pane.scrollLeft = 0;
    expectedScroll.delete(pane);
  });
  page = message.page;
  document.getElementById('status').textContent = message.status;
  document.getElementById('error').textContent = message.error || '';
  document.getElementById('notice').textContent = message.notice || '';
  buttons[0].disabled = page <= 0;
  buttons[1].disabled = page >= message.pageCount - 1;
  buttons[2].disabled = !message.canPreviousChange;
  buttons[3].disabled = !message.canNextChange;
  pendingFocus = message.focusRecord;
  queueAlignment();
});
if (typeof ResizeObserver === 'function') {
  const observer = new ResizeObserver(queueAlignment);
  observer.observe(original);
  observer.observe(modified);
}
window.addEventListener('resize', queueAlignment);
request({ type: 'ready' });

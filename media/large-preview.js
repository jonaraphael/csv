const vscode = acquireVsCodeApi();
const status = document.getElementById('status');
const records = document.getElementById('records');
const error = document.getElementById('error');
const buttons = ['start', 'previous', 'next'].map(id => document.getElementById(id));
const busy = () => {
  buttons.forEach(button => { button.disabled = true; });
  status.textContent = 'Loading saved file…';
};
buttons.forEach(button => {
  button.addEventListener('click', () => {
    busy();
    vscode.postMessage({ type: button.id });
  });
});
window.addEventListener('message', event => {
  if (event.data.type !== 'page') return;
  const message = event.data;
  // Markup is built by the extension from escaped cell values. Replacing the
  // page bounds DOM growth regardless of how many pages have been visited.
  records.innerHTML = message.html;
  records.scrollTop = records.scrollLeft = 0;
  status.textContent = message.status;
  error.textContent = message.error || '';
  buttons[0].disabled = false;
  buttons[1].disabled = !message.canBack;
  buttons[2].disabled = !message.canNext;
});
busy();
vscode.postMessage({ type: 'ready' });

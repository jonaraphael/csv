// Webview script moved out of inline <script>. Kept logic changes minimal.

document.body.setAttribute('tabindex', '0');
document.body.focus();

const vscode = acquireVsCodeApi();

const root = document.getElementById('csv-root');
const CSV_SEPARATOR = String.fromCodePoint(parseInt(root?.dataset?.sepcode || '44', 10)); // default ','

let lastContextIsHeader = false;   // remembers whether we right-clicked a <th>
let isUpdating = false, isSelecting = false, anchorCell = null, rangeEndCell = null, currentSelection = [];
let startCell = null, endCell = null, selectionMode = "cell";
let editingCell = null, originalCellValue = "";

const table = document.querySelector('#csv-root table');

/* ──────────── VIRTUAL-SCROLL LOADER ──────────── */
const CHUNK_SIZE = 1000;
// We use a <template> to carry JSON so CSP doesn't block it like a <script> might
const chunkTemplate = document.getElementById('__csvChunks');
let csvChunks = chunkTemplate ? JSON.parse(chunkTemplate.textContent || '[]') : [];

if (csvChunks.length) {
  const scrollContainer = document.querySelector('.table-container');
  const tbody           = table.tBodies[0];

  const loadNextChunk = () => {
    if (!csvChunks.length || !tbody) return;
    tbody.insertAdjacentHTML('beforeend', csvChunks.shift());
  };

  const io = new IntersectionObserver((entries)=>{
    if (entries[0].isIntersecting) {
      loadNextChunk();
      const last = tbody && tbody.querySelector('tr:last-child');
      if (last) io.observe(last);
    }
  }, { root: scrollContainer, rootMargin: '0px 0px 200px 0px' });

  const initialLast = tbody && tbody.querySelector('tr:last-child');
  if (initialLast) io.observe(initialLast);
}
/* ───────── END VIRTUAL-SCROLL LOADER ───────── */

const hasHeader = document.querySelector('thead') !== null;
const getCellCoords = cell => ({ row: parseInt(cell.getAttribute('data-row')), col: parseInt(cell.getAttribute('data-col')) });
const clearSelection = () => { currentSelection.forEach(c => c.classList.remove('selected')); currentSelection = []; };
const contextMenu = document.getElementById('contextMenu');

/* ──────── UPDATED showContextMenu ──────── */
const showContextMenu = (x, y, row, col) => {
  contextMenu.innerHTML = '';
  const item = (label, cb) => {
    const d = document.createElement('div');
    d.textContent = label;
    d.addEventListener('click', () => { cb(); contextMenu.style.display = 'none'; });
    contextMenu.appendChild(d);
  };
  const divider = () => {
    const d = document.createElement('div');
    d.style.borderTop = '1px solid #888';
    d.style.margin = '1px 0';
    contextMenu.appendChild(d);
  };
  let addedRowItems = false;

  /* Header-only: SORT functionality */
  if (lastContextIsHeader) {
    item('Sort: A-Z', () =>
      vscode.postMessage({ type: 'sortColumn', index: col, ascending: true }));
    item('Sort: Z-A', () =>
      vscode.postMessage({ type: 'sortColumn', index: col, ascending: false }));
  }        

  /* Row section */
  if (!isNaN(row) && row >= 0) {
    if (contextMenu.children.length) divider();
    item('Add ROW: above', () => vscode.postMessage({ type: 'insertRow',   index: row     }));
    item('Add ROW: below', () => vscode.postMessage({ type: 'insertRow',   index: row + 1 }));
    item('Delete ROW',      () => vscode.postMessage({ type: 'deleteRow',  index: row     }));
    addedRowItems = true;
  }

  /* Column section, preceded by divider if row items exist */
  if (!isNaN(col) && col >= 0) {
    if (addedRowItems) divider();
    item('Add COLUMN: left',  () => vscode.postMessage({ type: 'insertColumn', index: col     }));
    item('Add COLUMN: right', () => vscode.postMessage({ type: 'insertColumn', index: col + 1 }));
    item('Delete COLUMN',     () => vscode.postMessage({ type: 'deleteColumn', index: col     }));
  }

  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.style.display = 'block';
};

document.addEventListener('click', () => { contextMenu.style.display = 'none'; });

/* ──────── UPDATED contextmenu listener ──────── */
table.addEventListener('contextmenu', e => {
  const target = e.target;
  if(target.tagName !== 'TH' && target.tagName !== 'TD') return;
  const colAttr = target.getAttribute('data-col');
  const rowAttr = target.getAttribute('data-row');
  const col = parseInt(colAttr);
  const row = parseInt(rowAttr);
  if ((isNaN(col) || col === -1) && (isNaN(row) || row === -1)) return;
  e.preventDefault();
  lastContextIsHeader = target.tagName === 'TH';
  showContextMenu(e.pageX, e.pageY, row, col);
});

table.addEventListener('mousedown', e => {
  if(e.target.tagName !== 'TD' && e.target.tagName !== 'TH') return;
  const target = e.target;

  // ──────── NEW: Shift+Click range selection ────────
  if (
    e.shiftKey &&
    anchorCell &&
    !editingCell &&
    target.getAttribute('data-row') !== null &&
    target.getAttribute('data-col') !== null &&
    anchorCell.getAttribute('data-row') !== null &&
    anchorCell.getAttribute('data-col') !== null &&
    target.getAttribute('data-col') !== '-1' &&
    anchorCell.getAttribute('data-col') !== '-1'
  ) {
    e.preventDefault();
    selectRange(
      getCellCoords(anchorCell),
      getCellCoords(target)
    );
    rangeEndCell = target;
    anchorCell.focus();
    return;
  }

  if(editingCell){ if(e.target !== editingCell) editingCell.blur(); else return; } else clearSelection();

  /* ──────── NEW: select-all via top-left header cell ──────── */
  if (
    target.tagName === 'TH' &&                 // header cell
    !target.hasAttribute('data-col') &&        // serial-index header has *no* data-col
    !target.hasAttribute('data-row')           // and no data-row
  ) {
    e.preventDefault();
    clearSelection();
    selectAllCells();
    isSelecting = false;
    anchorCell  = null;
    return;
  }
  /* ──────── END NEW BLOCK ──────── */
  
  selectionMode = (target.tagName === 'TH') ? "column" : (target.getAttribute('data-col') === '-1' ? "row" : "cell");
  startCell = target; endCell = target; rangeEndCell = target; isSelecting = true; e.preventDefault();
  target.focus();
});

table.addEventListener('mousemove', e => {
  if(!isSelecting) return;
  let target = e.target;
  if(selectionMode === "cell"){
    if(target.tagName === 'TD' || target.tagName === 'TH'){
      endCell = target;
      rangeEndCell = target;
      selectRange(getCellCoords(startCell), getCellCoords(endCell));
    }
  } else if(selectionMode === "column"){
    if(target.tagName !== 'TH'){
      const col = target.getAttribute('data-col');
      target = table.querySelector('thead th[data-col="'+col+'"]') || target;
    }
    endCell = target;
    rangeEndCell = target;
    const startCol = parseInt(startCell.getAttribute('data-col'));
    const endCol = parseInt(endCell.getAttribute('data-col'));
    selectFullColumnRange(startCol, endCol);
  } else if(selectionMode === "row"){
    if(target.getAttribute('data-col') !== '-1'){
      const row = target.getAttribute('data-row');
      target = table.querySelector('td[data-col="-1"][data-row="'+row+'"]') || target;
    }
    endCell = target;
    rangeEndCell = target;
    const startRow = parseInt(startCell.getAttribute('data-row'));
    const endRow = parseInt(endCell.getAttribute('data-row'));
    selectFullRowRange(startRow, endRow);
  }
});

table.addEventListener('mouseup', e => {
  if(!isSelecting) return;
  isSelecting = false;
  if(selectionMode === "cell"){
    if(startCell === endCell){
      clearSelection();
      startCell.classList.add('selected');
      currentSelection.push(startCell);
    }
    anchorCell = startCell;
    rangeEndCell = endCell;
  } else if(selectionMode === "column"){
    const startCol = parseInt(startCell.getAttribute('data-col'));
    const endCol = parseInt(endCell.getAttribute('data-col'));
    selectFullColumnRange(startCol, endCol); anchorCell = startCell; rangeEndCell = endCell;
  } else if(selectionMode === "row"){
    const startRow = parseInt(startCell.getAttribute('data-row'));
    const endRow = parseInt(endCell.getAttribute('data-row'));
    selectFullRowRange(startRow, endRow); anchorCell = startCell; rangeEndCell = endCell;
  }
});

const selectRange = (start, end) => {
  clearSelection();
  const minRow = Math.min(start.row, end.row), maxRow = Math.max(start.row, end.row);
  const minCol = Math.min(start.col, end.col), maxCol = Math.max(start.col, end.col);
  for(let r = minRow; r <= maxRow; r++){
    for(let c = minCol; c <= maxCol; c++){
      const selector = (hasHeader && r === 0 ? 'th' : 'td') + '[data-row="'+r+'"][data-col="'+c+'"]';
      const selCell = table.querySelector(selector);
      if(selCell){ selCell.classList.add('selected'); currentSelection.push(selCell); }
    }
  }
};

const selectFullColumnRange = (col1, col2) => {
  clearSelection();
  const minCol = Math.min(col1, col2), maxCol = Math.max(col1, col2);
  table.querySelectorAll('tr').forEach(row => {
    Array.from(row.children).forEach(cell => {
      const cellCol = cell.getAttribute('data-col');
      if(cellCol !== null && parseInt(cellCol) >= minCol && parseInt(cellCol) <= maxCol){
        cell.classList.add('selected'); currentSelection.push(cell);
      }
    });
  });
};

const selectFullRowRange = (row1, row2) => {
  clearSelection();
  const minRow = Math.min(row1, row2), maxRow = Math.max(row1, row2);
  table.querySelectorAll('tr').forEach(row => {
    Array.from(row.children).forEach(cell => {
      const r = cell.getAttribute('data-row');
      if(r !== null && parseInt(r) >= minRow && parseInt(r) <= maxRow){
        cell.classList.add('selected'); currentSelection.push(cell);
      }
    });
  });
};

const findWidget = document.getElementById('findWidget');
const findInput = document.getElementById('findInput');
const findStatus = document.getElementById('findStatus');
const findClose = document.getElementById('findClose');
let findMatches = [];
let currentMatchIndex = -1;

const updateFindStatus = () => {
  findStatus.innerText = findMatches.length > 0 ? (currentMatchIndex+1) + " of " + findMatches.length + " (Cmd+G to advance)" : "";
};
const updateFindMatches = () => {
  const query = findInput.value.toLowerCase();
  document.querySelectorAll('.highlight, .active-match').forEach(el => { el.classList.remove('highlight'); el.classList.remove('active-match'); });
  findMatches = [];
  if(query === ""){ updateFindStatus(); return; }
  document.querySelectorAll('td, th').forEach(cell => {
    if(cell.innerText.toLowerCase().includes(query)){
      findMatches.push(cell); cell.classList.add('highlight');
    }
  });
  if(findMatches.length > 0){
    currentMatchIndex = 0;
    findMatches[currentMatchIndex].classList.add('active-match');
    findMatches[currentMatchIndex].scrollIntoView({block:'center', inline:'center', behavior:'smooth'});
  }
  updateFindStatus();
};
findInput.addEventListener('input', updateFindMatches);
findInput.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    findWidget.style.display = 'none'; findInput.value = "";
    document.querySelectorAll('.highlight, .active-match').forEach(el => { el.classList.remove('highlight'); el.classList.remove('active-match'); });
    findStatus.innerText = ""; findInput.blur();
  }
  if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g'){
    e.preventDefault();
    if(findMatches.length === 0) return;
    findMatches[currentMatchIndex].classList.remove('active-match');
    currentMatchIndex = e.shiftKey ? (currentMatchIndex - 1 + findMatches.length) % findMatches.length : (currentMatchIndex + 1) % findMatches.length;
    findMatches[currentMatchIndex].classList.add('active-match');
    findMatches[currentMatchIndex].scrollIntoView({block:'center', inline:'center', behavior:'smooth'});
    updateFindStatus();
  }
});
findClose.addEventListener('click', () => { findWidget.style.display = 'none'; findInput.value = "";
  document.querySelectorAll('.highlight, .active-match').forEach(el => { el.classList.remove('highlight'); el.classList.remove('active-match'); });
  findStatus.innerText = ""; findInput.blur();
});

// Capture-phase handler to intercept Cmd/Ctrl + Arrow and move to extremes
document.addEventListener('keydown', e => {
  const isArrowKey = (k) => ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Up','Down','Left','Right','Home','End','PageUp','PageDown'].includes(k);
  if (!editingCell && (e.ctrlKey || e.metaKey) && isArrowKey(e.key)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();

    const sc = document.querySelector('.table-container');
    if (sc) {
      if (['ArrowLeft','Left','Home'].includes(e.key))  sc.scrollTo({ left: 0, behavior: 'smooth' });
      if (['ArrowRight','Right','End'].includes(e.key)) sc.scrollTo({ left: sc.scrollWidth, behavior: 'smooth' });
    }
    if (['ArrowUp','Up','PageUp'].includes(e.key)) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (['ArrowDown','Down','PageDown'].includes(e.key)) {
      const h = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
      window.scrollTo({ top: h, behavior: 'smooth' });
    }

    const ref = anchorCell || currentSelection[0] || document.querySelector('td.selected, th.selected') || document.querySelector('td, th');
    let target = null;
    if (ref) {
      const { row, col } = getCellCoords(ref);
      if (['ArrowLeft','Left','Home'].includes(e.key)) {
        const tag = (hasHeader && row === 0 ? 'th' : 'td');
        const rowCells = Array.from(table.querySelectorAll(tag + '[data-row="'+row+'"]'))
          .filter(el => el.getAttribute('data-col') !== null && el.getAttribute('data-col') !== '-1');
        const min = rowCells.reduce((acc, el) => Math.min(acc, parseInt(el.getAttribute('data-col'))), Infinity);
        target = rowCells.find(el => parseInt(el.getAttribute('data-col')) === min) || ref;
      } else if (['ArrowRight','Right','End'].includes(e.key)) {
        const tag = (hasHeader && row === 0 ? 'th' : 'td');
        const rowCells = Array.from(table.querySelectorAll(tag + '[data-row="'+row+'"]'))
          .filter(el => el.getAttribute('data-col') !== null && el.getAttribute('data-col') !== '-1');
        const max = rowCells.reduce((acc, el) => Math.max(acc, parseInt(el.getAttribute('data-col'))), -1);
        target = rowCells.find(el => parseInt(el.getAttribute('data-col')) === max) || ref;
      } else if (['ArrowUp','Up','PageUp'].includes(e.key)) {
        target = hasHeader
          ? (table.querySelector('th[data-row="0"][data-col="'+col+'"]') || ref)
          : (table.querySelector('td[data-row="0"][data-col="'+col+'"]') || ref);
      } else if (['ArrowDown','Down','PageDown'].includes(e.key)) {
        const colCells = Array.from(table.querySelectorAll('td[data-col="'+col+'"]'));
        target = (colCells.length ? colCells[colCells.length - 1] : null) || ref;
      }
    }

    if (target) {
      clearSelection();
      target.classList.add('selected');
      currentSelection.push(target);
      anchorCell = target;
      rangeEndCell = target;
      target.focus({preventScroll:true});
      if (['ArrowUp','Up','PageUp'].includes(e.key)) {
        const belowRowIndex = hasHeader ? 1 : 0;
        const below = table.querySelector('td[data-row="'+belowRowIndex+'"][data-col="'+getCellCoords(target).col+'"]');
        if (below) {
          below.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        } else {
          target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        }
      } else {
        target.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'smooth' });
      }
    }
  }
}, true);

document.addEventListener('keydown', e => {
  if((e.ctrlKey || e.metaKey) && e.key === 'f'){
    e.preventDefault(); findWidget.style.display = 'block'; findInput.focus(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !editingCell) {
    e.preventDefault(); selectAllCells(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'c' && currentSelection.length > 0) {
    e.preventDefault(); copySelectionToClipboard(); return;
  }

  const isArrowKey = (k) => ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Up','Down','Left','Right','Home','End','PageUp','PageDown'].includes(k);
  if (!editingCell && (e.ctrlKey || e.metaKey) && isArrowKey(e.key)) {
    e.preventDefault();
    const sc = document.querySelector('.table-container');
    if (sc) {
      if (['ArrowLeft','Left','Home'].includes(e.key))  sc.scrollTo({ left: 0, behavior: 'smooth' });
      if (['ArrowRight','Right','End'].includes(e.key)) sc.scrollTo({ left: sc.scrollWidth, behavior: 'smooth' });
      if (['ArrowUp','Up','PageUp'].includes(e.key))    sc.scrollTo({ top: 0, behavior: 'smooth' });
      if (['ArrowDown','Down','PageDown'].includes(e.key))  sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
    }

    let refCell = anchorCell;
    if (!refCell) {
      refCell = currentSelection[0] || document.querySelector('td.selected, th.selected');
    }
    let target = null;
    if (refCell) {
      const { row, col } = getCellCoords(refCell);
      if (['ArrowLeft','Left','Home'].includes(e.key)) {
        const tag = (hasHeader && row === 0 ? 'th' : 'td');
        const rowCells = Array.from(table.querySelectorAll(tag + '[data-row="'+row+'"]'))
          .filter(el => el.getAttribute('data-col') !== null && el.getAttribute('data-col') !== '-1');
        const min = rowCells.reduce((acc, el) => Math.min(acc, parseInt(el.getAttribute('data-col'))), Infinity);
        target = rowCells.find(el => parseInt(el.getAttribute('data-col')) === min) || refCell;
      } else if (['ArrowRight','Right','End'].includes(e.key)) {
        const tag = (hasHeader && row === 0 ? 'th' : 'td');
        const rowCells = Array.from(table.querySelectorAll(tag + '[data-row="'+row+'"]'))
          .filter(el => el.getAttribute('data-col') !== null && el.getAttribute('data-col') !== '-1');
        const max = rowCells.reduce((acc, el) => Math.max(acc, parseInt(el.getAttribute('data-col'))), -1);
        target = rowCells.find(el => parseInt(el.getAttribute('data-col')) === max) || refCell;
      } else if (['ArrowUp','Up','PageUp'].includes(e.key)) {
        if (hasHeader) {
          target = table.querySelector('th[data-row="0"][data-col="'+col+'"]') || refCell;
        } else {
          target = table.querySelector('td[data-row="0"][data-col="'+col+'"]') || refCell;
        }
      } else if (['ArrowDown','Down','PageDown'].includes(e.key)) {
        const colCells = Array.from(table.querySelectorAll('td[data-col="'+col+'"]'));
        target = (colCells.length ? colCells[colCells.length - 1] : null) || refCell;
      }
    }

    if (target) {
      clearSelection();
      target.classList.add('selected');
      currentSelection.push(target);
      anchorCell = target;
      rangeEndCell = target;
      target.focus({preventScroll:true});
      target.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'smooth' });
    }
    return;
  }

  /* ──────── NEW: ENTER + DIRECT TYPING HANDLERS ──────── */
  if (!editingCell && anchorCell && currentSelection.length === 1) {
    if (e.key === 'Enter') {
      e.preventDefault();
      editCell(anchorCell);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const cell = anchorCell;
      editCell(cell);
      cell.innerText = '';
      if (document.execCommand) {
        document.execCommand('insertText', false, e.key);
      } else {
        cell.innerText = e.key;
      }
      setCursorToEnd(cell);
      return;
    }
  }

  /* ──────── ARROW KEY NAVIGATION ──────── */
  if (!editingCell && anchorCell && e.shiftKey && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    const { row, col } = getCellCoords(rangeEndCell || anchorCell);
    let targetRow = row, targetCol = col;
    switch(e.key){
      case 'ArrowUp':   targetRow = row - 1; break;
      case 'ArrowDown': targetRow = row + 1; break;
      case 'ArrowLeft': targetCol = col - 1; break;
      case 'ArrowRight':targetCol = col + 1; break;
    }
    if(targetRow < 0 || targetCol < 0) return;
    const tag = (hasHeader && targetRow === 0 ? 'th' : 'td');
    const nextCell = table.querySelector(`${tag}[data-row="${targetRow}"][data-col="${targetCol}"]`);
    if(nextCell){
      e.preventDefault();
      rangeEndCell = nextCell;
      selectRange(getCellCoords(anchorCell), getCellCoords(rangeEndCell));
      anchorCell.focus({preventScroll:true});
      rangeEndCell.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'smooth' });
    }
    return;
  }

  if (!editingCell && anchorCell && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    const { row, col } = getCellCoords(anchorCell);
    let targetRow = row, targetCol = col;
    switch(e.key){
      case 'ArrowUp':   targetRow = row - 1; break;
      case 'ArrowDown': targetRow = row + 1; break;
      case 'ArrowLeft': targetCol = col - 1; break;
      case 'ArrowRight':targetCol = col + 1; break;
    }
    if(targetRow < 0 || targetCol < 0) return;
    const tag = (hasHeader && targetRow === 0 ? 'th' : 'td');
    const nextCell = table.querySelector(`${tag}[data-row="${targetRow}"][data-col="${targetCol}"]`);
    if(nextCell){
      e.preventDefault();
      clearSelection();
      nextCell.classList.add('selected');
      currentSelection.push(nextCell);
      anchorCell = nextCell;
      rangeEndCell = nextCell;
      nextCell.focus({preventScroll:true});
      nextCell.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'smooth' });
    }
    return;
  }

  if (editingCell && ((e.ctrlKey || e.metaKey) && e.key === 's')) {
    e.preventDefault();
    editingCell.blur();
    vscode.postMessage({ type: 'save' });
  }
  if (editingCell && e.key === 'Enter') {
    e.preventDefault();
    const { row, col } = getCellCoords(editingCell);
    editingCell.blur();
    const nextCell = table.querySelector('td[data-row="'+(row+1)+'"][data-col="'+col+'"]');
    if (nextCell) editCell(nextCell);
  }
  if (editingCell && e.key === 'Tab') {
    e.preventDefault();
    const { row, col } = getCellCoords(editingCell);
    editingCell.blur();
    let nextCell;
    if (e.shiftKey) {
      nextCell = table.querySelector('td[data-row="'+row+'"][data-col="'+(col-1)+'"]');
    } else {
      nextCell = table.querySelector('td[data-row="'+row+'"][data-col="'+(col+1)+'"]');
    }
    if (nextCell) {
      editCell(nextCell);
    }
  }
  if (editingCell && e.key === 'Escape') {
    e.preventDefault(); editingCell.innerText = originalCellValue; editingCell.blur();
  }
  if (!editingCell && e.key === 'Escape') {
    clearSelection();
  }
});

const selectAllCells = () => { clearSelection(); document.querySelectorAll('td, th').forEach(cell => { cell.classList.add('selected'); currentSelection.push(cell); }); };

const setCursorToEnd = cell => { setTimeout(() => { 
  const range = document.createRange(); range.selectNodeContents(cell); range.collapse(false);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
}, 10); };

const setCursorAtPoint = (cell, x, y) => {
  let range;
  if(document.caretRangeFromPoint) { range = document.caretRangeFromPoint(x,y); }
  else if(document.caretPositionFromPoint) { let pos = document.caretPositionFromPoint(x,y); range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  if(range){ let sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
};

const editCell = (cell, event) => {
  if(editingCell === cell) return;
  if(editingCell) editingCell.blur();
  cell.classList.remove('selected');
  originalCellValue = cell.textContent;
  editingCell = cell;
  cell.classList.add('editing');
  cell.setAttribute('contenteditable', 'true');
  cell.focus();
  const onBlurHandler = () => {
    const value = cell.textContent;
    const coords = getCellCoords(cell);
    vscode.postMessage({ type: 'editCell', row: coords.row, col: coords.col, value: value });
    cell.removeAttribute('contenteditable');
    cell.classList.remove('editing');
    editingCell = null;
    cell.removeEventListener('blur', onBlurHandler);
  };
  cell.addEventListener('blur', onBlurHandler);
  event ? setCursorAtPoint(cell, event.clientX, event.clientY) : setCursorToEnd(cell);
};

table.addEventListener('dblclick', e => { const target = e.target; if(target.tagName !== 'TD' && target.tagName !== 'TH') return; clearSelection(); editCell(target, e); });

const copySelectionToClipboard = () => {
  if (currentSelection.length === 0) return;

  const coords = currentSelection
    .map(cell => getCellCoords(cell))
    .filter(c => !isNaN(c.row) && !isNaN(c.col));
  if (coords.length === 0) return;
  const minRow = Math.min(...coords.map(c => c.row)), maxRow = Math.max(...coords.map(c => c.row));
  const minCol = Math.min(...coords.map(c => c.col)), maxCol = Math.max(...coords.map(c => c.col));
  let csv = '';
  for(let r = minRow; r <= maxRow; r++){
    let rowVals = [];
    for(let c = minCol; c <= maxCol; c++){
      const selector = (hasHeader && r === 0 ? 'th' : 'td') + '[data-row="'+r+'"][data-col="'+c+'"]';
      const cell = table.querySelector(selector);
      rowVals.push(cell ? cell.innerText : '');
    }
    csv += rowVals.join(CSV_SEPARATOR) + '\n';
  }
  vscode.postMessage({ type: 'copyToClipboard', text: csv.trimEnd() });
};

window.addEventListener('message', event => {
  const message = event.data;
  if(message.type === 'focus'){
    document.body.focus();
  } else if(message.type === 'updateCell'){
    isUpdating = true;
    const { row, col, value } = message;
    const cell = table.querySelector('td[data-row="'+row+'"][data-col="'+col+'"]');
    if (cell) { cell.textContent = value; }
    isUpdating = false;
  }
});

document.addEventListener('keydown', e => {
  if(!editingCell && e.key === 'Escape'){
    clearSelection();
  }
});

// Webview script moved out of inline <script>. Kept logic changes minimal.

document.body.setAttribute('tabindex', '0');
try { document.body.focus({ preventScroll: true }); } catch { try { document.body.focus(); } catch {} }

const vscode = acquireVsCodeApi();

const root = document.getElementById('csv-root');
const CSV_SEPARATOR = String.fromCodePoint(parseInt(root?.dataset?.sepcode || '44', 10)); // default ','
const parsePositiveNumber = value => {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};
const configuredFontSizePx = parsePositiveNumber(root?.dataset?.fontsize);
const computedFontSizePx = parsePositiveNumber(window.getComputedStyle(document.body).fontSize);
const BASE_FONT_SIZE_PX = configuredFontSizePx ?? computedFontSizePx ?? 14;
const MIN_ROW_HEIGHT = Math.max(22, Math.round(BASE_FONT_SIZE_PX * 1.6));

let lastContextIsHeader = false;   // remembers whether we right-clicked a <th>
let isUpdating = false, isSelecting = false, anchorCell = null, rangeEndCell = null, currentSelection = [];
let startCell = null, endCell = null, selectionMode = "cell";
let editingCell = null, originalCellValue = "";
// Edit mode:
//  - 'quick': started by typing a character (not Enter)
//  - 'detail': started by Enter or double-click
let editMode = null; // 'quick' | 'detail' | null
const DRAG_THRESHOLD_PX = 4;
const RESIZE_HANDLE_PX = 6;
let resizeState = null;
let reorderState = null;

const table = document.querySelector('#csv-root table');
const scrollContainer = document.querySelector('.table-container');
const dragIndicator = document.createElement('div');
dragIndicator.style.position = 'fixed';
dragIndicator.style.pointerEvents = 'none';
dragIndicator.style.zIndex = '20000';
dragIndicator.style.background = '#0a84ff';
dragIndicator.style.display = 'none';
document.body.appendChild(dragIndicator);
let columnSizeState = {};
let rowSizeState = {};

const normalizeSizeState = (raw, minSize) => {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const idx = parseInt(k, 10);
    const size = Number(v);
    if (!Number.isFinite(idx) || idx < 0) continue;
    if (!Number.isFinite(size) || size < minSize) continue;
    out[String(idx)] = Math.round(size);
  }
  return out;
};

const applySizeStateToRenderedCells = () => {
  for (const [col, width] of Object.entries(columnSizeState)) {
    const px = Math.max(40, Math.round(Number(width)));
    table.querySelectorAll(`[data-col="${col}"]`).forEach(cell => {
      cell.style.width = `${px}px`;
      cell.style.minWidth = `${px}px`;
      cell.style.maxWidth = `${px}px`;
    });
  }
  for (const [row, height] of Object.entries(rowSizeState)) {
    const px = Math.max(MIN_ROW_HEIGHT, Math.round(Number(height)));
    table.querySelectorAll(`[data-row="${row}"]`).forEach(cell => {
      cell.style.height = `${px}px`;
      cell.style.minHeight = `${px}px`;
    });
  }
};

const getFirstDataRow = () => {
  const cells = Array.from(table.querySelectorAll('tbody td[data-col]:not([data-col="-1"])'));
  let min = Infinity;
  for (const el of cells) {
    const v = parseInt(el.getAttribute('data-row') || 'NaN', 10);
    if (!Number.isNaN(v)) min = Math.min(min, v);
  }
  return Number.isFinite(min) ? min : 0;
};

// Persist/restore view state (scroll + selection) across webview reloads
const persistState = () => {
  try {
    const st = vscode.getState() || {};
    const anchor = anchorCell ? getCellCoords(anchorCell) : null;
    const nextState = {
      ...st,
      scrollX: scrollContainer ? scrollContainer.scrollLeft : 0,
      scrollY: scrollContainer ? scrollContainer.scrollTop : (window.scrollY || window.pageYOffset || 0),
      anchorRow: anchor ? anchor.row : undefined,
      anchorCol: anchor ? anchor.col : undefined,
      columnSizes: { ...columnSizeState },
      rowSizes: { ...rowSizeState }
    };
    vscode.setState(nextState);
  } catch {}
};

const restoreState = () => {
  try {
    const st = vscode.getState() || {};
    columnSizeState = normalizeSizeState(st.columnSizes, 40);
    rowSizeState = normalizeSizeState(st.rowSizes, MIN_ROW_HEIGHT);
    applySizeStateToRenderedCells();
    if (typeof st.scrollX === 'number' && scrollContainer) {
      scrollContainer.scrollLeft = st.scrollX;
    }
    // If the saved scroll position is beyond current height (because only the first
    // chunk is mounted), progressively load more chunks until we can restore it.
    if (typeof st.scrollY === 'number') {
      if (scrollContainer) {
        let guard = 100;
      while (
        typeof window.__csvLoadNextChunk === 'function' &&
        (scrollContainer.scrollHeight - scrollContainer.clientHeight < st.scrollY) &&
        guard-- > 0
      ) {
        if (!window.__csvLoadNextChunk()) break;
      }
      applySizeStateToRenderedCells();
      scrollContainer.scrollTop = st.scrollY;
    } else {
      window.scrollTo(0, st.scrollY);
      }
    }
    if (typeof st.anchorRow === 'number' && typeof st.anchorCol === 'number') {
      const tag = (hasHeader && st.anchorRow === 0 ? 'th' : 'td');
      let sel = table.querySelector(`${tag}[data-row="${st.anchorRow}"][data-col="${st.anchorCol}"]`);
      // If not present yet (due to chunking), load chunks until available or exhausted
      if (!sel && typeof window.__csvLoadNextChunk === 'function') {
        let guard = 100; // prevent infinite loops
        while (!sel && typeof window.__csvLoadNextChunk === 'function' && guard-- > 0) {
          if (!window.__csvLoadNextChunk()) break;
          sel = table.querySelector(`${tag}[data-row="${st.anchorRow}"][data-col="${st.anchorCol}"]`);
        }
      }
      applySizeStateToRenderedCells();
      if (sel) {
        clearSelection();
        sel.classList.add('selected');
        currentSelection.push(sel);
        anchorCell = sel; rangeEndCell = sel;
        try { sel.focus({ preventScroll: true }); } catch { try { sel.focus(); } catch {} }
      }
    }
    // Re-apply scroll after any late chunk loads from selection restoration
    if (typeof st.scrollY === 'number' && scrollContainer) {
      scrollContainer.scrollTop = st.scrollY;
    }
  } catch {}
};

/* ──────────── VIRTUAL-SCROLL LOADER ──────────── */
// We use a <template> to carry JSON so CSP doesn't block it like a <script> might
const chunkTemplate = document.getElementById('__csvChunks');
let csvChunks = [];
try {
  csvChunks = chunkTemplate ? JSON.parse(chunkTemplate.textContent || '[]') : [];
} catch (e) {
  // Swallow parse errors; chunking will simply be disabled
  csvChunks = [];
}
let remoteNextChunkStart = Number.parseInt(root?.dataset?.nextchunkstart || '', 10);
if (!Number.isInteger(remoteNextChunkStart) || remoteNextChunkStart < 0) {
  remoteNextChunkStart = -1;
}
let remoteHasMoreChunks = root?.dataset?.hasmorechunks === '1' && remoteNextChunkStart >= 0;
let remoteChunkRequestInFlight = false;
let remoteChunkRequestedStart = -1;
let remoteChunkRequestSeq = 0;
let pendingEnsureTarget = null;
let nearBottom = () => false;
let loadNextChunk = () => false;

const requestRemoteChunk = () => {
  if (!remoteHasMoreChunks) return;
  if (remoteChunkRequestInFlight) return;
  if (!Number.isInteger(remoteNextChunkStart) || remoteNextChunkStart < 0) {
    remoteHasMoreChunks = false;
    return;
  }
  remoteChunkRequestInFlight = true;
  remoteChunkRequestedStart = remoteNextChunkStart;
  remoteChunkRequestSeq += 1;
  vscode.postMessage({ type: 'requestChunk', start: remoteNextChunkStart, requestId: remoteChunkRequestSeq });
};

if (csvChunks.length || remoteHasMoreChunks) {
  const tbody = table.tBodies[0];
  let loading = false;

  loadNextChunk = () => {
    if (loading || !tbody) return false;
    if (!csvChunks.length) {
      requestRemoteChunk();
      return false;
    }
    loading = true;
    try {
      const html = csvChunks.shift();
      if (html) {
        tbody.insertAdjacentHTML('beforeend', html);
        applySizeStateToRenderedCells();
        window.dispatchEvent(new Event('csvChunkLoaded'));
      }
      if (!csvChunks.length) {
        requestRemoteChunk();
      }
      return !!html;
    } finally {
      loading = false;
    }
  };
  // Expose for restoration logic
  window.__csvLoadNextChunk = loadNextChunk;

  nearBottom = () => {
    if (!scrollContainer) return false;
    const remain = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    return remain < 300; // px threshold
  };

  const io = new IntersectionObserver((entries)=>{
    if (entries[0] && entries[0].isIntersecting) {
      loadNextChunk();
      const last = tbody && tbody.querySelector('tr:last-child');
      if (last) io.observe(last);
    }
  }, { root: scrollContainer || null, rootMargin: '0px 0px 300px 0px' });

  const prime = () => {
    const last = tbody && tbody.querySelector('tr:last-child');
    if (last) { io.observe(last); }
  };
  prime();

  // Fallback: scroll-driven loader to ensure progress even if IO misses
  const scrollHandler = () => {
    if (!csvChunks.length && !remoteHasMoreChunks) return;
    if (nearBottom()) {
      // Load until we create headroom or exhaust currently available chunks
      let guard = 10;
      while (nearBottom() && guard-- > 0) {
        if (!loadNextChunk()) break;
      }
      prime();
    }
  };
  if (scrollContainer) scrollContainer.addEventListener('scroll', scrollHandler, { passive: true });
  else window.addEventListener('scroll', scrollHandler, { passive: true });
}

const ensureTargetStep = () => {
  if (!pendingEnsureTarget) return;
  const { row, col } = pendingEnsureTarget;
  const sel = table.querySelector(`td[data-row="${row}"][data-col="${col}"], th[data-row="${row}"][data-col="${col}"]`);
  if (sel) {
    pendingEnsureTarget = null;
    return;
  }
  pendingEnsureTarget.guard -= 1;
  if (pendingEnsureTarget.guard <= 0 || (!remoteHasMoreChunks && !csvChunks.length)) {
    pendingEnsureTarget = null;
    return;
  }
  if (!loadNextChunk()) {
    requestRemoteChunk();
  }
};
window.addEventListener('csvChunkLoaded', ensureTargetStep);
/* ───────── END VIRTUAL-SCROLL LOADER ───────── */

// Restore state after initial DOM is ready
restoreState();
setTimeout(() => { try { restoreState(); } catch {} }, 0);
requestAnimationFrame(() => { try { restoreState(); } catch {} });

// Track scroll to persist state (prefer container)
if (scrollContainer) {
  scrollContainer.addEventListener('scroll', () => {
    persistState();
  }, { passive: true });
} else {
  window.addEventListener('scroll', () => { persistState(); }, { passive: true });
}

// Persist on blur/visibility change and restore on focus/visibility
window.addEventListener('blur', () => { persistState(); }, { passive: true });
window.addEventListener('focus', () => {
  setTimeout(() => { try { restoreState(); } catch {} }, 0);
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistState();
  } else if (document.visibilityState === 'visible') {
    setTimeout(() => { try { restoreState(); } catch {} }, 0);
  }
});

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
  // Derive multi-row/column selection counts
  const selectedIndexCells = currentSelection.filter(el => el && el.getAttribute && el.getAttribute('data-col') === '-1');
  const selectedRowIds = Array.from(new Set(selectedIndexCells.map(el => parseInt(el.getAttribute('data-row') || '-1', 10)).filter(n => !isNaN(n)))).sort((a,b)=>a-b);
  const rowCountSel = selectedRowIds.length;

  const selectedHeaderCells = currentSelection.filter(el => el && el.tagName === 'TH' && el.getAttribute('data-col') !== null);
  const selectedColIds = Array.from(new Set(selectedHeaderCells.map(el => parseInt(el.getAttribute('data-col') || '-1', 10)).filter(n => !isNaN(n) && n >= 0))).sort((a,b)=>a-b);
  const colCountSel = selectedColIds.length;

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
    const rowsN = rowCountSel > 1 ? rowCountSel : 1;
    const addAboveLabel = rowsN > 1 ? `Add ${rowsN} ROWS: above` : 'Add ROW: above';
    const addBelowLabel = rowsN > 1 ? `Add ${rowsN} ROWS: below` : 'Add ROW: below';
    const delLabel      = rowsN > 1 ? `Delete ${rowsN} ROWS`    : 'Delete ROW';
    item(addAboveLabel, () => {
      const base = rowCountSel > 1 ? Math.min(...selectedRowIds) : row;
      const count = rowsN;
      vscode.postMessage({ type: 'insertRows', index: base, count });
    });
    item(addBelowLabel, () => {
      const base = rowCountSel > 1 ? Math.max(...selectedRowIds) + 1 : (row + 1);
      const count = rowsN;
      vscode.postMessage({ type: 'insertRows', index: base, count });
    });
    item(delLabel, () => {
      if (rowCountSel > 1) {
        vscode.postMessage({ type: 'deleteRows', indices: selectedRowIds });
      } else {
        vscode.postMessage({ type: 'deleteRow', index: row });
      }
    });
    addedRowItems = true;
  }

  /* Column section, preceded by divider if row items exist */
  if (!isNaN(col) && col >= 0) {
    if (addedRowItems) divider();
    const colsN = colCountSel > 1 ? colCountSel : 1;
    const addLeftLabel  = colsN > 1 ? `Add ${colsN} COLUMNS: left`  : 'Add COLUMN: left';
    const addRightLabel = colsN > 1 ? `Add ${colsN} COLUMNS: right` : 'Add COLUMN: right';
    const delColLabel   = colsN > 1 ? `Delete ${colsN} COLUMNS`     : 'Delete COLUMN';
    item(addLeftLabel, () => {
      const base = colCountSel > 1 ? Math.min(...selectedColIds) : col;
      vscode.postMessage({ type: 'insertColumns', index: base, count: colsN });
    });
    item(addRightLabel, () => {
      const base = colCountSel > 1 ? Math.max(...selectedColIds) + 1 : (col + 1);
      vscode.postMessage({ type: 'insertColumns', index: base, count: colsN });
    });
    item(delColLabel, () => {
      if (colCountSel > 1) {
        vscode.postMessage({ type: 'deleteColumns', indices: selectedColIds });
      } else {
        vscode.postMessage({ type: 'deleteColumn', index: col });
      }
    });
  }

  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.style.display = 'block';
};

const getElementTarget = target => {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
};
const getLinkTarget = target => {
  const el = getElementTarget(target);
  return el ? el.closest('.csv-link[data-href]') : null;
};
const getCellTarget = target => {
  const el = getElementTarget(target);
  return el ? el.closest('td, th') : null;
};
const isColumnHeaderCell = cell => {
  if (!cell || cell.tagName !== 'TH') return false;
  const col = cell.getAttribute('data-col');
  return col !== null && col !== '-1';
};
const isRowIndexCell = cell => cell && cell.getAttribute && cell.getAttribute('data-col') === '-1';
const getSelectedColumnIds = () => {
  const ids = currentSelection
    .filter(el => el && el.tagName === 'TH')
    .map(el => parseInt(el.getAttribute('data-col') || 'NaN', 10))
    .filter(v => !Number.isNaN(v) && v >= 0);
  return Array.from(new Set(ids)).sort((a, b) => a - b);
};
const getSelectedRowIds = () => {
  const ids = currentSelection
    .filter(el => isRowIndexCell(el))
    .map(el => parseInt(el.getAttribute('data-row') || 'NaN', 10))
    .filter(v => !Number.isNaN(v) && v >= 0);
  return Array.from(new Set(ids)).sort((a, b) => a - b);
};
const hideDragIndicator = () => {
  dragIndicator.style.display = 'none';
};
const showColumnDropIndicator = x => {
  const rect = table.getBoundingClientRect();
  dragIndicator.style.left = `${Math.round(x) - 1}px`;
  dragIndicator.style.top = `${Math.round(rect.top)}px`;
  dragIndicator.style.width = '2px';
  dragIndicator.style.height = `${Math.max(1, Math.round(rect.height))}px`;
  dragIndicator.style.display = 'block';
};
const showRowDropIndicator = y => {
  const rect = table.getBoundingClientRect();
  dragIndicator.style.left = `${Math.round(rect.left)}px`;
  dragIndicator.style.top = `${Math.round(y) - 1}px`;
  dragIndicator.style.width = `${Math.max(1, Math.round(rect.width))}px`;
  dragIndicator.style.height = '2px';
  dragIndicator.style.display = 'block';
};
const getColumnDropTarget = clientX => {
  const headers = Array.from(table.querySelectorAll('thead th[data-col]'))
    .map(cell => ({ cell, col: parseInt(cell.getAttribute('data-col') || 'NaN', 10) }))
    .filter(entry => !Number.isNaN(entry.col) && entry.col >= 0)
    .sort((a, b) => a.col - b.col);
  if (!headers.length) return null;

  let beforeIndex = headers[0].col;
  let indicatorX = headers[0].cell.getBoundingClientRect().left;
  for (const entry of headers) {
    const rect = entry.cell.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      beforeIndex = entry.col;
      indicatorX = rect.left;
      return { beforeIndex, indicatorX };
    }
    beforeIndex = entry.col + 1;
    indicatorX = rect.right;
  }
  return { beforeIndex, indicatorX };
};
const getRowDropTarget = clientY => {
  const rows = Array.from(table.querySelectorAll('tbody td[data-col="-1"]'))
    .map(cell => ({ cell, row: parseInt(cell.getAttribute('data-row') || 'NaN', 10) }))
    .filter(entry => !Number.isNaN(entry.row) && entry.row >= 0)
    .sort((a, b) => a.row - b.row);
  if (!rows.length) return null;

  let beforeIndex = rows[0].row;
  let indicatorY = rows[0].cell.getBoundingClientRect().top;
  for (const entry of rows) {
    const rect = entry.cell.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      beforeIndex = entry.row;
      indicatorY = rect.top;
      return { beforeIndex, indicatorY };
    }
    beforeIndex = entry.row + 1;
    indicatorY = rect.bottom;
  }
  return { beforeIndex, indicatorY };
};
const getResizeEdgeInfo = (target, e) => {
  if (!target) return null;
  if (isColumnHeaderCell(target)) {
    const col = parseInt(target.getAttribute('data-col') || 'NaN', 10);
    if (!Number.isNaN(col)) {
      const rect = target.getBoundingClientRect();
      const edgeDelta = rect.right - e.clientX;
      if (edgeDelta >= 0 && edgeDelta <= RESIZE_HANDLE_PX) {
        return { axis: 'column', index: col, rect };
      }
    }
  }
  if (isRowIndexCell(target)) {
    const row = parseInt(target.getAttribute('data-row') || 'NaN', 10);
    if (!Number.isNaN(row)) {
      const rect = target.getBoundingClientRect();
      const edgeDelta = rect.bottom - e.clientY;
      if (edgeDelta >= 0 && edgeDelta <= RESIZE_HANDLE_PX) {
        return { axis: 'row', index: row, rect };
      }
    }
  }
  return null;
};
const applyColumnWidth = (col, widthPx) => {
  const width = Math.max(40, Math.round(widthPx));
  columnSizeState[String(col)] = width;
  table.querySelectorAll(`[data-col="${col}"]`).forEach(cell => {
    cell.style.width = `${width}px`;
    cell.style.minWidth = `${width}px`;
    cell.style.maxWidth = `${width}px`;
  });
};
const resetColumnWidth = col => {
  delete columnSizeState[String(col)];
  table.querySelectorAll(`[data-col="${col}"]`).forEach(cell => {
    cell.style.width = '';
    cell.style.minWidth = '';
    cell.style.maxWidth = '';
  });
};
const applyRowHeight = (row, heightPx) => {
  const height = Math.max(MIN_ROW_HEIGHT, Math.round(heightPx));
  rowSizeState[String(row)] = height;
  table.querySelectorAll(`[data-row="${row}"]`).forEach(cell => {
    cell.style.height = `${height}px`;
    cell.style.minHeight = `${height}px`;
  });
};
const resetRowHeight = row => {
  delete rowSizeState[String(row)];
  table.querySelectorAll(`[data-row="${row}"]`).forEach(cell => {
    cell.style.height = '';
    cell.style.minHeight = '';
  });
};
const startResizeDrag = (target, e) => {
  if (e.button !== 0) return false;
  const edge = getResizeEdgeInfo(target, e);
  if (!edge) return false;
  if (edge.axis === 'column') {
    resizeState = { axis: 'column', index: edge.index, startPos: e.clientX, startSize: edge.rect.width };
    table.style.cursor = 'col-resize';
    return true;
  }
  const rowCells = Array.from(table.querySelectorAll(`[data-row="${edge.index}"]`));
  const startHeight = rowCells.reduce((max, cell) => Math.max(max, cell.getBoundingClientRect().height), edge.rect.height);
  resizeState = { axis: 'row', index: edge.index, startPos: e.clientY, startSize: startHeight };
  table.style.cursor = 'row-resize';
  return true;
};
const startReorderDrag = (target, e) => {
  if (e.button !== 0) return false;
  if (isColumnHeaderCell(target) && target.classList.contains('selected')) {
    const col = parseInt(target.getAttribute('data-col') || 'NaN', 10);
    if (Number.isNaN(col)) return false;
    const selected = getSelectedColumnIds();
    const indices = selected.includes(col) ? selected : [col];
    reorderState = {
      axis: 'column',
      indices,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      beforeIndex: null
    };
    return true;
  }
  if (isRowIndexCell(target) && target.classList.contains('selected')) {
    const row = parseInt(target.getAttribute('data-row') || 'NaN', 10);
    if (Number.isNaN(row)) return false;
    const selected = getSelectedRowIds();
    const indices = selected.includes(row) ? selected : [row];
    reorderState = {
      axis: 'row',
      indices,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      beforeIndex: null
    };
    return true;
  }
  return false;
};
const onGlobalDragMove = e => {
  if (resizeState) {
    e.preventDefault();
    if (resizeState.axis === 'column') {
      const delta = e.clientX - resizeState.startPos;
      applyColumnWidth(resizeState.index, resizeState.startSize + delta);
    } else if (resizeState.axis === 'row') {
      const delta = e.clientY - resizeState.startPos;
      applyRowHeight(resizeState.index, resizeState.startSize + delta);
    }
    return;
  }
  if (!reorderState) return;

  const movedX = Math.abs(e.clientX - reorderState.startX);
  const movedY = Math.abs(e.clientY - reorderState.startY);
  if (!reorderState.active && movedX < DRAG_THRESHOLD_PX && movedY < DRAG_THRESHOLD_PX) {
    return;
  }
  reorderState.active = true;
  e.preventDefault();

  if (reorderState.axis === 'column') {
    const target = getColumnDropTarget(e.clientX);
    if (!target) return;
    reorderState.beforeIndex = target.beforeIndex;
    showColumnDropIndicator(target.indicatorX);
  } else {
    const target = getRowDropTarget(e.clientY);
    if (!target) return;
    reorderState.beforeIndex = target.beforeIndex;
    showRowDropIndicator(target.indicatorY);
  }
};
const onGlobalDragEnd = () => {
  if (resizeState) {
    resizeState = null;
    table.style.cursor = '';
    persistState();
  }
  if (!reorderState) return;

  const { axis, indices, active, beforeIndex } = reorderState;
  reorderState = null;
  hideDragIndicator();
  table.style.cursor = '';

  if (!active || !Number.isFinite(beforeIndex)) return;
  if (axis === 'column') {
    vscode.postMessage({ type: 'reorderColumns', indices, beforeIndex });
  } else {
    vscode.postMessage({ type: 'reorderRows', indices, beforeIndex });
  }
};
document.addEventListener('mousemove', onGlobalDragMove);
document.addEventListener('mouseup', onGlobalDragEnd);
const postOpenLink = link => {
  const url = link.getAttribute('data-href') || link.getAttribute('href');
  if (url) {
    vscode.postMessage({ type: 'openLink', url });
  }
};

document.addEventListener('click', (e) => {
  contextMenu.style.display = 'none';

  const link = getLinkTarget(e.target);
  if (!link) {
    return;
  }
  // Never navigate inside the webview.
  e.preventDefault();
  if (!(e.ctrlKey || e.metaKey)) {
    return;
  }
  // Ctrl/Cmd+click should open externally once, while regular clicks
  // still behave like normal cell interactions.
  if (e.detail === 1) {
    e.stopPropagation();
    postOpenLink(link);
  }
});

/* ──────── UPDATED contextmenu listener ──────── */
table.addEventListener('contextmenu', e => {
  const target = getCellTarget(e.target);
  if (!target) return;
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
  const link = getLinkTarget(e.target);
  // Ctrl/Cmd+click on a link opens externally on click; keep existing selection unchanged.
  if (link && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    return;
  }
  const target = getCellTarget(e.target);
  if (!target) return;

  // Preserve selection on right-click; select target if outside current selection
  if (e.button === 2) { // right mouse button
    if (!editingCell) {
      e.preventDefault();
      if (!target.classList.contains('selected')) {
        clearSelection();
        target.classList.add('selected');
        currentSelection.push(target);
        anchorCell = target;
        rangeEndCell = target;
        try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch {} }
      }
    }
    return; // do not start drag selection on right-click
  }
  if (e.button !== 0) return;
  if (!editingCell && startResizeDrag(target, e)) {
    e.preventDefault();
    return;
  }
  if (!editingCell && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && startReorderDrag(target, e)) {
    e.preventDefault();
    return;
  }

  // ──────── NEW: Shift+Click range selection ────────
  if (e.shiftKey && anchorCell && !editingCell) {
    const aRowAttr = anchorCell.getAttribute('data-row');
    const aColAttr = anchorCell.getAttribute('data-col');
    const tRowAttr = target.getAttribute('data-row');
    const tColAttr = target.getAttribute('data-col');
    // Ensure both have coordinates of some form
    if (aRowAttr !== null && tRowAttr !== null) {
      // Case 1: Header-to-header shift click → full column range
      if (anchorCell.tagName === 'TH' && target.tagName === 'TH' && aColAttr !== null && tColAttr !== null) {
        e.preventDefault();
        const startCol = parseInt(aColAttr, 10);
        const endCol = parseInt(tColAttr, 10);
        selectFullColumnRange(startCol, endCol);
        rangeEndCell = target;
        anchorCell.focus();
        return;
      }
      // Case 2: Serial-index-to-serial-index shift click → full row range
      if (aColAttr === '-1' && tColAttr === '-1') {
        e.preventDefault();
        const startRow = parseInt(aRowAttr, 10);
        const endRow = parseInt(tRowAttr, 10);
        selectFullRowRange(startRow, endRow);
        rangeEndCell = target;
        anchorCell.focus();
        return;
      }
      // Case 3: Regular cell-to-cell rectangle (exclude header/serial)
      if (
        aColAttr !== null && tColAttr !== null &&
        aColAttr !== '-1' && tColAttr !== '-1' &&
        target.tagName !== 'TH' && anchorCell.tagName !== 'TH'
      ) {
        e.preventDefault();
        selectRange(getCellCoords(anchorCell), getCellCoords(target));
        rangeEndCell = target;
        anchorCell.focus();
        return;
      }
    }
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
  let target = getCellTarget(e.target);
  if (!target) return;
  if(selectionMode === "cell"){
    endCell = target;
    rangeEndCell = target;
    selectRange(getCellCoords(startCell), getCellCoords(endCell));
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

table.addEventListener('mousemove', e => {
  if (isSelecting || resizeState || (reorderState && reorderState.active)) {
    return;
  }
  const target = getCellTarget(e.target);
  if (!target) {
    table.style.cursor = '';
    return;
  }
  const edge = getResizeEdgeInfo(target, e);
  if (edge) {
    table.style.cursor = edge.axis === 'column' ? 'col-resize' : 'row-resize';
    return;
  }
  table.style.cursor = '';
});

table.addEventListener('mouseleave', () => {
  if (!resizeState) {
    table.style.cursor = '';
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
    persistState();
  } else if(selectionMode === "column"){
    const startCol = parseInt(startCell.getAttribute('data-col'));
    const endCol = parseInt(endCell.getAttribute('data-col'));
    selectFullColumnRange(startCol, endCol); anchorCell = startCell; rangeEndCell = endCell; persistState();
  } else if(selectionMode === "row"){
    const startRow = parseInt(startCell.getAttribute('data-row'));
    const endRow = parseInt(endCell.getAttribute('data-row'));
    selectFullRowRange(startRow, endRow); anchorCell = startCell; rangeEndCell = endCell; persistState();
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

const getDataCellCoords = cell => {
  if (!cell || typeof cell.getAttribute !== 'function') return null;
  const coords = getCellCoords(cell);
  if (!coords || !Number.isInteger(coords.row) || !Number.isInteger(coords.col)) return null;
  if (coords.row < 0 || coords.col < 0) return null;
  return coords;
};

const getDataSelectionBounds = () => {
  const coords = currentSelection
    .map(cell => getDataCellCoords(cell))
    .filter(Boolean);
  if (!coords.length) return null;
  const keys = new Set(coords.map(c => `${c.row}:${c.col}`));
  const rows = coords.map(c => c.row);
  const cols = coords.map(c => c.col);
  const minRow = Math.min(...rows);
  const maxRow = Math.max(...rows);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);
  const expectedCount = (maxRow - minRow + 1) * (maxCol - minCol + 1);
  const rectangular = keys.size === expectedCount;
  return { minRow, maxRow, minCol, maxCol, rectangular };
};

const getPasteAnchorCoords = () => {
  const anchor = getDataCellCoords(anchorCell);
  if (anchor) return anchor;
  const fromActive = getDataCellCoords(getCellTarget(document.activeElement));
  if (fromActive) return fromActive;
  const bounds = getDataSelectionBounds();
  if (bounds) return { row: bounds.minRow, col: bounds.minCol };
  return null;
};

const findReplaceWidget = document.getElementById('findReplaceWidget');
const replaceToggleGutter = document.getElementById('replaceToggleGutter');
const replaceToggle = document.getElementById('replaceToggle');
const findInput = document.getElementById('findInput');
const replaceInput = document.getElementById('replaceInput');
const findStatus = document.getElementById('findStatus');
const findPrev = document.getElementById('findPrev');
const findNext = document.getElementById('findNext');
const findMenuButton = document.getElementById('findMenuButton');
const findOverflowMenu = document.getElementById('findOverflowMenu');
const findClose = document.getElementById('findClose');
const findCaseToggle = document.getElementById('findCaseToggle');
const findWordToggle = document.getElementById('findWordToggle');
const findRegexToggle = document.getElementById('findRegexToggle');
const replaceCaseToggle = document.getElementById('replaceCaseToggle');
const replaceOne = document.getElementById('replaceOne');
const replaceAll = document.getElementById('replaceAll');
const findOverflowPreserveCase = document.getElementById('findOverflowPreserveCase');

const findReplaceState = {
  open: false,
  replaceExpanded: false,
  matchCase: false,
  wholeWord: false,
  regex: false,
  preserveCase: false,
  invalidRegex: false
};
let findMatches = [];
let currentMatchIndex = -1;
let findDebounce = null;
let findFocusBeforeOpen = null;
let findRequestSeq = 0;
let latestFindRequestId = 0;
const pendingFindRequests = new Map();
let findMatchKeySet = new Set();

const escapeRegexLiteral = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const getFindMatchKey = (row, col) => `${row}:${col}`;
const isFindWidgetTarget = target => {
  const el = getElementTarget(target);
  return !!(el && el.closest('#findReplaceWidget'));
};
const clearFindHighlights = () => {
  document.querySelectorAll('.highlight, .active-match').forEach(el => {
    el.classList.remove('highlight');
    el.classList.remove('active-match');
  });
};
const hideFindOverflowMenu = () => {
  findOverflowMenu.classList.remove('open');
};
const setReplaceExpanded = expanded => {
  findReplaceState.replaceExpanded = expanded;
  findReplaceWidget.classList.toggle('replace-collapsed', !expanded);
  findReplaceWidget.classList.toggle('replace-expanded', expanded);
  replaceToggle.setAttribute('aria-expanded', String(expanded));
  replaceToggle.innerText = expanded ? '⌄' : '›';
};
const syncFindToggleUi = () => {
  findCaseToggle.setAttribute('aria-pressed', String(findReplaceState.matchCase));
  findWordToggle.setAttribute('aria-pressed', String(findReplaceState.wholeWord));
  findRegexToggle.setAttribute('aria-pressed', String(findReplaceState.regex));
  replaceCaseToggle.setAttribute('aria-pressed', String(findReplaceState.preserveCase));
};
const updateFindStatus = () => {
  const query = findInput.value;
  if (!query || query.length === 0 || findMatches.length === 0) {
    findStatus.innerText = findReplaceState.invalidRegex ? 'Invalid regex' : 'No results';
    return;
  }
  findStatus.innerText = `${currentMatchIndex + 1} of ${findMatches.length}`;
};
const updateFindControls = () => {
  const hasQuery = findInput.value.length > 0;
  const hasMatches = findMatches.length > 0 && !findReplaceState.invalidRegex;
  findPrev.disabled = !hasMatches;
  findNext.disabled = !hasMatches;
  replaceOne.disabled = !hasQuery || !hasMatches;
  replaceAll.disabled = !hasQuery || !hasMatches;
};
const getFindPattern = () => {
  const query = findInput.value;
  if (!query) return null;
  let source = findReplaceState.regex ? query : escapeRegexLiteral(query);
  if (findReplaceState.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }
  return source;
};
const buildFindRegex = global => {
  const source = getFindPattern();
  if (!source) return null;
  const flags = `${global ? 'g' : ''}${findReplaceState.matchCase ? '' : 'i'}`;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
};
const getRenderedFindCells = () => {
  return Array.from(table.querySelectorAll('td[data-col], th[data-col]'));
};
const getRenderedCellByCoords = (row, col) => {
  return table.querySelector(`td[data-row="${row}"][data-col="${col}"], th[data-row="${row}"][data-col="${col}"]`);
};
const ensureRenderedCellByCoords = (row, col) => {
  let cell = getRenderedCellByCoords(row, col);
  if (cell) {
    return cell;
  }
  if (typeof window.__csvLoadNextChunk !== 'function') {
    return null;
  }
  let guard = 50000;
  while (!cell && guard-- > 0) {
    if (!window.__csvLoadNextChunk()) break;
    cell = getRenderedCellByCoords(row, col);
  }
  if (!cell && (remoteHasMoreChunks || remoteChunkRequestInFlight)) {
    pendingEnsureTarget = { row, col, guard: 5000 };
    requestRemoteChunk();
  }
  return cell;
};
const applyFindHighlightsToRendered = () => {
  if (!findMatchKeySet.size) {
    return;
  }
  getRenderedFindCells().forEach(cell => {
    const row = parseInt(cell.getAttribute('data-row') || 'NaN', 10);
    const col = parseInt(cell.getAttribute('data-col') || 'NaN', 10);
    if (Number.isNaN(row) || Number.isNaN(col) || col < 0) {
      return;
    }
    if (findMatchKeySet.has(getFindMatchKey(row, col))) {
      cell.classList.add('highlight');
    }
  });
};
const setActiveFindMatch = (index, shouldScroll = true) => {
  document.querySelectorAll('.active-match').forEach(el => el.classList.remove('active-match'));
  if (!findMatches.length) {
    currentMatchIndex = -1;
    updateFindStatus();
    updateFindControls();
    return;
  }
  const normalized = ((index % findMatches.length) + findMatches.length) % findMatches.length;
  currentMatchIndex = normalized;
  const match = findMatches[currentMatchIndex];
  const cell = match ? ensureRenderedCellByCoords(match.row, match.col) : null;
  if (cell) {
    cell.classList.add('highlight');
    cell.classList.add('active-match');
    if (shouldScroll) {
      cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }
  }
  updateFindStatus();
  updateFindControls();
};
const runFind = (preserveIndex = false) => {
  const query = findInput.value;
  const priorIndex = currentMatchIndex;
  const requestId = ++findRequestSeq;
  latestFindRequestId = requestId;
  pendingFindRequests.set(requestId, { preserveIndex, priorIndex });

  clearFindHighlights();
  findMatches = [];
  findMatchKeySet = new Set();
  currentMatchIndex = -1;
  findReplaceState.invalidRegex = false;
  if (!query) {
    updateFindStatus();
    updateFindControls();
    return;
  }

  vscode.postMessage({
    type: 'findMatches',
    requestId,
    query,
    options: {
      matchCase: findReplaceState.matchCase,
      wholeWord: findReplaceState.wholeWord,
      regex: findReplaceState.regex
    }
  });
  updateFindStatus();
  updateFindControls();
};
const scheduleFind = (preserveIndex = false) => {
  if (findDebounce) clearTimeout(findDebounce);
  findDebounce = setTimeout(() => {
    runFind(preserveIndex);
  }, 150);
};
const navigateFind = reverse => {
  if (!findMatches.length) return;
  const delta = reverse ? -1 : 1;
  setActiveFindMatch(currentMatchIndex + delta);
};
const preserveReplacementCase = (replacement, matched) => {
  if (!replacement || !matched) return replacement;
  if (matched === matched.toUpperCase()) return replacement.toUpperCase();
  if (matched === matched.toLowerCase()) return replacement.toLowerCase();
  const first = matched.charAt(0);
  const rest = matched.slice(1);
  if (first === first.toUpperCase() && rest === rest.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement;
};
const replaceInText = (text, replaceAllMatches) => {
  const regex = buildFindRegex(replaceAllMatches);
  if (!regex) return text;
  const replacementText = replaceInput.value;
  if (!findReplaceState.preserveCase) {
    return text.replace(regex, replacementText);
  }
  return text.replace(regex, matched => preserveReplacementCase(replacementText, matched));
};
const replaceCurrentMatch = () => {
  if (!findMatches.length || findReplaceState.invalidRegex) return;
  const match = findMatches[currentMatchIndex];
  if (!match) {
    runFind(true);
    return;
  }
  const original = String(match.value ?? '');
  const next = replaceInText(original, false);
  if (next === original) {
    navigateFind(false);
    return;
  }
  const cell = ensureRenderedCellByCoords(match.row, match.col);
  if (cell) {
    cell.textContent = next;
  }
  vscode.postMessage({ type: 'editCell', row: match.row, col: match.col, value: next });
  runFind(true);
};
const replaceAllMatches = () => {
  if (findReplaceState.invalidRegex || !findInput.value || !findMatches.length) return;
  const seen = new Set();
  if (!findMatches.length) return;
  const replacements = [];
  findMatches.forEach(match => {
    if (!match) return;
    const key = getFindMatchKey(match.row, match.col);
    if (seen.has(key)) return;
    seen.add(key);
    const original = String(match.value ?? '');
    const next = replaceInText(original, true);
    if (next !== original) {
      const cell = getRenderedCellByCoords(match.row, match.col);
      if (cell) {
        cell.textContent = next;
      }
      replacements.push({ row: match.row, col: match.col, value: next });
    }
  });
  if (replacements.length > 0) {
    vscode.postMessage({ type: 'replaceCells', replacements });
  }
  runFind(false);
};
const openFindReplace = expandReplace => {
  findFocusBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  findReplaceState.open = true;
  findReplaceWidget.classList.add('open');
  setReplaceExpanded(expandReplace);
  syncFindToggleUi();
  hideFindOverflowMenu();
  try { findInput.focus({ preventScroll: true }); } catch { try { findInput.focus(); } catch {} }
  findInput.select();
  runFind(true);
};
const closeFindReplace = () => {
  if (findDebounce) {
    clearTimeout(findDebounce);
    findDebounce = null;
  }
  pendingFindRequests.clear();
  latestFindRequestId = 0;
  findReplaceState.open = false;
  findReplaceWidget.classList.remove('open');
  hideFindOverflowMenu();
  clearFindHighlights();
  findMatches = [];
  currentMatchIndex = -1;
  findReplaceState.invalidRegex = false;
  updateFindStatus();
  updateFindControls();
  const focusTarget = (findFocusBeforeOpen && findFocusBeforeOpen.isConnected)
    ? findFocusBeforeOpen
    : (anchorCell || document.body);
  try { focusTarget.focus({ preventScroll: true }); } catch { try { focusTarget.focus(); } catch {} }
};

findInput.addEventListener('input', () => scheduleFind(false));
findInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFindReplace();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    navigateFind(e.shiftKey);
    return;
  }
  if (e.key === 'F3') {
    e.preventDefault();
    navigateFind(e.shiftKey);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    navigateFind(e.shiftKey);
  }
});
replaceInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFindReplace();
    return;
  }
  if (e.key === 'F3') {
    e.preventDefault();
    navigateFind(e.shiftKey);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    replaceCurrentMatch();
  }
});
replaceToggleGutter.addEventListener('click', () => {
  setReplaceExpanded(!findReplaceState.replaceExpanded);
});
findCaseToggle.addEventListener('click', () => {
  findReplaceState.matchCase = !findReplaceState.matchCase;
  syncFindToggleUi();
  runFind(true);
});
findWordToggle.addEventListener('click', () => {
  findReplaceState.wholeWord = !findReplaceState.wholeWord;
  syncFindToggleUi();
  runFind(true);
});
findRegexToggle.addEventListener('click', () => {
  findReplaceState.regex = !findReplaceState.regex;
  syncFindToggleUi();
  runFind(true);
});
replaceCaseToggle.addEventListener('click', () => {
  findReplaceState.preserveCase = !findReplaceState.preserveCase;
  syncFindToggleUi();
});
findPrev.addEventListener('click', () => navigateFind(true));
findNext.addEventListener('click', () => navigateFind(false));
findClose.addEventListener('click', closeFindReplace);
findMenuButton.addEventListener('click', e => {
  e.stopPropagation();
  findOverflowMenu.classList.toggle('open');
});
replaceOne.addEventListener('click', replaceCurrentMatch);
replaceAll.addEventListener('click', replaceAllMatches);
findOverflowPreserveCase.addEventListener('click', () => {
  findReplaceState.preserveCase = !findReplaceState.preserveCase;
  syncFindToggleUi();
  hideFindOverflowMenu();
});
document.addEventListener('mousedown', e => {
  if (!isFindWidgetTarget(e.target)) {
    hideFindOverflowMenu();
    return;
  }
  const el = getElementTarget(e.target);
  if (el && !el.closest('#findMenuButton') && !el.closest('#findOverflowMenu')) {
    hideFindOverflowMenu();
  }
});
syncFindToggleUi();
updateFindStatus();
updateFindControls();
window.addEventListener('csvChunkLoaded', () => {
  if (!findReplaceState.open || findMatches.length === 0) {
    return;
  }
  applyFindHighlightsToRendered();
  if (currentMatchIndex >= 0 && currentMatchIndex < findMatches.length) {
    const active = findMatches[currentMatchIndex];
    const cell = getRenderedCellByCoords(active.row, active.col);
    if (cell) {
      cell.classList.add('active-match');
    }
  }
});

// Capture-phase handler to intercept Cmd/Ctrl + Arrow and move to extremes
document.addEventListener('keydown', e => {
  if (isFindWidgetTarget(e.target)) {
    return;
  }
  const isArrowKey = (k) => ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Up','Down','Left','Right','Home','End'].includes(k);
  if (!editingCell && (e.ctrlKey || e.metaKey) && isArrowKey(e.key)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();

    const sc = document.querySelector('.table-container');
    if (sc) {
      if (['ArrowLeft','Left','Home'].includes(e.key))  sc.scrollTo({ left: 0, behavior: 'smooth' });
      if (['ArrowRight','Right','End'].includes(e.key)) sc.scrollTo({ left: sc.scrollWidth, behavior: 'smooth' });
      if (['ArrowUp','Up'].includes(e.key))    sc.scrollTo({ top: 0, behavior: 'smooth' });
      if (['ArrowDown','Down'].includes(e.key))  sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
    } else {
      if (['ArrowUp','Up'].includes(e.key)) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      if (['ArrowDown','Down'].includes(e.key)) {
        const h = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        );
        window.scrollTo({ top: h, behavior: 'smooth' });
      }
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
      } else if (['ArrowUp','Up'].includes(e.key)) {
        const topRow = getFirstDataRow();
        target = table.querySelector('td[data-row="'+topRow+'"][data-col="'+col+'"]') || ref;
      } else if (['ArrowDown','Down'].includes(e.key)) {
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
      persistState();
      target.focus({preventScroll:true});
      if (['ArrowUp','Up'].includes(e.key)) {
        const topRow = getFirstDataRow();
        const below = table.querySelector('td[data-row="'+topRow+'"][data-col="'+getCellCoords(target).col+'"]');
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
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  if ((e.ctrlKey || e.metaKey) && key === 'f') {
    e.preventDefault();
    openFindReplace(false);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && key === 'h') {
    e.preventDefault();
    openFindReplace(true);
    return;
  }
  if (findReplaceState.open && (e.ctrlKey || e.metaKey) && key === 'g') {
    e.preventDefault();
    navigateFind(e.shiftKey);
    return;
  }
  if (findReplaceState.open && e.key === 'F3') {
    e.preventDefault();
    navigateFind(e.shiftKey);
    return;
  }
  if (findReplaceState.open && e.key === 'Escape') {
    e.preventDefault();
    closeFindReplace();
    return;
  }
  if (isFindWidgetTarget(e.target)) {
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !editingCell) {
    e.preventDefault(); selectAllCells(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'c' && currentSelection.length > 0) {
    e.preventDefault(); copySelectionToClipboard(); return;
  }

  // Clear contents of selected cells when not editing
  if (!editingCell && currentSelection.length > 0 && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    const cellsToClear = currentSelection
      .filter(cell => cell && cell.getAttribute('data-col') !== null && cell.getAttribute('data-col') !== '-1');
    if (cellsToClear.length === 0) return;
    cellsToClear.forEach(cell => {
      const { row, col } = getCellCoords(cell);
      // Update UI immediately
      cell.textContent = '';
      // Persist change to extension
      vscode.postMessage({ type: 'editCell', row, col, value: '' });
    });
    return;
  }

  const isArrowKey = (k) => ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Up','Down','Left','Right','Home','End'].includes(k);
  if (!editingCell && (e.ctrlKey || e.metaKey) && isArrowKey(e.key)) {
    e.preventDefault();
    const sc = document.querySelector('.table-container');
    if (sc) {
      if (['ArrowLeft','Left','Home'].includes(e.key))  sc.scrollTo({ left: 0, behavior: 'smooth' });
      if (['ArrowRight','Right','End'].includes(e.key)) sc.scrollTo({ left: sc.scrollWidth, behavior: 'smooth' });
      if (['ArrowUp','Up'].includes(e.key))    sc.scrollTo({ top: 0, behavior: 'smooth' });
      if (['ArrowDown','Down'].includes(e.key))  sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
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
      } else if (['ArrowUp','Up'].includes(e.key)) {
        if (hasHeader) {
          target = table.querySelector('th[data-row="0"][data-col="'+col+'"]') || refCell;
        } else {
          target = table.querySelector('td[data-row="0"][data-col="'+col+'"]') || refCell;
        }
      } else if (['ArrowDown','Down'].includes(e.key)) {
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
      persistState();
      target.focus({preventScroll:true});
      target.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'smooth' });
    }
    return;
  }

  if (!editingCell && e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const refCell = anchorCell || getCellTarget(document.activeElement) || currentSelection[0] || document.querySelector('td.selected, th.selected');
    if (!refCell) return;
    const coords = getCellCoords(refCell);
    if (!coords || !Number.isInteger(coords.row) || !Number.isInteger(coords.col) || coords.col < 0) {
      return;
    }
    const bounds = getDataColumnBounds();
    if (!bounds) return;
    const { minCol, maxCol } = bounds;
    const firstDataRow = getFirstDataRow();
    const isBackward = !!e.shiftKey;
    let targetRow = coords.row;
    let targetCol = coords.col + (isBackward ? -1 : 1);
    if (!isBackward && targetCol > maxCol) {
      targetRow += 1;
      targetCol = minCol;
    } else if (isBackward && targetCol < minCol) {
      if (targetRow <= firstDataRow) {
        return;
      }
      targetRow -= 1;
      targetCol = maxCol;
    }
    const nextCell = ensureRenderedCellByCoords(targetRow, targetCol);
    if (nextCell) {
      setSingleSelection(nextCell);
    }
    return;
  }

  /* ──────── NEW: ENTER + DIRECT TYPING HANDLERS ──────── */
  if (!editingCell && anchorCell && currentSelection.length === 1) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const cell = anchorCell;
      // Detail edit via Enter
      editCell(cell, undefined, 'detail');
      if (e.shiftKey) {
        // Shift+Enter from selection should open detail edit and insert
        // a newline immediately on the very first keypress.
        appendVisibleNewlineAtEnd(cell);
      }
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const cell = anchorCell;
      // Quick edit via direct typing: start edit and inject the first char.
      editCell(cell, undefined, 'quick');
      // Overwrite existing content with the typed character.
      cell.textContent = e.key;
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
      persistState();
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
      persistState();
      nextCell.focus({preventScroll:true});
      nextCell.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'smooth' });
    }
    return;
  }

  // QUICK EDIT: Arrow keys commit and move selection (no re-entering edit)
  if (editingCell && editMode === 'quick' && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const { row, col } = getCellCoords(editingCell);
    let targetRow = row, targetCol = col;
    switch(e.key){
      case 'ArrowUp':   targetRow = row - 1; break;
      case 'ArrowDown': targetRow = row + 1; break;
      case 'ArrowLeft': targetCol = col - 1; break;
      case 'ArrowRight':targetCol = col + 1; break;
    }
    if (targetRow >= 0 && targetCol >= 0) {
      const tag = (hasHeader && targetRow === 0 ? 'th' : 'td');
      const nextCell = table.querySelector(`${tag}[data-row="${targetRow}"][data-col="${targetCol}"]`);
      if (nextCell) {
        const commitAndMove = () => {
          clearSelection();
          nextCell.classList.add('selected');
          currentSelection.push(nextCell);
          anchorCell = nextCell;
          rangeEndCell = nextCell;
          persistState();
          nextCell.focus({preventScroll:true});
          nextCell.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'smooth' });
        };
        const cellRef = editingCell;
        cellRef && cellRef.blur();
        setTimeout(commitAndMove, 0);
      } else {
        const cellRef = editingCell;
        cellRef && cellRef.blur();
      }
    } else {
      const cellRef = editingCell;
      cellRef && cellRef.blur();
    }
    return;
  }

  // DETAIL EDIT: Arrow Up/Down go to start/end of contents; Left/Right default caret move
  if (editingCell && editMode === 'detail' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    if (e.key === 'ArrowUp') setCursorToStart(editingCell);
    if (e.key === 'ArrowDown') setCursorToEnd(editingCell);
    return;
  }

  if (editingCell && ((e.ctrlKey || e.metaKey) && e.key === 's')) {
    e.preventDefault();
    editingCell.blur();
    vscode.postMessage({ type: 'save' });
  }
  if (editingCell && e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) {
      if (!insertNewlineAtCaret(editingCell)) {
        appendVisibleNewlineAtEnd(editingCell);
      }
      return;
    }
    const { row, col } = getCellCoords(editingCell);
    editingCell.blur();
    const targetRow = row + 1;
    // Editing Enter commits and moves selection down (no auto-edit).
    const nextCell = ensureRenderedCellByCoords(targetRow, col);
    if (nextCell) {
      setSingleSelection(nextCell);
    } else {
      try {
        const st = vscode.getState() || {};
        vscode.setState({ ...st, anchorRow: targetRow, anchorCol: col });
      } catch {}
    }
  }
  if (editingCell && e.key === 'Tab') {
    e.preventDefault();
    const cell = editingCell;
    const { row, col } = getCellCoords(cell);
    const bounds = getDataColumnBounds();
    const firstDataRow = getFirstDataRow();
    const isBackward = !!e.shiftKey;
    let targetRow = row;
    let targetCol = col;
    let canMove = !!bounds;
    if (bounds) {
      targetCol = col + (isBackward ? -1 : 1);
      if (!isBackward && targetCol > bounds.maxCol) {
        targetRow += 1;
        targetCol = bounds.minCol;
      } else if (isBackward && targetCol < bounds.minCol) {
        if (targetRow <= firstDataRow) {
          canMove = false;
        } else {
          targetRow -= 1;
          targetCol = bounds.maxCol;
        }
      }
    }
    cell.blur();
    // Editing Tab commits and moves selection only (no auto-edit).
    const nextCell = canMove ? ensureRenderedCellByCoords(targetRow, targetCol) : null;
    if (nextCell) {
      setSingleSelection(nextCell);
    } else {
      setSingleSelection(cell);
    }
  }
  if (editingCell && e.key === 'Escape') {
    e.preventDefault(); editingCell.innerText = originalCellValue; editingCell.blur();
  }
  if (!editingCell && e.key === 'Escape') {
    clearSelection();
  }
});

document.addEventListener('paste', e => {
  if (isFindWidgetTarget(e.target)) {
    return;
  }
  if (editingCell) {
    return;
  }
  const clipboard = e.clipboardData;
  if (!clipboard) {
    return;
  }
  const text = clipboard.getData('text/plain');
  if (typeof text !== 'string' || text.length === 0) {
    return;
  }
  const anchor = getPasteAnchorCoords();
  if (!anchor) {
    return;
  }
  e.preventDefault();
  const selection = getDataSelectionBounds();
  vscode.postMessage({
    type: 'pasteCells',
    text,
    anchorRow: anchor.row,
    anchorCol: anchor.col,
    selection: selection || undefined
  });
});

const selectAllCells = () => { clearSelection(); document.querySelectorAll('td, th').forEach(cell => { cell.classList.add('selected'); currentSelection.push(cell); }); };

const setCursorToEnd = cell => { setTimeout(() => { 
  const range = document.createRange(); range.selectNodeContents(cell); range.collapse(false);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
}, 10); };

const setCursorToStart = cell => { setTimeout(() => {
  const range = document.createRange(); range.selectNodeContents(cell); range.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
}, 10); };

const setCursorAtPoint = (cell, x, y) => {
  let range;
  if(document.caretRangeFromPoint) { range = document.caretRangeFromPoint(x,y); }
  else if(document.caretPositionFromPoint) { let pos = document.caretPositionFromPoint(x,y); range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  if(range){ let sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
};

const getDataColumnBounds = () => {
  const cols = Array.from(table.querySelectorAll('td[data-col], th[data-col]'))
    .map(el => parseInt(el.getAttribute('data-col') || 'NaN', 10))
    .filter(col => Number.isInteger(col) && col >= 0);
  if (!cols.length) {
    return null;
  }
  return { minCol: Math.min(...cols), maxCol: Math.max(...cols) };
};

const setSingleSelection = cell => {
  if (!cell) return;
  clearSelection();
  cell.classList.add('selected');
  currentSelection.push(cell);
  anchorCell = cell;
  rangeEndCell = cell;
  persistState();
  try { cell.focus({ preventScroll: true }); } catch { try { cell.focus(); } catch {} }
  cell.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
};

const NEWLINE_SENTINEL_ATTR = 'data-csv-newline-sentinel';
const removeNewlineSentinels = cell => {
  if (!cell) return;
  cell.querySelectorAll(`[${NEWLINE_SENTINEL_ATTR}="true"]`).forEach(node => node.remove());
};

const placeCaretBeforeSentinel = sentinel => {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (sentinel.firstChild) {
    range.setStart(sentinel.firstChild, 0);
  } else {
    range.setStartBefore(sentinel);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
};

const appendVisibleNewlineAtEnd = cell => {
  removeNewlineSentinels(cell);
  const sentinel = document.createElement('span');
  sentinel.setAttribute(NEWLINE_SENTINEL_ATTR, 'true');
  sentinel.textContent = '\u200B';
  cell.appendChild(document.createTextNode('\n'));
  cell.appendChild(sentinel);
  placeCaretBeforeSentinel(sentinel);
};

const isRangeAtEndOfCell = (cell, range) => {
  const probe = document.createRange();
  probe.selectNodeContents(cell);
  probe.setEnd(range.endContainer, range.endOffset);
  const caretOffset = probe.toString().length;
  return caretOffset >= (cell.textContent || '').length;
};

const insertNewlineAtCaret = cell => {
  removeNewlineSentinels(cell);
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!cell.contains(range.commonAncestorContainer)) return false;
  const atEnd = range.collapsed && isRangeAtEndOfCell(cell, range);
  range.deleteContents();
  if (atEnd) {
    const sentinel = document.createElement('span');
    sentinel.setAttribute(NEWLINE_SENTINEL_ATTR, 'true');
    sentinel.textContent = '\u200B';
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createTextNode('\n'));
    fragment.appendChild(sentinel);
    range.insertNode(fragment);
    placeCaretBeforeSentinel(sentinel);
    return true;
  }
  const newlineNode = document.createTextNode('\n');
  range.insertNode(newlineNode);
  range.setStartAfter(newlineNode);
  range.setEndAfter(newlineNode);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
};

const editCell = (cell, event, mode = 'detail') => {
  if(editingCell === cell) return;
  if(editingCell) editingCell.blur();
  cell.classList.remove('selected');
  originalCellValue = cell.textContent;
  editingCell = cell;
  editMode = mode;
  cell.classList.add('editing');
  cell.setAttribute('contenteditable', 'true');
  cell.focus();
  const onBlurHandler = () => {
    removeNewlineSentinels(cell);
    const value = cell.textContent;
    const coords = getCellCoords(cell);
    vscode.postMessage({ type: 'editCell', row: coords.row, col: coords.col, value: value });
    cell.removeAttribute('contenteditable');
    cell.classList.remove('editing');
    editingCell = null;
    editMode = null;
    cell.removeEventListener('blur', onBlurHandler);
  };
  cell.addEventListener('blur', onBlurHandler);
  event ? setCursorAtPoint(cell, event.clientX, event.clientY) : setCursorToEnd(cell);
};

table.addEventListener('dblclick', e => {
  const edgeTarget = getCellTarget(e.target);
  const edge = getResizeEdgeInfo(edgeTarget, e);
  if (edge) {
    e.preventDefault();
    e.stopPropagation();
    if (edge.axis === 'column') {
      resetColumnWidth(edge.index);
    } else {
      resetRowHeight(edge.index);
    }
    persistState();
    return;
  }
  const link = getLinkTarget(e.target);
  if (link) {
    e.preventDefault();
    // Ctrl/Cmd+click is handled by the click listener; do not enter edit mode here.
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      return;
    }
  }
  const target = getCellTarget(e.target);
  if (!target) return;
  clearSelection();
  editCell(target, e);
});

const copySelectionToClipboard = () => {
  if (currentSelection.length === 0) return;

  // Only copy real data/header columns; skip serial index column (col === -1)
  const coords = currentSelection
    .map(cell => getCellCoords(cell))
    .filter(c => !isNaN(c.row) && !isNaN(c.col) && c.col >= 0);
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
    if (anchorCell) {
      try { anchorCell.focus({ preventScroll: true }); } catch { try { anchorCell.focus(); } catch {} }
    } else {
      try { document.body.focus({ preventScroll: true }); } catch { try { document.body.focus(); } catch {} }
    }
  } else if (message.type === 'chunkData') {
    const requestId = Number(message.requestId);
    const start = Number(message.start);
    if (remoteChunkRequestInFlight) {
      if (!Number.isInteger(requestId) || requestId !== remoteChunkRequestSeq) {
        return;
      }
      if (!Number.isInteger(start) || start !== remoteChunkRequestedStart) {
        return;
      }
    }
    remoteChunkRequestInFlight = false;
    remoteChunkRequestedStart = -1;
    const html = typeof message.html === 'string' ? message.html : '';
    const nextStart = Number(message.nextStart);
    const done = !!message.done;
    if (html.length > 0) {
      csvChunks.push(html);
    }
    if (!done && Number.isInteger(nextStart) && nextStart >= 0) {
      remoteNextChunkStart = nextStart;
      remoteHasMoreChunks = true;
    } else {
      remoteNextChunkStart = -1;
      remoteHasMoreChunks = false;
    }
    if (csvChunks.length && pendingEnsureTarget) {
      ensureTargetStep();
    } else if (csvChunks.length && nearBottom()) {
      loadNextChunk();
    }
  } else if(message.type === 'updateCell'){
    isUpdating = true;
    const { row, col, value, rendered } = message;
    const cell = table.querySelector('td[data-row="'+row+'"][data-col="'+col+'"], th[data-row="'+row+'"][data-col="'+col+'"]');
    if (cell) {
      if (typeof rendered === 'string') {
        cell.innerHTML = rendered;
      } else {
        cell.textContent = value;
      }
    }
    isUpdating = false;
    if (findReplaceState.open && findInput.value) {
      scheduleFind(true);
    }
  } else if (message.type === 'pasteApplied') {
    const startRow = Number(message.startRow);
    const startCol = Number(message.startCol);
    const endRow = Number(message.endRow);
    const endCol = Number(message.endCol);
    if (
      !Number.isInteger(startRow) || !Number.isInteger(startCol) ||
      !Number.isInteger(endRow) || !Number.isInteger(endCol) ||
      startRow < 0 || startCol < 0 || endRow < startRow || endCol < startCol
    ) {
      return;
    }
    const startCell = ensureRenderedCellByCoords(startRow, startCol);
    const endCell = ensureRenderedCellByCoords(endRow, endCol);
    if (!startCell || !endCell) {
      return;
    }
    anchorCell = startCell;
    rangeEndCell = endCell;
    selectRange({ row: startRow, col: startCol }, { row: endRow, col: endCol });
    persistState();
    try { startCell.focus({ preventScroll: true }); } catch { try { startCell.focus(); } catch {} }
    endCell.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'smooth' });
  } else if (message.type === 'findMatchesResult') {
    if (!findReplaceState.open) {
      return;
    }
    const requestId = Number(message.requestId);
    const requestState = pendingFindRequests.get(requestId);
    pendingFindRequests.delete(requestId);
    if (!Number.isInteger(requestId) || requestId !== latestFindRequestId) {
      return;
    }

    findReplaceState.invalidRegex = !!message.invalidRegex;
    findMatches = Array.isArray(message.matches)
      ? message.matches
        .map(raw => {
          const row = Number(raw?.row);
          const col = Number(raw?.col);
          if (!Number.isInteger(row) || row < 0 || !Number.isInteger(col) || col < 0) {
            return null;
          }
          return { row, col, value: String(raw?.value ?? '') };
        })
        .filter(Boolean)
      : [];
    findMatchKeySet = new Set(findMatches.map(match => getFindMatchKey(match.row, match.col)));

    clearFindHighlights();
    applyFindHighlightsToRendered();
    if (findMatches.length > 0) {
      const preserveIndex = !!requestState?.preserveIndex;
      const priorIndex = Number.isInteger(requestState?.priorIndex) ? requestState.priorIndex : -1;
      const nextIndex = preserveIndex && priorIndex >= 0
        ? Math.min(priorIndex, findMatches.length - 1)
        : 0;
      setActiveFindMatch(nextIndex);
    } else {
      currentMatchIndex = -1;
      updateFindStatus();
      updateFindControls();
    }
  }
});

// After initial restoreState, if there's a pending edit request, perform it
const maybeResumePendingEdit = () => {
  try {
    const st = vscode.getState() || {};
    if (st && typeof st.anchorRow === 'number' && typeof st.anchorCol === 'number' && st.pendingEdit === 'detail') {
      const tag = (hasHeader && st.anchorRow === 0 ? 'th' : 'td');
      const sel = table.querySelector(`${tag}[data-row="${st.anchorRow}"][data-col="${st.anchorCol}"]`);
      if (sel) {
        editCell(sel, undefined, 'detail');
        // clear pending flag
        const next = { ...st };
        delete next.pendingEdit;
        vscode.setState(next);
      }
    }
  } catch {}
};

// Try after load and after visibility/focus restores
setTimeout(maybeResumePendingEdit, 0);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(maybeResumePendingEdit, 0); });
window.addEventListener('focus', () => { setTimeout(maybeResumePendingEdit, 0); }, { passive: true });

document.addEventListener('keydown', e => {
  if (findReplaceState.open) {
    return;
  }
  if(!editingCell && e.key === 'Escape'){
    clearSelection();
  }
});

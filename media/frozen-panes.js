// Layout uses measured dimensions so multiline cells, manual sizes and zoom agree.
window.createFrozenPaneManager = ({ table, firstRow, realRowCount, rowOrder, topInset, onNeedRows }) => {
  let rows = 0;
  let columns = 0;
  let scheduled = false;
  let disposed = false;
  const count = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const renderedRows = () => Array.from(table.rows).map(row => {
    const dataCell = Array.from(row.cells).find(cell => cell.hasAttribute('data-row'));
    return { element: row, index: Number(dataCell?.getAttribute('data-row')) };
  }).filter(row => Number.isInteger(row.index));
  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (!disposed) layout(); });
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  const observedRows = new WeakSet();
  const layout = () => {
    const rendered = renderedRows();
    for (const { element } of rendered) {
      if (!observedRows.has(element)) {
        observedRows.add(element);
        observer?.observe(element);
      }
    }
    table.querySelectorAll('.csv-frozen-row, .csv-frozen-column').forEach(cell => {
      cell.classList.remove('csv-frozen-row', 'csv-frozen-column');
      cell.style.top = '';
      cell.style.left = '';
      cell.style.zIndex = '';
    });
    const representative = rendered[0]?.element;
    const leftByColumn = new Map();
    let left = 0;
    if (columns && representative) {
      for (const cell of Array.from(representative.cells)) {
        const attr = cell.getAttribute('data-col');
        const col = attr === null ? -1 : Number(attr);
        if (col >= columns) break;
        leftByColumn.set(col, left);
        left += cell.getBoundingClientRect().width;
      }
    }
    const visibleRows = rowOrder?.length ? rowOrder.filter(row => row < realRowCount) : null;
    const frozenRows = visibleRows ? new Set(visibleRows.slice(0, rows)) : null;
    const lastFrozenRow = visibleRows ? (visibleRows[Math.min(rows, visibleRows.length) - 1] ?? -1) : Math.min(firstRow + rows, realRowCount) - 1;
    const firstFrozenCell = rendered.find(({ index }) => frozenRows ? frozenRows.has(index) : index >= firstRow && index <= lastFrozenRow)?.element.cells[0];
    // A collapsed border straddles the sticky edge. Cover its inner half once,
    // keeping the measured spacing between frozen rows unchanged.
    const topBorder = firstFrozenCell && getComputedStyle(table).borderCollapse === 'collapse'
      ? parseFloat(getComputedStyle(firstFrozenCell).borderTopWidth) || 0
      : 0;
    let top = (topInset?.() || 0) - topBorder / 2;
    for (const { element, index } of rendered) {
      const frozenRow = frozenRows ? frozenRows.has(index) : index >= firstRow && index <= lastFrozenRow;
      const height = element.getBoundingClientRect().height || Math.max(0, ...Array.from(element.cells).map(cell => cell.getBoundingClientRect().height));
      for (const cell of Array.from(element.cells)) {
        const attr = cell.getAttribute('data-col');
        const col = attr === null ? -1 : Number(attr);
        const frozenColumn = leftByColumn.has(col);
        if (frozenRow) {
          cell.classList.add('csv-frozen-row');
          cell.style.top = `${top}px`;
        }
        if (frozenColumn) {
          cell.classList.add('csv-frozen-column');
          cell.style.left = `${leftByColumn.get(col)}px`;
        }
        if (frozenRow || frozenColumn) {
          cell.style.zIndex = frozenRow && frozenColumn ? '4' : (frozenRow ? '3' : '2');
        }
      }
      if (frozenRow) top += height;
    }
    if (lastFrozenRow >= firstRow && (rendered[rendered.length - 1]?.index ?? -1) < lastFrozenRow) {
      onNeedRows?.(lastFrozenRow);
    }
  };
  return {
    schedule,
    layout,
    update(nextRows, nextColumns) {
      rows = count(nextRows);
      columns = count(nextColumns);
      schedule();
    },
    dispose() { disposed = true; observer?.disconnect(); }
  };
};

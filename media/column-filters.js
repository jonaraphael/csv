// Inline filter drafts live in this webview; only complete conditions reach the host.
window.createColumnFilterControls = ({ root, metadata, onChange, onLayout, onPending }) => {
  const columns = Array.isArray(metadata.columns) ? metadata.columns : [];
  const maxFilters = Number.isSafeInteger(metadata.maxFilters) ? metadata.maxFilters : 20;
  let revision = Number.isSafeInteger(metadata.revision) ? metadata.revision : 0;
  let timer = null;
  let nextId = 0;
  let snapshotRows = [];
  const rows = [];
  const make = (tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const toolbar = make('div');
  toolbar.className = 'column-filter-toolbar';
  const summary = make('span');
  summary.dataset.filterSummary = '';
  summary.setAttribute('aria-live', 'polite');
  const addButton = make('button', 'Add filter');
  addButton.id = 'addColumnFilter';
  addButton.type = 'button';
  const clearButton = make('button', 'Clear all filters');
  clearButton.id = 'clearAllFilters';
  clearButton.type = 'button';
  const globalError = make('span');
  globalError.dataset.filterError = '';
  globalError.setAttribute('role', 'alert');
  toolbar.append(summary, addButton, clearButton, globalError);
  const list = make('div');
  list.className = 'column-filter-conditions';
  root.replaceChildren(toolbar, list);
  root.setAttribute('aria-label', 'Column filters');
  const isUnary = operator => operator === 'empty' || operator === 'notEmpty';
  const typedOperator = operator => !['contains', 'notContains', 'regex', 'empty', 'notEmpty'].includes(operator);
  const columnFor = column => columns.find(item => item.column === column) || columns[0];
  const setSummary = data => { summary.textContent = `Filtered: ${data.matchedRows ?? 0} of ${data.totalRows ?? 0} rows`; };
  setSummary(metadata);
  const updateLayout = () => {
    root.hidden = rows.length === 0;
    addButton.disabled = !columns.length || rows.length >= maxFilters;
    clearButton.disabled = rows.length === 0;
    rows.forEach((row, index) => { row.and.textContent = index ? 'AND' : ''; });
    onLayout?.();
  };
  const clearErrors = () => {
    globalError.textContent = '';
    rows.forEach(row => {
      row.error.textContent = row.invalidOperator ? 'Choose an operator supported by this column type.' : '';
      row.value.toggleAttribute('aria-invalid', !!row.invalidOperator);
      if (row.invalidOperator) row.value.setAttribute('aria-invalid', 'true');
    });
  };
  const condition = row => {
    const column = columnFor(Number(row.column.value));
    const operator = row.operator.value;
    if (!column || (!isUnary(operator) && row.value.value.length === 0)) return null;
    const filter = { column: column.column, operator, value: isUnary(operator) ? '' : row.value.value };
    if (typedOperator(operator) && column.dataType !== 'string') filter.dataType = column.dataType;
    return filter;
  };
  const send = () => {
    timer = null;
    if (rows.some(row => row.composing)) return;
    snapshotRows = rows.filter(row => condition(row));
    onChange({ revision, filters: snapshotRows.map(condition) });
  };
  const changed = () => {
    // Invalidate older replies immediately, even before debounce/composition ends.
    revision += 1;
    onPending?.(true);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    clearErrors();
    if (!rows.some(row => row.composing)) timer = setTimeout(send, 100);
    updateLayout();
  };
  const fillOperators = (row, preferred) => {
    const column = columnFor(Number(row.column.value));
    row.operator.replaceChildren();
    for (const choice of column?.operators || []) {
      const option = make('option', choice.label);
      option.value = choice.operator;
      row.operator.append(option);
    }
    row.error.textContent = '';
    row.value.removeAttribute('aria-invalid');
    row.invalidOperator = !!preferred && !Array.from(row.operator.options).some(option => option.value === preferred);
    if (row.invalidOperator) {
      const unavailable = make('option', `${preferred} (unsupported for ${column?.dataType === 'string' ? 'text' : column?.dataType || 'text'})`);
      unavailable.value = preferred;
      unavailable.disabled = true;
      row.operator.append(unavailable);
      row.error.textContent = 'Choose an operator supported by this column type.';
      row.value.setAttribute('aria-invalid', 'true');
    }
    if (preferred) row.operator.value = preferred;
    row.value.hidden = isUnary(row.operator.value);
    row.value.disabled = isUnary(row.operator.value);
    row.type.textContent = column?.dataType === 'string' ? 'text' : column?.dataType || 'text';
  };
  const append = filter => {
    const column = columnFor(filter?.column);
    if (!column || rows.length >= maxFilters) return null;
    const id = ++nextId;
    const element = make('div');
    element.className = 'column-filter-row';
    const and = make('span');
    and.className = 'column-filter-and';
    const columnSelect = make('select');
    columnSelect.dataset.filterColumn = '';
    columnSelect.setAttribute('aria-label', `Filter ${id} column`);
    for (const item of columns) {
      const option = make('option', item.label);
      option.value = String(item.column);
      columnSelect.append(option);
    }
    columnSelect.value = String(column.column);
    const type = make('span');
    type.className = 'column-filter-type';
    const operator = make('select');
    operator.dataset.filterOperator = '';
    operator.setAttribute('aria-label', `Filter ${id} operator`);
    const value = make('input');
    value.type = 'text';
    value.dataset.filterValue = '';
    value.setAttribute('aria-label', `Filter ${id} value`);
    value.value = filter?.value || '';
    const remove = make('button', 'Remove');
    remove.type = 'button';
    remove.dataset.removeFilter = '';
    remove.setAttribute('aria-label', `Remove filter ${id}`);
    const error = make('span');
    error.id = `column-filter-error-${id}`;
    error.className = 'column-filter-error';
    error.setAttribute('role', 'alert');
    value.setAttribute('aria-describedby', error.id);
    const row = { element, and, column: columnSelect, type, operator, value, error, composing: false };
    fillOperators(row, filter?.operator || 'contains');
    element.append(and, columnSelect, type, operator, value, remove, error);
    list.append(element);
    rows.push(row);
    columnSelect.addEventListener('change', () => { fillOperators(row, operator.value); changed(); });
    operator.addEventListener('change', () => { row.invalidOperator = false; value.hidden = isUnary(operator.value); value.disabled = isUnary(operator.value); changed(); });
    value.addEventListener('input', changed);
    value.addEventListener('compositionstart', () => { row.composing = true; changed(); });
    value.addEventListener('compositionend', () => { row.composing = false; changed(); });
    remove.addEventListener('click', () => {
      rows.splice(rows.indexOf(row), 1);
      element.remove();
      changed();
    });
    return row;
  };
  const add = column => {
    const row = append({ column, operator: 'contains', value: '' });
    if (!row) return;
    changed();
    row.value.focus();
  };
  addButton.addEventListener('click', () => add(Number(rows[rows.length - 1]?.column.value ?? columns[0]?.column)));
  clearButton.addEventListener('click', () => {
    rows.splice(0).forEach(row => row.element.remove());
    changed();
  });
  for (const filter of metadata.filters || []) append(filter);
  updateLayout();
  return {
    add,
    retry: changed,
    get latestRevision() { return revision; },
    receive(message) {
      if (message.session !== metadata.session || message.revision !== revision) return false;
      clearErrors();
      if (Array.isArray(message.columns) && JSON.stringify(message.columns) !== JSON.stringify(columns)) {
        columns.length = 0;
        for (const column of message.columns) columns.push(column);
        for (const row of rows) {
          const selected = row.column.value;
          row.column.replaceChildren();
          for (const column of columns) {
            const option = make('option', column.label);
            option.value = String(column.column);
            row.column.append(option);
          }
          row.column.value = selected;
          fillOperators(row, row.operator.value);
        }
      }
      if (message.error) globalError.textContent = message.error;
      else if (message.errors?.length) globalError.textContent = 'Showing the last valid results.';
      for (const item of message.errors || []) {
        const row = snapshotRows[item.index];
        if (!row) continue;
        row.error.textContent = item.message;
        row.value.setAttribute('aria-invalid', 'true');
      }
      if (message.error || message.errors?.length) { setSummary(message); onLayout?.(); return true; }
      setSummary(message);
      onLayout?.();
      return true;
    }
  };
};

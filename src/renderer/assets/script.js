const vscode = acquireVsCodeApi();
let isUpdating = false;
let isSelecting = false;
let anchorCell = null;
let currentSelection = [];
let startCell = null;
let endCell = null;
let editingCell = null;
let originalCellValue = null;

const table = document.querySelector('table');
const container = document.querySelector('.table-container');

// Selection and Editing logic
function getCellCoords(cell) {
    const row = Number.parseInt(cell.getAttribute('data-row'));
    const col = Number.parseInt(cell.getAttribute('data-col'));
    return { row, col };
}

function clearSelection() {
    currentSelection.forEach(c => c.classList.remove('selected'));
    currentSelection = [];
}

function selectRange(start, end) {
    clearSelection();
    const startRow = Math.min(start.row, end.row);
    const endRow = Math.max(start.row, end.row);
    const startCol = Math.min(start.col, end.col);
    const endCol = Math.max(start.col, end.col);

    for (let r = startRow; r <= endRow; r++) {
        let rowCells = r === 0 ? table.querySelectorAll(`thead th[data-row="0"]`) : table.querySelectorAll(`tbody tr:nth-child(${r}) td[data-row="${r}"]`);
        for (let c = startCol; c <= endCol; c++) {
            const selCell = table.querySelector((r === 0 ? 'th' : 'td') + `[data-row="${r}"][data-col="${c}"]`);
            if (selCell) {
                selCell.classList.add('selected');
                currentSelection.push(selCell);
            }
        }
    }
}

table.addEventListener('mousedown', (e) => {
    if (editingCell && (e.target.tagName === 'TD' || e.target.tagName === 'TH')) {
        // Allow text selection within the editing cell
        return;
    }

    if (e.target.tagName !== 'TD' && e.target.tagName !== 'TH') { return; }

    if (editingCell && editingCell !== e.target) {
        editingCell.blur();
    }

    if (e.shiftKey) {
        if (!startCell) {
            startCell = e.target;
        }
        endCell = e.target;
        isSelecting = true;
    } else {
        startCell = e.target;
        endCell = e.target;
        isSelecting = true;
    }

    e.preventDefault();
});

table.addEventListener('mousemove', (e) => {
    if (!isSelecting) { return; }
    if (e.target.tagName === 'TD' || e.target.tagName === 'TH') {
        endCell = e.target;
        selectRange(getCellCoords(startCell), getCellCoords(endCell));
    }
});

table.addEventListener('mouseup', (e) => {
    if (!isSelecting) { return; }
    isSelecting = false;
    if (startCell === endCell) {
        clearSelection();
        editCell(startCell);
    } else {
        anchorCell = startCell;
    }
});

table.addEventListener('click', (e) => {
    if (e.shiftKey && anchorCell && (e.target.tagName === 'TD' || e.target.tagName === 'TH')) {
        selectRange(getCellCoords(anchorCell), getCellCoords(e.target));
    } else if (!e.shiftKey && (e.target.tagName === 'TD' || e.target.tagName === 'TH')) {
        anchorCell = e.target;
    }
});

// Function to set cursor at the end of the cell
function setCursorToEnd(cell) {
    setTimeout(() => { // Delay to ensure the cell is focused and editable
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.collapse(false); // Move cursor to the end
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }, 10); // 10ms delay
}

// Start editing a cell
function editCell(cell) {
    if (editingCell === cell) { return; }
    if (editingCell) {
        editingCell.blur();
    }
    originalCellValue = cell.innerText;
    editingCell = cell;
    cell.classList.add('editing');
    cell.setAttribute('contenteditable', 'true');
    cell.focus();
    setCursorToEnd(cell); // Set cursor at the end
}

// Handle blur event to stop editing
table.addEventListener('blur', (e) => {
    if (!editingCell) { return; }
    if (e.target === editingCell) {
        const row = parseInt(editingCell.getAttribute('data-row'));
        const col = parseInt(editingCell.getAttribute('data-col'));
        const value = editingCell.innerText;
        editingCell.removeAttribute('contenteditable');
        editingCell.classList.remove('editing');
        editingCell = null;
        vscode.postMessage({
            type: 'editCell',
            row: row,
            col: col,
            value: value
        });
    }
}, true);

// Keyboard events
table.addEventListener('keydown', (e) => {
    if (editingCell && ((e.ctrlKey || e.metaKey) && e.key === 's')) {
        e.preventDefault();
        editingCell.blur();
        vscode.postMessage({ type: 'save' });
    }

    if (editingCell && e.key === 'Enter') {
        e.preventDefault();
        const row = parseInt(editingCell.getAttribute('data-row'));
        const col = parseInt(editingCell.getAttribute('data-col'));
        editingCell.blur();

        // After committing with Enter, move focus down one cell
        const nextRow = row + 1;
        const nextCell = table.querySelector(`td[data-row="${nextRow}"][data-col="${col}"]`);
        if (nextCell) {
            editCell(nextCell);
        }
    }

    if (editingCell && e.key === 'Tab') {
        e.preventDefault();
        const row = parseInt(editingCell.getAttribute('data-row'));
        const col = parseInt(editingCell.getAttribute('data-col'));
        editingCell.blur();

        // Move focus to the cell to the right
        const nextCol = col + 1;
        const nextCell = table.querySelector(`td[data-row="${row}"][data-col="${nextCol}"]`);
        if (nextCell) {
            editCell(nextCell);
        }
    }

    if (editingCell && e.key === 'Escape') {
        e.preventDefault();
        editingCell.innerText = originalCellValue;
        editingCell.blur();
    }

    // Copy selection with Ctrl+C
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && currentSelection.length > 0) {
        e.preventDefault();
        copySelectionToClipboard();
    }
});

// Implement copy selection to clipboard
function copySelectionToClipboard() {
    if (currentSelection.length === 0) { return; }
    const coords = currentSelection.map(cell => getCellCoords(cell));
    const minRow = Math.min(...coords.map(c => c.row));
    const maxRow = Math.max(...coords.map(c => c.row));
    const minCol = Math.min(...coords.map(c => c.col));
    const maxCol = Math.max(...coords.map(c => c.col));

    // Send to extension for reliable copy
    vscode.postMessage(
        {
            type: 'copyToClipboard',
            minRow,
            maxRow,
            minCol,
            maxCol
        }
    );
}

window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
        case 'updateCell':
            isUpdating = true;
            const { row, col, value } = message;
            const cell = table.querySelector('td[data-row="' + row + '"][data-col="' + col + '"]');
            if (cell) {
                cell.innerText = value;
            }
            isUpdating = false;
            break;
    }
});
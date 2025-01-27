import { isDate, hslToHex } from './utils';

export function estimateColumnDataType(column: string[]): string {
    let allBoolean = true;
    let allDate = true;
    let allInteger = true;
    let allFloat = true;
    let allEmpty = true;

    for (const cell of column) {
        // Split by comma and trim whitespace
        const items = cell.split(',').map(item => item.trim());
        for (const item of items) {
            if (item === '') {
                continue; // Skip empty items
            }
            allEmpty = false;

            // Check for boolean
            const lower = item.toLowerCase();
            if (!(lower === 'true' || lower === 'false')) {
                allBoolean = false;
            }

            // Check for date
            if (!isDate(item)) {
                allDate = false;
            }

            // Check for integer
            const num = Number(item);
            if (!Number.isInteger(num)) {
                allInteger = false;
            }

            // Check for float
            if (isNaN(num)) {
                allFloat = false;
            } else {
                if (item.includes('.')) {
                    // It's a float
                } else {
                    // It's an integer
                }
            }
        }
    }

    // Determine the most specific type
    if (allEmpty) {
        return "empty";
    }
    if (allBoolean) {
        return "boolean";
    }
    if (allDate) {
        return "date";
    }
    if (allInteger) {
        return "integer";
    }
    if (allFloat) {
        return "float";
    }
    return "string";
}

export function getColumnColor(type: string, isDark: boolean, columnIndex: number): string {
    let hueRange = 0;
    let isDefault = false;

    switch (type) {
        case "boolean":
            hueRange = 30;
            break;
        case "date":
            hueRange = 210;
            break;
        case "float":
            hueRange = isDark ? 60 : 270;
            break;
        case "integer":
            hueRange = 120;
            break;
        case "string":
            hueRange = 0;
            break;
        case "empty":
            isDefault = true;
            break;
    }

    if (isDefault) {
        return isDark ? "#BBB" : "#444";
    }

    const saturationOffset = Math.floor(Math.random() * 13);
    const saturation = saturationOffset + (isDark ? 85 : 60);
    const lightnessOffset = isDark ? saturation * 0.9 : saturation - 22;
    const lightness = lightnessOffset;
    const hueOffset = ((columnIndex * 17) % 31) - 15;
    const finalHue = (hueRange + hueOffset + 360) % 360;

    return hslToHex(finalHue, saturation, lightness);
}


export function computeColumnWidths(data: string[][]): number[] {
    console.log('CSV: Computing column widths');
    const numColumns = Math.max(...data.map(row => row.length));
    const widths = new Array(numColumns).fill(0);

    for (let row of data) {
        for (let i = 0; i < numColumns; i++) {
            const cell = row[i] || '';
            const cellWidth = Math.max(...cell.split(/\n+/).map(x => x.length)); // consider multilines
            widths[i] = Math.max(widths[i], cellWidth);
        }
    }

    console.log(`CSV: Column widths: ${widths}`);
    return widths;
}

export function getMaxColLen(data: string[][]): number {
    return Math.max(...data.map(row => row.length))
}

export function transpose(data: string[][]): string[][] {
    const numCols = getMaxColLen(data);
    const columnData: string[][] = Array.from({ length: numCols }, () => []);

    for (let rowIndex = 0; rowIndex < data.length; rowIndex++) {
        const row = data[rowIndex];
        for (let i = 0; i < numCols; i++) {
            columnData[i].push(row[i] || "");
        }
    }
    return columnData
}
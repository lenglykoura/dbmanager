export function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

export function exportData(format, table, headers, rowsToExport) {
    if (format === 'csv') {
        const csv = [
            headers.join(','),
            ...rowsToExport.map(r => r.map(c => c === null ? '' : `"${String(c).replace(/"/g, '""')}"`).join(','))
        ].join('\n');
        downloadFile(`${table}.csv`, csv, 'text/csv');
    } else {
        const json = rowsToExport.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
        downloadFile(`${table}.json`, JSON.stringify(json, null, 2), 'application/json');
    }
}
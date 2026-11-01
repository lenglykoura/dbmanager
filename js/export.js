export function downloadFile(filename, content, type = 'text/plain;charset=utf-8;') {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatBytes(bytes, decimals = 1) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function exportData(format, table, headers, rowsToExport) {
    if (format === 'csv') {
        const safeHeaders = (headers || []).map(h => `"${String(h ?? '').replace(/"/g, '""')}"`).join(',');
        const csvRows = (rowsToExport || []).map(r => 
            (Array.isArray(r) ? r : headers.map(h => r[h])).map(c => 
                c === null || c === undefined ? '' : `"${String(c).replace(/"/g, '""')}"`
            ).join(',')
        );
        // Prepend UTF-8 BOM (\uFEFF) for proper Excel / Unicode encoding support
        const csvContent = '\uFEFF' + [safeHeaders, ...csvRows].join('\r\n');
        downloadFile(`${table || 'export'}.csv`, csvContent, 'text/csv;charset=utf-8;');
    } else {
        const json = (rowsToExport || []).map(r => {
            if (Array.isArray(r)) {
                return Object.fromEntries((headers || []).map((h, i) => [h, r[i]]));
            }
            return r;
        });
        downloadFile(`${table || 'export'}.json`, JSON.stringify(json, null, 2), 'application/json;charset=utf-8;');
    }
}

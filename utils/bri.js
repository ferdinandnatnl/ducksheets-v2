import { PdfReader } from "pdfreader";

export function convertBriPdfToCsv(pdfPath, fileName, callback) {
    let csvContent = "tanggal,keterangan,status,value,debit,kredit\n";
    const pdfReader = new PdfReader();
    let isTransactionSection = false;
    let currentEntry = {};
    let lastY = 0;

    pdfReader.parseFileItems(pdfPath, (error, item) => {
        if (error) {
            console.error("Error parsing PDF:", error);
            callback(error);
        } else if (!item) {
            console.log("Finished parsing PDF");
            if (Object.keys(currentEntry).length > 0) {
                addEntryToCsv(currentEntry);
            }
            callback(null, csvContent);
        } else if (item.text) {
            processTextItem(item);
        }
    });

    //test

    function processTextItem(item) {
        let text = item.text.trim();
        if (text.includes("Tanggal Transaksi") || text.includes("Transaction Date")) {
            isTransactionSection = true;
            return;
        }
        if (!isTransactionSection) return;
        if (text.includes("Saldo Awal") || text.includes("Opening Balance")) {
            isTransactionSection = false;
            return;
        }
        // New row detection
        if (Math.abs(item.y - lastY) > 1 || text.match(/^\d{2}\/\d{2}\/\d{2}/)) {
            if (Object.keys(currentEntry).length > 0) {
                addEntryToCsv(currentEntry);
            }
            currentEntry = { tanggal: "", keterangan: "", debet: "", kredit: "" };
        }
        lastY = item.y;
        if (text.match(/^\d{2}\/\d{2}\/\d{2}/)) {
            currentEntry.tanggal = text.slice(0, 5);
        } else if (item.x >= 3 && item.x <= 15) {
            currentEntry.keterangan += (currentEntry.keterangan ? " " : "") + text;
        } else if (item.x > 19 && item.x <= 30) {
            const value = parseNumber(text);
            if (value > 0) {
                currentEntry.debet = value;
            }
        } else if (item.x > 30 && item.x <= 35) {
            const value = parseNumber(text);
            if (value > 0) {
                currentEntry.kredit = value;
            }
        }
    }

    function addEntryToCsv(entry) {
        if (entry.tanggal && entry.keterangan) {
            if (entry.debet > 0) {
                const formattedValue = formatRupiah(entry.debet);
                csvContent += [
                    quoteIfNeeded(entry.tanggal),
                    quoteIfNeeded(entry.keterangan),
                    quoteIfNeeded("DEBIT"),
                    quoteIfNeeded(formattedValue),
                    quoteIfNeeded(formattedValue), // debit
                    quoteIfNeeded("0"),             // kredit
                ].join(",") + "\n";
            } else if (entry.kredit > 0) {
                const formattedValue = formatRupiah(entry.kredit);
                csvContent += [
                    quoteIfNeeded(entry.tanggal),
                    quoteIfNeeded(entry.keterangan),
                    quoteIfNeeded("CREDIT"),
                    quoteIfNeeded(formattedValue),
                    quoteIfNeeded("0"),             // debit
                    quoteIfNeeded(formattedValue),  // kredit
                ].join(",") + "\n";
            }
        }
    }

    function parseNumber(numStr) {
        if (!numStr) return 0;
        let s = String(numStr).trim().replace(/\s+/g, "");

        const dotCount = (s.match(/\./g) || []).length;
        const commaCount = (s.match(/,/g) || []).length;

        if (dotCount > 0 && commaCount > 0) {
            const lastDot = s.lastIndexOf(".");
            const lastComma = s.lastIndexOf(",");
            if (lastComma > lastDot) {
                s = s.replace(/\./g, "").replace(/,/g, ".");
            } else {
                s = s.replace(/,/g, "");
            }
        } else if (commaCount > 0 && dotCount === 0) {
            s = s.replace(/,/g, ".");
        } else if (dotCount > 1) {
            s = s.replace(/\./g, "");
        }

        const parsed = parseFloat(s);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function formatRupiah(value) {
        return Number(value).toLocaleString("id-ID", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    function quoteIfNeeded(value = "") {
        const s = String(value);
        return s.includes(",") ? `"${s}"` : s;
    }
}

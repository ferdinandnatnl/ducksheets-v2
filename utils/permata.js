import { PdfReader } from "pdfreader";

export function convertPermataPdfToCsv(pdfPath, fileName, callback) {
    let csvContent = "tanggal,kategori,keterangan,status,value\n";
    const pdfReader = new PdfReader();
    let pageBuffer = [];
    let currentPage = 0;

    const categories = [
        "PB DARI KREDITUR PENAMPUNGAN BACH M PV BATCH",
        "PURCHASE ALTO",
        "TRF BIFAST KE",
        "TRF KE",
        "PENDAPATAN BUNGA",
        "PAJAK ATAS BUNGA"
    ];

    pdfReader.parseFileItems(pdfPath, (error, item) => {
        if (error) {
            console.error("Error parsing PDF:", error);
            callback(error);
        } else if (!item) {
            processPageBuffer(currentPage);
            callback(null, csvContent);
        } else if (item.page) {
            if (item.page !== currentPage) {
                processPageBuffer(currentPage);
                pageBuffer = [];
                currentPage = item.page;
            }
        } else if (item.text && currentPage >= 2) {
            pageBuffer.push(item);
        }
    });

    function processPageBuffer(pageNum) {
        console.log(`Processing page ${pageNum}`);
        let object = {};
        let line = 0;

        pageBuffer.sort((a, b) => a.y - b.y || a.x - b.x);

        pageBuffer.forEach((item) => {
            let text = item.text.trim();
            console.log(`Found text: "${text}" at x=${item.x.toFixed(2)}, y=${item.y.toFixed(2)}`);

            if (item.x > 1 && item.x < 3) { // Date column
                if (text.match(/^\d{2}\/\d{2}$/)) {
                    if (line > 0) {
                        addToCsv(object);
                    }
                    object = {};
                    line++;
                    object.tanggal = text;
                    console.log(`Found date: ${text}`);
                }
            } else if (item.x > 3 && item.x < 15) { // Description
                let cleanedText = cleanKeterangan(text);
                object.keterangan = (object.keterangan || "") + " " + cleanedText;
            } else if (item.x > 15 && item.x < 20) { // Debit column
                const value = parseNumber(text);
                if (value > 0) {
                    object.value = value;
                    object.status = "DEBIT";
                    console.log(`Found debit: ${value}`);
                }
            } else if (item.x > 20 && item.x < 25) { // Credit column
                const value = parseNumber(text);
                if (value > 0) {
                    object.value = value;
                    object.status = "CREDIT";
                    console.log(`Found credit: ${value}`);
                }
            }
        });

        // Add the last object of the page
        if (object.tanggal) {
            addToCsv(object);
        }
    }

    function addToCsv(obj) {
        let { kategori, keterangan } = splitKategoriKeterangan(obj.keterangan);
        const formattedValue = Number.isFinite(obj.value) ? formatRupiah(obj.value) : "";
        const row = [
            quoteIfNeeded(obj.tanggal || ""),
            quoteIfNeeded(kategori),
            quoteIfNeeded(keterangan),
            quoteIfNeeded(obj.status || ""),
            quoteIfNeeded(formattedValue),
        ].join(",");
        csvContent += `${row}\n`;
        console.log(`Adding to CSV: ${obj.tanggal}, ${kategori}, ${keterangan}, ${obj.status}, ${formattedValue}`);
    }

    function cleanKeterangan(text) {
        return text
            .replace(/\d+([.,]\d+)?/g, "") // Remove numbers, including those with decimal points
            .replace(/:/g, "")
            .replace(/\//g, "")
            .replace(/\d{2}\s*\/\s*\d{2}/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function splitKategoriKeterangan(text) {
        if (!text) return { kategori: "", keterangan: "" };
        
        for (let category of categories) {
            if (text.startsWith(category)) {
                return {
                    kategori: category,
                    keterangan: text.slice(category.length).trim()
                };
            }
        }
        return { kategori: "", keterangan: text.trim() };
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
            maximumFractionDigits: 2
        });
    }

    function quoteIfNeeded(value = "") {
        const s = String(value);
        return s.includes(",") ? `"${s}"` : s;
    }
}

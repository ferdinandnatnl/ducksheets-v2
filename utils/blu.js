import { PdfReader } from "pdfreader";

export function convertBluPdfToCsv(pdfPath, fileName, callback) {
  // CSV header
  let csvContent = "date,kategori,description,notes,status,value,debit,credit,saldo\n";
  const pdfReader = new PdfReader();

  let currentRow = {};
  let currentLineY = null;

  function isAmountText(text = "") {
    return /^-?\s?\d{1,3}(?:\.\d{3})*,\d{2}$/.test(text.trim());
  }

  function parseNumber(numStr) {
    if (!numStr) return 0;

    // BLU format examples: "- 166.825,00", "100.000.000,00"
    let s = numStr.trim().replace(/\s+/g, "");
    const isNegative = s.startsWith("-");

    s = s.replace(/^[+-]/, "");
    s = s.replace(/\./g, "").replace(/,/g, ".");

    const parsed = parseFloat(s) || 0;
    return isNegative ? -parsed : parsed;
  }

  // Format for Indonesian-style numbers: 1.234.567,89
  function formatRupiah(value) {
    return value.toLocaleString("id-ID", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function quoteIfNeeded(value = "") {
    return value.includes(",") ? `"${value}"` : value;
  }

  function transformDate(dateText) {
    // Convert "01 Jan 2025" => "01/01"
    const [day, mon] = dateText.split(" ");
    const monthMap = {
      Jan: "01",
      Feb: "02",
      Mar: "03",
      Apr: "04",
      May: "05",
      Jun: "06",
      Jul: "07",
      Aug: "08",
      Sep: "09",
      Oct: "10",
      Nov: "11",
      Dec: "12",
    };
    return `${day}/${monthMap[mon] || "01"}`;
  }

  function startNewRow(dateText, y) {
    addRowToCsv(currentRow);
    currentRow = { date: transformDate(dateText) };
    currentLineY = y;
  }

  pdfReader.parseFileItems(pdfPath, (error, item) => {
    if (error) {
      console.error("Error parsing PDF:", error);
      callback(error);
      return;
    }

    // End of PDF => finalize the last row
    if (!item) {
      addRowToCsv(currentRow);
      callback(null, csvContent);
      return;
    }

    // Page boundary: flush pending row so data doesn't bleed across pages.
    if (item.page) {
      addRowToCsv(currentRow);
      currentRow = {};
      currentLineY = null;
      return;
    }

    if (!item.text) return;

    const text = item.text.trim();

    // Main transaction body area for BLU statement pages
    if (item.y > 12.5 && item.y < 46.5) {
      console.log(`x=${item.x.toFixed(2)}, y=${item.y.toFixed(2)}, text="${text}"`);

      // 1) New row: date column (x around 1.38) e.g. "01 Jan 2025"
      if (item.x > 1.2 && item.x < 1.7 && /^\d{2} [A-Za-z]{3} \d{4}$/.test(text)) {
        startNewRow(text, item.y);
      }
      // Only process row fields after we have a valid date row.
      else if (currentRow.date && currentLineY !== null && item.y >= currentLineY - 0.2 && item.y <= currentLineY + 1.4) {
        // 2) Time at x ~1.38 (optional notes field)
        if (item.x > 1.2 && item.x < 1.7 && /^\d{2}:\d{2}$/.test(text)) {
          currentRow.notes = text;
        }
        // 3) Description-related texts at x ~8.50
        else if (item.x > 8.0 && item.x < 12.8) {
          if (!currentRow.description) {
            currentRow.description = text;
          } else if (!currentRow.kategori) {
            currentRow.kategori = text;
          } else {
            currentRow.description += " " + text;
          }
        }
        // 4) Transaction amount at x ~24.5..27.5
        else if (item.x > 24.0 && item.x < 28.5 && isAmountText(text)) {
          currentRow.valueText = text;
          currentRow.rawStatus = text.includes("-") ? "DB" : "CR";
        }
        // 5) Saldo at x ~30.8..32.2
        else if (item.x > 30.5 && item.x < 32.8 && isAmountText(text)) {
          currentRow.saldoText = text;
        }
      }
    }
  });

  function addRowToCsv(row) {
    // Only write complete transaction rows
    if (!row.date || !row.valueText) return;

    const parsedAmount = parseNumber(row.valueText);
    const status = row.rawStatus === "DB" || parsedAmount < 0 ? "DEBIT" : "CREDIT";
    const absoluteAmount = Math.abs(parsedAmount);
    const formattedValue = formatRupiah(absoluteAmount);

    let debit = "0";
    let credit = "0";
    if (status === "DEBIT") {
      debit = formattedValue;
    } else {
      credit = formattedValue;
    }

    const saldoParsed = row.saldoText ? parseNumber(row.saldoText) : null;
    const saldoStr = saldoParsed === null ? "" : formatRupiah(saldoParsed);

    const csvRow = [
      quoteIfNeeded(row.date || ""),
      quoteIfNeeded(row.kategori || ""),
      quoteIfNeeded(row.description || ""),
      quoteIfNeeded(row.notes || ""),
      quoteIfNeeded(status),
      quoteIfNeeded(formattedValue),
      quoteIfNeeded(debit),
      quoteIfNeeded(credit),
      quoteIfNeeded(saldoStr),
    ].join(",");

    csvContent += csvRow + "\n";
  }
}

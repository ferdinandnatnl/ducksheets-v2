import { PdfReader } from "pdfreader";

export function convertBcaPdfToCsv(pdfPath, fileName, callback) {
  // CSV header
  let csvContent = "date,kategori,description,notes,status,value,debit,credit,saldo\n";
  const pdfReader = new PdfReader();

  let currentRow = {};
  let lineCounter = 0;
  let currentLineY = 0;
  let currentSaldo = null;

  /**
   * If a string has both '.' and ',', we must figure out which is the thousand separator and
   * which is the decimal. For example:
   *   "13.200.000,50"  => '.' is thousand, ',' is decimal => 13200000.50
   *   "13,200,000.50"  => ',' is thousand, '.' is decimal => 13200000.50
   *
   * If it has only one type of symbol, assume it's decimal if it appears in the last 3-4 chars,
   * else assume it's thousand. This function tries to handle all typical cases.
   */
  function parseNumber(numStr) {
    if (!numStr) return 0;
    let s = numStr.trim();

    const dotCount = (s.match(/\./g) || []).length;
    const commaCount = (s.match(/,/g) || []).length;

    // Decide which symbol is decimal, which is thousand
    let decimalSymbol = ".";
    let thousandSymbol = ",";

    // 1) If there's only '.' or only ',' or none:
    if (dotCount === 0 && commaCount === 0) {
      // "13200000" => no decimal symbol
      return parseFloat(s) || 0;
    } else if (dotCount > 0 && commaCount === 0) {
      // e.g. "13200000.00" => '.' is decimal
      decimalSymbol = ".";
      thousandSymbol = ""; // no thousand symbol
    } else if (commaCount > 0 && dotCount === 0) {
      // e.g. "13200000,00" => ',' is decimal
      decimalSymbol = ",";
      thousandSymbol = ""; // no thousand symbol
    }
    // 2) If we have both '.' and ',' => figure out which is decimal:
    else {
      // We guess if '.' appears multiple times and ',' appears once at the end => '.' is thousand, ',' is decimal
      // or if ',' appears multiple times and '.' once => ',' is thousand, '.' is decimal
      // e.g. "13.200.000,00" => '.' is thousand, ',' is decimal
      //      "13,200,000.00" => ',' is thousand, '.' is decimal
      // A simple approach:
      if (dotCount > commaCount) {
        // Probably '.' is thousand, ',' is decimal
        thousandSymbol = ".";
        decimalSymbol = ",";
      } else if (commaCount > dotCount) {
        // Probably ',' is thousand, '.' is decimal
        thousandSymbol = ",";
        decimalSymbol = ".";
      } else {
        // If they're equal, guess by position of the last occurrence:
        // If the last symbol is ',', then ',' is decimal, else '.' is decimal
        const lastDot = s.lastIndexOf(".");
        const lastComma = s.lastIndexOf(",");
        if (lastComma > lastDot) {
          // last comma is further to the right => ',' is decimal
          thousandSymbol = ".";
          decimalSymbol = ",";
        } else {
          // '.' is decimal
          thousandSymbol = ",";
          decimalSymbol = ".";
        }
      }
    }

    // Remove all thousand separators
    if (thousandSymbol) {
      const escapedThousand = "\\" + thousandSymbol; // e.g. '\.' or '\,'
      s = s.replace(new RegExp(escapedThousand, "g"), "");
    }

    // Convert decimal symbol to '.' for parseFloat
    if (decimalSymbol === ",") {
      s = s.replace(/,/g, ".");
    }

    return parseFloat(s) || 0;
  }

  // Format for Indonesian-style "Rp" numbers: 1.234.567,89
  function formatRupiah(value) {
    return value.toLocaleString("id-ID", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function quoteIfNeeded(value = "") {
    // If the string itself contains commas, wrap in quotes
    return value.includes(",") ? `"${value}"` : value;
  }

  function normalizeDateToken(raw = "") {
    const text = String(raw || "").trim();
    const match = text.match(/^(\d{1,2})[\/.-](\d{1,2})$/);
    if (!match) return "";

    const day = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    if (!Number.isFinite(day) || !Number.isFinite(month)) return "";
    if (day < 1 || day > 31 || month < 1 || month > 12) return "";

    return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
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

    if (item.text) {
      const text = item.text.trim();

      // Process items in the standard region (most rows)
      if (item.y > 13.9 && item.y < 45.5) {
        console.log(`x=${item.x.toFixed(2)}, y=${item.y.toFixed(2)}, text="${text}"`);

        // 1) New line if x in [2..3]
        if (item.x > 2 && item.x < 3) {
          const normalizedDate = normalizeDateToken(text);
          if (!normalizedDate) {
            return;
          }
          if (lineCounter > 0) {
            addRowToCsv(currentRow);
          }
          currentRow = {};
          lineCounter++;
          currentLineY = item.y;
          currentRow.date = normalizedDate; // e.g. "01/10"
        }
        // 2) Kategori if x in [5..5.9]
        else if (item.x > 5 && item.x < 5.9) {
          currentRow.kategori = currentRow.kategori
            ? currentRow.kategori + " " + text
            : text;
        }
        // 3) Description if x in [11.8..12.2]
        else if (item.x > 11.8 && item.x < 12.2) {
          currentRow.description = currentRow.description
            ? currentRow.description + " " + text
            : text;
        }
        // 4) Transaction amount if x in [23..25.2] and on the same line
        else if (item.x > 23 && item.x < 25.2 && item.y === currentLineY) {
          currentRow.valueText = text;
        }
        // 5) DB text if x in [27..29]
        else if (item.x > 27 && item.x < 29) {
          if (text.includes("DB")) {
            currentRow.rawStatus = "DB";
          }
        }
        // 6) Edge case if x in [31..31.5] and it's the first line
        else if (item.x > 31 && item.x < 31.5 && lineCounter === 1) {
          currentRow.valueText = text;
        }
        // 7) Saldo if x in [30..60] on the first line
        else if (item.x > 30 && item.x < 60 && lineCounter === 1) {
          console.log(`Top SALDO: x=${item.x}, text="${text}"`);
          currentRow.saldoText = text;
        }
        // 8) Fallback: if none of the above x conditions matched, and the text is purely numeric,
        //    assume it might be the missing transaction amount.
        else if (/^[0-9.,]+$/.test(text) && !currentRow.valueText) {
          currentRow.valueText = text;
        }
      }
      // Additional branch for items outside the typical y-range (if needed)
      else if (item.y >= 45.5 && /^[0-9.,]+$/.test(text)) {
        // Flush the current row if not empty
        if (Object.keys(currentRow).length > 0) {
          addRowToCsv(currentRow);
          currentRow = {};
        }
        // Start a new row with this numeric value
        currentRow.valueText = text;
      }
    }
  });

  function addRowToCsv(row) {
    const normalizedDate = normalizeDateToken(row.date || "");
    // Keep only transaction rows that have a valid date token.
    if (!normalizedDate || !row.valueText) return;

    // Determine if it's a DB or CR
    const status = row.rawStatus === "DB" ? "DEBIT" : "CREDIT";
    // Parse the raw transaction string
    const transactionAmount = parseNumber(row.valueText || "");

    // Format the transaction amount in Indonesian style
    const formattedValue = formatRupiah(transactionAmount);

    let debit = "";
    let credit = "";
    if (status === "DEBIT") {
      debit = formattedValue;
      credit = "0";
    } else {
      credit = formattedValue;
      debit = "0";
    }

    // SALDO calculation
    if (currentSaldo === null && row.saldoText) {
      // If it's the first line, parse the existing saldo
      currentSaldo = parseNumber(row.saldoText);
    } else if (currentSaldo !== null) {
      // Subtract or add the transaction amount
      if (status === "DEBIT") {
        currentSaldo -= transactionAmount;
      } else {
        currentSaldo += transactionAmount;
      }
    }

    // Format the saldo in Indonesian style
    let saldoStr = "";
    if (currentSaldo !== null) {
      saldoStr = formatRupiah(currentSaldo);
    }

    const csvRow = [
      quoteIfNeeded(normalizedDate),
      quoteIfNeeded(row.kategori || ""),
      quoteIfNeeded(row.description || ""),
      quoteIfNeeded(""), // notes
      quoteIfNeeded(status),
      quoteIfNeeded(formattedValue), // "value"
      quoteIfNeeded(debit),
      quoteIfNeeded(credit),
      quoteIfNeeded(saldoStr)
    ].join(",");

    csvContent += csvRow + "\n";
  }
}

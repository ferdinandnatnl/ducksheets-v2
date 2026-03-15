const INCOME_STATUS_TOKENS = [
  "credit",
  "cr",
  "kredit",
  "kr",
  "income",
  "penghasilan",
  "masuk",
];

const EXPENSE_STATUS_TOKENS = [
  "debit",
  "db",
  "dr",
  "debet",
  "keluar",
  "expense",
  "beban",
];

const MONTH_NUMBER_TO_NAME = {
  1: "JANUARY",
  2: "FEBRUARY",
  3: "MARCH",
  4: "APRIL",
  5: "MAY",
  6: "JUNE",
  7: "JULY",
  8: "AUGUST",
  9: "SEPTEMBER",
  10: "OCTOBER",
  11: "NOVEMBER",
  12: "DECEMBER",
};

const MONTH_ALIAS_TO_NUMBER = {
  jan: 1,
  january: 1,
  januri: 1,
  feb: 2,
  february: 2,
  febuari: 2,
  mar: 3,
  march: 3,
  maret: 3,
  apr: 4,
  april: 4,
  mei: 5,
  may: 5,
  jun: 6,
  june: 6,
  juni: 6,
  jul: 7,
  july: 7,
  juli: 7,
  aug: 8,
  august: 8,
  agt: 8,
  agustus: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  okt: 10,
  oktober: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
  des: 12,
  desember: 12,
};

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsStatusToken(statusValue, token) {
  const normalized = normalizeToken(statusValue).replace(/[^a-z0-9\s]+/g, " ");
  if (token.includes(" ")) {
    return normalized.includes(token);
  }
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(normalized);
}

function hasIncomeStatus(statusValue) {
  return INCOME_STATUS_TOKENS.some((token) => containsStatusToken(statusValue, token));
}

function hasExpenseStatus(statusValue) {
  return EXPENSE_STATUS_TOKENS.some((token) => containsStatusToken(statusValue, token));
}

function parseAmount(value) {
  const original = String(value || "").trim();
  if (!original) return 0;

  const isNegative = original.includes("-") || /^\(.*\)$/.test(original);
  let cleaned = original.replace(/[^\d.,]/g, "");
  if (!cleaned) return 0;

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  } else if (hasComma) {
    const commaParts = cleaned.split(",");
    const lastPart = commaParts[commaParts.length - 1] || "";
    if (lastPart.length <= 2) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  } else {
    cleaned = cleaned.replace(/,/g, "");
  }

  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return isNegative ? -Math.abs(parsed) : parsed;
}

function parseCsvRows(csvContent) {
  const rows = [];
  let currentRow = [];
  let currentValue = "";
  let inQuotes = false;
  const content = String(csvContent || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentValue += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = "";
      rows.push(currentRow);
      currentRow = [];

      if (char === "\r" && nextChar === "\n") {
        i += 1;
      }
      continue;
    }

    currentValue += char;
  }

  currentRow.push(currentValue);
  if (!(currentRow.length === 1 && currentRow[0] === "" && rows.length > 0)) {
    rows.push(currentRow);
  }

  return rows.filter((row, index) => !(index === 0 && row.length === 1 && row[0] === ""));
}

function serializeCsvRows(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? "");
          if (/["\n\r,]/.test(value)) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value;
        })
        .join(",")
    )
    .join("\n");
}

function findExactHeaderIndex(normalizedHeaders, candidates) {
  return normalizedHeaders.findIndex((header) => candidates.includes(header));
}

function findHeaderByIncludes(normalizedHeaders, terms) {
  return normalizedHeaders.findIndex((header) => terms.some((term) => header.includes(term)));
}

function isRowEmpty(row) {
  return row.every((value) => String(value || "").trim() === "");
}

function normalizeIncomeValueText(valueText) {
  let normalized = String(valueText || "").trim();
  if (/^\(.*\)$/.test(normalized)) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/^-+\s*/, "").trim();
  return normalized;
}

function isSetoranTunaiRow(kategori, description) {
  const combined = normalizeToken(`${kategori || ""} ${description || ""}`).replace(/[^a-z0-9\s]+/g, " ");
  return (
    combined.includes("setoran tunai") ||
    combined.includes("setor tunai") ||
    combined.includes("cash deposit")
  );
}

function normalizeYearPart(yearText) {
  const digits = String(yearText || "").replace(/\D/g, "");
  if (!digits) return "25";
  if (digits.length >= 4) return digits.slice(-2);
  if (digits.length === 1) return `0${digits}`;
  return digits.slice(-2);
}

function parseDayMonthParts(dateText) {
  const raw = String(dateText || "").trim();
  if (!raw) return null;
  const value = raw.replace(/,/g, " ").replace(/\s+/g, " ").trim();

  const ymdMatch = value.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/);
  if (ymdMatch) {
    const monthNumber = Number.parseInt(ymdMatch[2], 10);
    const day = Number.parseInt(ymdMatch[3], 10);
    if (monthNumber >= 1 && monthNumber <= 12 && day >= 1 && day <= 31) {
      return {
        day,
        monthNumber,
        monthName: MONTH_NUMBER_TO_NAME[monthNumber],
        yearTwoDigits: normalizeYearPart(ymdMatch[1]),
      };
    }
  }

  const dmyNumericMatch = value.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/);
  if (dmyNumericMatch) {
    const day = Number.parseInt(dmyNumericMatch[1], 10);
    const monthNumber = Number.parseInt(dmyNumericMatch[2], 10);
    if (monthNumber >= 1 && monthNumber <= 12 && day >= 1 && day <= 31) {
      return {
        day,
        monthNumber,
        monthName: MONTH_NUMBER_TO_NAME[monthNumber],
        yearTwoDigits: normalizeYearPart(dmyNumericMatch[3]),
      };
    }
  }

  const dmyTextMatch = value.match(/^(\d{1,2})\s+([a-zA-Z.]+)(?:\s+(\d{2,4}))?$/);
  if (dmyTextMatch) {
    const day = Number.parseInt(dmyTextMatch[1], 10);
    const monthToken = String(dmyTextMatch[2] || "").toLowerCase().replace(/\./g, "");
    const monthNumber = MONTH_ALIAS_TO_NUMBER[monthToken];
    if (monthNumber && day >= 1 && day <= 31) {
      return {
        day,
        monthNumber,
        monthName: MONTH_NUMBER_TO_NAME[monthNumber],
        yearTwoDigits: normalizeYearPart(dmyTextMatch[3]),
      };
    }
  }

  return null;
}

function buildReferenceCode(dateParts) {
  if (!dateParts || !dateParts.day || !dateParts.monthNumber) return "";
  const monthText = String(dateParts.monthNumber).padStart(2, "0");
  return `BCA-I25${monthText}-${dateParts.day}`;
}

function formatDateDdMmYy(dateParts) {
  if (!dateParts?.day || !dateParts?.monthNumber) return "";
  const dayText = String(dateParts.day).padStart(2, "0");
  const monthText = String(dateParts.monthNumber).padStart(2, "0");
  const yearText = normalizeYearPart(dateParts.yearTwoDigits);
  return `${dayText}/${monthText}/${yearText}`;
}

function extractInvoiceNumberFromRow(rowValues) {
  const source = Array.isArray(rowValues)
    ? rowValues.map((value) => String(value || "")).join(" ")
    : String(rowValues || "");
  const normalized = source
    .replace(/\u00A0/g, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    // Fix split Roman month token like ".../VI I/2025" -> ".../VII/2025"
    .replace(/\/([IVXLCDM]{1,7})\s+([IVXLCDM]{1,3})\/(\d{2}|\d{4})/gi, "/$1$2/$3")
    .replace(/\s+/g, " ")
    .trim();

  const candidates = normalized.match(/\b\d{1,6}(?:\/[A-Za-z0-9-]{1,24}){2,10}\b/g) || [];
  if (candidates.length === 0) return "";

  const scored = candidates
    .map((candidate) => {
      const value = String(candidate || "").trim();
      const upper = value.toUpperCase();
      if (upper.includes("/FTSCY/")) return null;
      const segments = upper.split("/").filter(Boolean);
      const hasLetter = segments.some((segment) => /[A-Z]/.test(segment));
      const looksLikeDate = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(upper);
      if (!hasLetter || looksLikeDate) return null;

      let score = segments.length * 10;
      if (/\/(?:\d{2}|\d{4})$/.test(upper)) score += 35;
      if (/(^|\/)(I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)(\/|$)/.test(upper)) score += 20;
      if (upper.includes("/PMI/")) score += 20;
      if (upper.includes("/KWT/")) score += 15;
      if (upper.includes("/JKT/")) score += 5;

      return { value: upper, score, length: upper.length };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.length - a.length);

  return scored[0]?.value || "";
}

function extractNameFromRow(rowValues) {
  const source = Array.isArray(rowValues)
    ? rowValues.map((value) => String(value || "")).join(" ")
    : String(rowValues || "");
  const normalized = source
    .replace(/\u00A0/g, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const withoutCodes = normalized
    .replace(/\b\d{1,6}(?:\/[A-Za-z0-9-]{1,24}){2,10}\b/gi, " ")
    .replace(/\b(?:RP|IDR)\b/gi, " ")
    .replace(/\b\d+(?:[.,]\d+)*\b/g, " ")
    .replace(/[-–—]/g, " ")
    .replace(/[^\p{L}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!withoutCodes) return "";

  const stopwords = new Set([
    "TAHAP",
    "PAYMENT",
    "DIRECT",
    "CREDIT",
    "PAYROLL",
    "TRANSFER",
    "TRF",
    "SETORAN",
    "SETOR",
    "TUNAI",
    "CASH",
    "DEPOSIT",
    "BUNGA",
    "PAJAK",
    "BIAYA",
    "CHARGE",
    "FEE",
    "REFUND",
    "FROM",
    "TO",
    "DARI",
    "KE",
    "PEMBAYARAN",
    "TAGIHAN",
    "NOTES",
    "NOTE",
    "KETERANGAN",
    "DESCRIPTION",
  ]);

  const words = withoutCodes.split(/\s+/).filter(Boolean);
  const runs = [];
  let current = [];

  function flushRun() {
    if (current.length >= 2) {
      runs.push(current.join(" "));
    }
    current = [];
  }

  for (const rawWord of words) {
    const word = String(rawWord || "").trim();
    const upper = word.toUpperCase();
    const isAlphaWord = /^[\p{L}][\p{L}'.-]*$/u.test(word);
    const isStopword = stopwords.has(upper);

    if (!isAlphaWord || isStopword) {
      flushRun();
      continue;
    }

    current.push(word);
  }
  flushRun();

  if (runs.length === 0) return "";
  const best = runs
    .map((run, index) => ({ run, index, words: run.split(/\s+/).length }))
    .sort((a, b) => b.words - a.words || b.index - a.index)[0];

  return String(best.run || "").toUpperCase();
}

function formatRupiahAmount(valueText) {
  const normalized = normalizeIncomeValueText(valueText);
  if (!normalized) return "";
  return /^rp\b/i.test(normalized) ? normalized : `Rp ${normalized}`;
}

export function filterIncomeOnlyCsv(csvContent) {
  const rows = parseCsvRows(csvContent);
  const outputHeader = ["day", "month", "code", "date", "no_invoice", "name", "amount"];
  if (rows.length <= 1) return serializeCsvRows([outputHeader]);

  const header = rows[0];
  const normalizedHeaders = header.map(normalizeToken);

  const dateIndex = findExactHeaderIndex(normalizedHeaders, [
    "date",
    "tanggal",
    "transaction date",
    "tgl",
  ]);
  const statusIndex = findExactHeaderIndex(normalizedHeaders, ["status", "type", "tipe", "jenis"]);
  const kategoriIndex = findExactHeaderIndex(normalizedHeaders, ["kategori", "category"]);
  const descriptionIndex = findExactHeaderIndex(normalizedHeaders, [
    "description",
    "keterangan",
    "deskripsi",
    "desc",
    "details",
    "detail",
    "notes",
    "note",
  ]);
  const valueIndex = findExactHeaderIndex(normalizedHeaders, ["value", "amount", "jumlah", "nominal"]);
  const creditIndex = findHeaderByIncludes(normalizedHeaders, ["credit", "kredit"]);
  const debitIndex = findHeaderByIncludes(normalizedHeaders, ["debit", "debet"]);

  const filteredRows = rows.slice(1).reduce((acc, row) => {
    if (isRowEmpty(row)) return acc;

    const statusValue = statusIndex >= 0 ? row[statusIndex] : "";
    const valueAmount = valueIndex >= 0 ? Math.abs(parseAmount(row[valueIndex])) : 0;
    const creditAmount = creditIndex >= 0 ? parseAmount(row[creditIndex]) : 0;
    const debitAmount = debitIndex >= 0 ? parseAmount(row[debitIndex]) : 0;
    let isIncome = false;

    if (statusValue) {
      if (hasExpenseStatus(statusValue)) return acc;
      if (hasIncomeStatus(statusValue)) {
        isIncome = creditIndex >= 0 ? creditAmount > 0 : valueAmount > 0;
      }
    }

    if (!isIncome && creditIndex >= 0 && creditAmount > 0) {
      if (debitIndex >= 0 && Math.abs(debitAmount) > 0) return acc;
      isIncome = true;
    }

    if (!isIncome) return acc;

    const kategori = kategoriIndex >= 0 ? String(row[kategoriIndex] || "").trim() : "";
    const description = descriptionIndex >= 0 ? String(row[descriptionIndex] || "").trim() : "";
    const originalDate = dateIndex >= 0 ? String(row[dateIndex] || "").trim() : "";

    if (isSetoranTunaiRow(kategori, description)) return acc;

    const rawValue =
      creditIndex >= 0 && creditAmount > 0
        ? row[creditIndex]
        : valueIndex >= 0
          ? row[valueIndex]
          : "";
    const amount = formatRupiahAmount(rawValue);
    const dateParts = parseDayMonthParts(originalDate);
    const day = dateParts?.day ? String(dateParts.day) : "";
    const monthName = dateParts?.monthName || "";
    const code = buildReferenceCode(dateParts);
    const fullDate = formatDateDdMmYy(dateParts);
    const invoice = extractInvoiceNumberFromRow(row);
    const name = extractNameFromRow(row);

    if (!day && !monthName && !code && !fullDate && !invoice && !name && !amount) return acc;

    acc.push([day, monthName, code, fullDate, invoice, name, amount]);
    return acc;
  }, []);

  return serializeCsvRows([outputHeader, ...filteredRows]);
}

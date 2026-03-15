import { PdfReader } from "pdfreader";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import TesseractPkg from "tesseract.js";

const { createWorker } = TesseractPkg;

const MONTH_MAP = {
  jan: "01",
  jar: "01",
  january: "01",
  januari: "01",
  feb: "02",
  february: "02",
  februari: "02",
  mar: "03",
  maret: "03",
  apr: "04",
  april: "04",
  may: "05",
  mei: "05",
  jun: "06",
  juni: "06",
  jul: "07",
  juli: "07",
  aug: "08",
  agu: "08",
  agustus: "08",
  sep: "09",
  september: "09",
  oct: "10",
  okt: "10",
  oktober: "10",
  nov: "11",
  november: "11",
  dec: "12",
  des: "12",
  desember: "12",
};

const CATEGORY_KEYWORDS = [
  "Transfer ke",
  "Transfer dari",
  "CC Merchant Paymt",
  "Pajak rekening",
  "Bunga rekening",
  "Biaya",
  "Tarik Tunai",
  "Setor Tunai",
  "QRIS",
  "Top Up",
  "Pembayaran",
  "Overbooking",
];

export function convertMandiriPdfToCsv(pdfPath, fileName, callback) {
  let csvContent = "date,kategori,description,notes,status,value,debit,credit,saldo\n";
  let totalRowsAdded = 0;
  let lastSaldoParsed = null;

  const pages = [];
  let currentPage = 0;
  let currentItems = [];

  const pdfReader = new PdfReader();

  pdfReader.parseFileItems(pdfPath, (error, item) => {
    if (error) {
      console.error("Error parsing PDF:", error);
      callback(error);
      return;
    }

    if (!item) {
      if (currentItems.length > 0) {
        pages.push({ page: currentPage, items: currentItems });
      }

      (async () => {
        try {
          for (const page of pages) {
            processPage(page.page, page.items);
          }
          if (totalRowsAdded === 0) {
            console.log("[MANDIRI] Primary parser found 0 rows, running fallback parser...");
            for (const page of pages) {
              processPageFallback(page.page, page.items);
            }
          }

          if (totalRowsAdded === 0) {
            const ocrRows = await parseTransactionsViaOcr(pdfPath);
            if (ocrRows.length > 0) {
              console.log(`[MANDIRI] OCR fallback rows=${ocrRows.length}`);
              for (const row of ocrRows) {
                addRowToCsv(row);
              }
            }
          }

          callback(null, csvContent);
        } catch (err) {
          callback(err);
        }
      })();
      return;
    }

    if (item.page) {
      if (currentItems.length > 0) {
        pages.push({ page: currentPage, items: currentItems });
      }
      currentPage = item.page;
      currentItems = [];
      return;
    }

    if (item.text) {
      currentItems.push(item);
    }
  });

  function processPage(pageNo, items) {
    const dateStarts = extractDateStarts(items);
    if (dateStarts.length === 0) {
      console.log(`[MANDIRI] Skip page ${pageNo}: no transaction dates detected`);
      return;
    }

    const layout = detectLayout(items, dateStarts);
    if (!layout) {
      console.log(`[MANDIRI] Skip page ${pageNo}: layout not detected`);
      return;
    }

    console.log(
      `[MANDIRI] Page ${pageNo}: rows=${dateStarts.length}, dateX=${layout.dateX.toFixed(2)}, ` +
      `timeX=${layout.timeX.toFixed(2)}, descX=[${layout.descriptionMinX.toFixed(2)}..${layout.descriptionMaxX.toFixed(2)}], ` +
      `debitX=${fmt(layout.debitX)}, creditX=${fmt(layout.creditX)}, amountX=${fmt(layout.amountX)}, saldoX=${fmt(layout.saldoX)}`
    );

    const relevantItems = items
      .filter((it) => it.y >= layout.yMin && it.y <= layout.yMax)
      .sort((a, b) => a.y - b.y || a.x - b.x);

    for (let i = 0; i < dateStarts.length; i += 1) {
      const start = dateStarts[i];
      const next = dateStarts[i + 1];

      const rowTop = start.y - 0.25;
      const rowBottom = next ? next.y - 0.25 : start.y + 5.0;
      const rowItems = relevantItems.filter((it) => it.y >= rowTop && it.y < rowBottom);

      const row = { date: start.date };
      const descriptionParts = [];
      const valueLineY = start.y;

      for (const it of rowItems) {
        const text = String(it.text || "").trim();
        if (!text) continue;

        if (isDateComponent(text)) continue;

        const isValueLine = Math.abs(it.y - valueLineY) <= 0.45;

        if (near(it.x, layout.timeX, 1.1) && isTimeText(text)) {
          row.notes = text;
        } else if (it.x > layout.descriptionMinX && it.x < layout.descriptionMaxX) {
          descriptionParts.push(text);

          const upper = text.toUpperCase();
          if (upper === "DB" || upper === "DR") row.explicitStatus = "DEBIT";
          if (upper === "CR" || upper === "KR") row.explicitStatus = "CREDIT";
        } else if (isValueLine && layout.saldoX !== null && near(it.x, layout.saldoX, 1.25) && isAmountText(text)) {
          row.saldoText = text;
        } else if (isValueLine && layout.debitX !== null && near(it.x, layout.debitX, 1.15) && isAmountText(text)) {
          const amt = Math.abs(parseNumber(text));
          if (amt > 0) {
            row.debitAmount = amt;
            row.valueText = text;
          }
        } else if (isValueLine && layout.creditX !== null && near(it.x, layout.creditX, 1.15) && isAmountText(text)) {
          const amt = Math.abs(parseNumber(text));
          if (amt > 0) {
            row.creditAmount = amt;
            row.valueText = text;
          }
        } else if (isValueLine && layout.amountX !== null && near(it.x, layout.amountX, 1.15) && isAmountText(text)) {
          row.valueText = text;
        }
      }

      row.description = normalizeDescription(descriptionParts.join(" "));
      addRowToCsv(row);
    }
  }

  function processPageFallback(pageNo, items) {
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const dateStarts = extractDateStarts(items);
    console.log(`[MANDIRI] Fallback page ${pageNo}: starts=${dateStarts.length}`);

    // Prefer block parsing between transaction date anchors.
    if (dateStarts.length > 0) {
      for (let i = 0; i < dateStarts.length; i += 1) {
        const start = dateStarts[i];
        const next = dateStarts[i + 1];
        const top = start.y - 0.2;
        const bottom = next ? next.y - 0.2 : start.y + 5.8;
        const block = sorted.filter((it) => it.y >= top && it.y < bottom);
        addFallbackBlock(block, start.date);
      }
      return;
    }

    // Last-resort line parser when no date anchors were found.
    const lines = groupLines(sorted, 0.24);
    for (const line of lines) {
      const joined = line.items.map((it) => String(it.text || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      if (!joined) continue;
      const extractedDate = extractDateFromText(joined);
      if (!extractedDate) continue;
      addFallbackBlock(line.items, extractedDate.normalized);
    }
  }

  function addFallbackBlock(items, normalizedDate) {
    if (!items || items.length === 0) return;

    const textItems = items
      .map((it) => ({ x: it.x, text: String(it.text || "").trim() }))
      .filter((it) => it.text);
    if (textItems.length === 0) return;

    const joined = textItems.map((it) => it.text).join(" ").replace(/\s+/g, " ").trim();
    const lower = joined.toLowerCase();
    if (
      lower.includes("saldo awal") ||
      lower.includes("saldo akhir") ||
      lower.includes("opening balance") ||
      lower.includes("ending balance")
    ) {
      return;
    }

    let amountItems = textItems.filter((it) => isAmountText(it.text));
    if (amountItems.length === 0) {
      const inlineAmountTokens = extractAmountTokensFromText(joined);
      amountItems = inlineAmountTokens.map((text, idx) => ({ x: idx + 1, text }));
    }
    if (amountItems.length === 0) return;

    const parsedAmounts = amountItems.map((it) => ({
      ...it,
      value: parseNumber(it.text),
    }));

    // Use right-most amount as balance when available.
    const saldoItem = [...parsedAmounts].sort((a, b) => a.x - b.x)[parsedAmounts.length - 1];
    const txnCandidates = parsedAmounts.filter((it) => it !== saldoItem);
    const txnCandidate =
      txnCandidates.find((it) => Math.abs(it.value) > 0.0001) ||
      parsedAmounts.find((it) => Math.abs(it.value) > 0.0001);
    if (!txnCandidate) return;

    const timeMatch = joined.match(/\b\d{2}:\d{2}(?::\d{2})?\b/);
    const notes = timeMatch ? timeMatch[0] : "";

    let description = joined;
    if (normalizedDate) description = description.replace(new RegExp(normalizedDate.replace("/", "[/-]"), "i"), "");
    description = description
      .replace(/\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/g, "")
      .replace(/\b\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{2,4})?\b/gi, "");
    if (notes) description = description.replace(notes, "");
    for (const amountItem of amountItems) {
      description = description.replace(amountItem.text, "");
    }
    description = normalizeDescription(description);
    if (!description) description = "Transaction";

    let explicitStatus = "";
    const upper = joined.toUpperCase();
    if (upper.includes(" DB ") || upper.includes(" DR ")) explicitStatus = "DEBIT";
    else if (upper.includes(" CR ") || upper.includes(" KR ")) explicitStatus = "CREDIT";
    else if (
      /DEBIT|TARIK|BIAYA|PAJAK|CHARGE|TRANSFER KE|TRF TO|WITHDRAW|PURCHASE/i.test(joined)
    ) {
      explicitStatus = "DEBIT";
    } else if (
      /KREDIT|BUNGA|TRANSFER DARI|TRF FROM|PAYROLL|TOP UP|REFUND|INTEREST/i.test(joined)
    ) {
      explicitStatus = "CREDIT";
    }

    const row = {
      date: normalizedDate || "",
      description,
      notes,
      saldoText: saldoItem ? saldoItem.text : "",
      valueText: txnCandidate.text,
      explicitStatus: explicitStatus || undefined,
    };

    if (explicitStatus === "DEBIT") {
      row.debitAmount = Math.abs(txnCandidate.value);
    } else if (explicitStatus === "CREDIT") {
      row.creditAmount = Math.abs(txnCandidate.value);
    } else if (txnCandidate.value < 0) {
      row.debitAmount = Math.abs(txnCandidate.value);
    } else {
      row.creditAmount = Math.abs(txnCandidate.value);
    }

    addRowToCsv(row);
  }

  function detectLayout(items, dateStarts) {
    if (!items.length || !dateStarts.length) return null;

    const dateX = median(dateStarts.map((d) => d.x));
    const dateYs = dateStarts.map((d) => d.y);

    const yMin = Math.max(0, Math.min(...dateYs) - 0.5);
    const yMax = Math.max(...dateYs) + 5.3;

    const bodyItems = items.filter((it) => it.y >= yMin && it.y <= yMax);
    const timeItems = bodyItems.filter((it) => isTimeText(it.text));
    const amountItems = bodyItems.filter((it) => isAmountText(it.text));

    const timeX = timeItems.length > 0 ? median(timeItems.map((it) => it.x)) : dateX + 0.8;
    const amountClusters = clusterByX(amountItems.map((it) => it.x), 0.7);

    let debitX = null;
    let creditX = null;
    let amountX = null;
    let saldoX = null;

    if (amountClusters.length > 0) {
      const maxX = amountClusters[amountClusters.length - 1].center;
      const saldoBand = amountClusters.filter((cluster) => cluster.center >= maxX - 1.3);
      saldoX = weightedCenter(saldoBand);

      const txnCandidates = amountClusters.filter((cluster) => cluster.center < saldoX - 1.6);

      if (txnCandidates.length >= 2) {
        const topTwo = [...txnCandidates]
          .sort((a, b) => b.count - a.count)
          .slice(0, 2)
          .sort((a, b) => a.center - b.center);

        debitX = topTwo[0].center;
        creditX = topTwo[1].center;
      } else if (txnCandidates.length === 1) {
        amountX = txnCandidates[0].center;
      } else {
        amountX = saldoX - 6.0;
      }
    } else {
      amountX = dateX + 20;
      saldoX = dateX + 30;
    }

    const firstAmountX = amountClusters.length > 0 ? amountClusters[0].center : (amountX || saldoX);
    const descriptionMinX = Math.max(dateX + 3.5, timeX + 1.4, 5.0);
    const descriptionMaxX = Math.max(descriptionMinX + 4.0, firstAmountX - 0.9);

    return {
      dateX,
      timeX,
      descriptionMinX,
      descriptionMaxX,
      debitX,
      creditX,
      amountX,
      saldoX,
      yMin,
      yMax,
    };
  }

  function extractDateStarts(items) {
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const starts = [];

    const dayTokens = sorted.filter((it) => isDayToken(it.text));
    if (dayTokens.length > 0) {
      for (const day of dayTokens) {
        const sameLine = sorted.filter((it) => Math.abs(it.y - day.y) <= 0.08);
        const month = sameLine.find((it) => isMonthToken(it.text) && it.x > day.x && it.x < day.x + 2.4);
        const year = sameLine.find((it) => isYearToken(it.text) && it.x > day.x && it.x < day.x + 4.2);

        if (month && year) {
          const normalized = normalizeDate(
            `${String(day.text).trim()} ${String(month.text).trim()} ${String(year.text).trim()}`
          );
          starts.push({ x: day.x, y: day.y, date: normalized });
        } else if (month) {
          const normalized = normalizeDate(`${String(day.text).trim()} ${String(month.text).trim()}`);
          starts.push({ x: day.x, y: day.y, date: normalized });
        }
      }
    }

    for (const it of sorted) {
      const text = String(it.text || "").trim();
      if (!text) continue;
      const extractedDate = extractDateFromText(text);
      if (!extractedDate) continue;
      starts.push({ x: it.x, y: it.y, date: extractedDate.normalized });
    }

    const deduped = dedupeStarts(starts);
    return filterToDominantDateColumn(deduped);
  }

  function dedupeStarts(starts) {
    if (starts.length === 0) return [];
    const sorted = [...starts].sort((a, b) => a.y - b.y || a.x - b.x);
    const result = [sorted[0]];

    for (let i = 1; i < sorted.length; i += 1) {
      const cur = sorted[i];
      const prev = result[result.length - 1];
      if (Math.abs(cur.y - prev.y) <= 0.12) continue;
      result.push(cur);
    }

    return result;
  }

  function filterToDominantDateColumn(starts) {
    if (starts.length <= 2) return starts;
    const xClusters = clusterByX(starts.map((it) => it.x), 1.2);
    if (xClusters.length === 0) return starts;

    const dominant = [...xClusters].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.center - b.center;
    })[0];

    return starts.filter((it) => Math.abs(it.x - dominant.center) <= 1.4);
  }

  function addRowToCsv(row) {
    if (!row || !row.date) return;
    if (!row.description && !row.valueText && !row.debitAmount && !row.creditAmount) return;
    if (looksLikeHeader(row.description || "")) return;

    const debitAmount = Number.isFinite(row.debitAmount) ? row.debitAmount : null;
    const creditAmount = Number.isFinite(row.creditAmount) ? row.creditAmount : null;
    const saldoParsed = row.saldoText && isAmountText(row.saldoText) ? parseNumber(row.saldoText) : null;
    const parsedValue = row.valueText ? parseNumber(row.valueText) : 0;
    const hasParsedValue = Number.isFinite(parsedValue) && Math.abs(parsedValue) > 0.0001;
    const signStatus = inferStatusFromExplicitSign(row.valueText);
    const explicitStatus =
      row.explicitStatus === "DEBIT" || row.explicitStatus === "CREDIT"
        ? row.explicitStatus
        : "";

    let status = "";
    let value = 0;

    if (hasParsedValue) {
      value = Math.abs(parsedValue);
    } else if (debitAmount !== null && debitAmount > 0) {
      value = debitAmount;
    } else if (creditAmount !== null && creditAmount > 0) {
      value = creditAmount;
    }

    if (signStatus) {
      // Explicit +/- sign on value is the highest-priority source of truth.
      status = signStatus;
    } else if (explicitStatus) {
      status = explicitStatus;
    } else if (debitAmount !== null && debitAmount > 0 && !(creditAmount !== null && creditAmount > 0)) {
      status = "DEBIT";
    } else if (creditAmount !== null && creditAmount > 0 && !(debitAmount !== null && debitAmount > 0)) {
      status = "CREDIT";
    }

    // If sign/explicit markers are absent, prefer saldo movement over debit/credit column guesses.
    if (!signStatus && !explicitStatus && saldoParsed !== null && lastSaldoParsed !== null) {
      const delta = saldoParsed - lastSaldoParsed;
      if (Math.abs(delta) > 0.0001) {
        status = delta < 0 ? "DEBIT" : "CREDIT";
        const deltaAbs = Math.abs(delta);
        if (!(value > 0) || Math.abs(deltaAbs - value) / Math.max(value, 1) > 0.4) {
          value = deltaAbs;
        }
      }
    }

    if (!status && hasParsedValue) {
      status = parsedValue < 0 ? "DEBIT" : "CREDIT";
    }
    if (!status && value > 0) {
      status = inferStatusFromDescription(row.description || "", row.notes || "", explicitStatus);
    }

    if (!status || value <= 0) return;

    const formattedValue = formatRupiah(value);
    const debit = status === "DEBIT" ? formattedValue : "0";
    const credit = status === "CREDIT" ? formattedValue : "0";
    const saldo = saldoParsed === null ? "" : formatRupiah(Math.abs(saldoParsed));

    const kategori = detectKategori(row.description || "");

    const csvRow = [
      quoteIfNeeded(row.date || ""),
      quoteIfNeeded(kategori),
      quoteIfNeeded(row.description || ""),
      quoteIfNeeded(row.notes || ""),
      quoteIfNeeded(status),
      quoteIfNeeded(formattedValue),
      quoteIfNeeded(debit),
      quoteIfNeeded(credit),
      quoteIfNeeded(saldo),
    ].join(",");

    csvContent += csvRow + "\n";
    totalRowsAdded += 1;
    if (saldoParsed !== null) {
      lastSaldoParsed = saldoParsed;
    }
  }

  function parseNumber(numStr) {
    if (!numStr) return 0;
    const normalized = normalizeAmountToken(numStr);
    if (!normalized.text) return 0;
    let s = normalized.text;

    let sign = normalized.sign;
    if (s.startsWith("-")) {
      sign = -1;
      s = s.slice(1);
    } else if (s.startsWith("+")) {
      s = s.slice(1);
    }

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
    if (Number.isNaN(parsed)) return 0;
    return sign * parsed;
  }

  function isAmountText(text = "") {
    const normalized = normalizeAmountToken(text);
    const t = normalized.text;
    if (!t) return false;
    return (
      /^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})$/.test(t) ||
      /^\d+(?:[.,]\d{2})$/.test(t) ||
      /^\d{1,3}(?:[.,]\d{3})+$/.test(t)
    );
  }

  function isTimeText(text = "") {
    return /^\d{2}:\d{2}(?::\d{2})?$/.test(String(text).trim());
  }

  function isDateText(text = "") {
    const t = String(text).trim();
    return (
      /^\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?$/.test(t) ||
      /^\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{2,4})?$/.test(t)
    );
  }

  function isDayToken(text = "") {
    return /^\d{1,2}$/.test(String(text).trim());
  }

  function isMonthToken(text = "") {
    return Object.prototype.hasOwnProperty.call(MONTH_MAP, String(text).trim().slice(0, 3).toLowerCase());
  }

  function isYearToken(text = "") {
    return /^\d{4}$/.test(String(text).trim());
  }

  function isDateComponent(text = "") {
    return isDayToken(text) || isMonthToken(text) || isYearToken(text);
  }

  function normalizeDate(text = "") {
    const t = String(text).trim();

    if (/^\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?$/.test(t)) {
      const [d, m] = t.split(/[\/.-]/);
      const dd = Number.parseInt(d, 10);
      const mmNum = Number.parseInt(m, 10);
      if (!Number.isFinite(dd) || !Number.isFinite(mmNum)) return "";
      if (dd < 1 || dd > 31 || mmNum < 1 || mmNum > 12) return "";
      return `${String(dd).padStart(2, "0")}/${String(mmNum).padStart(2, "0")}`;
    }

    const parts = t.split(/\s+/);
    if (parts.length >= 2) {
      const dayNum = Number.parseInt(parts[0], 10);
      const monKey = parts[1].slice(0, 3).toLowerCase();
      const mm = MONTH_MAP[monKey];
      if (Number.isFinite(dayNum) && dayNum >= 1 && dayNum <= 31 && mm) {
        return `${String(dayNum).padStart(2, "0")}/${mm}`;
      }
    }

    return "";
  }

  function normalizeDescription(value = "") {
    return String(value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function detectKategori(description = "") {
    const desc = String(description || "");
    const upper = desc.toUpperCase();

    for (const keyword of CATEGORY_KEYWORDS) {
      if (upper.includes(keyword.toUpperCase())) return keyword;
    }
    return "";
  }

  function inferStatusFromDescription(description = "", notes = "", explicitStatus = "") {
    if (explicitStatus === "DEBIT" || explicitStatus === "CREDIT") return explicitStatus;
    const combined = `${description} ${notes}`.toUpperCase();
    if (/\bDB\b|\bDR\b|DEBIT|TARIK|BIAYA|PAJAK|CHARGE|TRANSFER KE|TRF TO|WITHDRAW|PURCHASE/.test(combined)) {
      return "DEBIT";
    }
    if (/\bCR\b|\bKR\b|KREDIT|BUNGA|TRANSFER DARI|TRF FROM|PAYROLL|TOP UP|REFUND|INTEREST/.test(combined)) {
      return "CREDIT";
    }
    return "";
  }

  function inferStatusFromExplicitSign(valueText = "") {
    const compact = String(valueText || "").replace(/\s+/g, "");
    if (!compact) return "";

    if (/^\(.*\)$/.test(compact)) return "DEBIT";
    if (compact.startsWith("-") || compact.endsWith("-") || compact.startsWith("~")) return "DEBIT";
    if (compact.startsWith("+") || compact.endsWith("+")) return "CREDIT";

    return "";
  }

  function extractDateFromText(text = "") {
    const raw = String(text).trim();
    if (!raw) return null;

    const datePatterns = [
      /\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/,
      /\b\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{2,4})?\b/i,
    ];

    for (const pattern of datePatterns) {
      const match = raw.match(pattern);
      if (!match) continue;
      return {
        raw: match[0],
        normalized: normalizeDate(match[0]),
      };
    }

    if (isDateText(raw)) {
      return {
        raw,
        normalized: normalizeDate(raw),
      };
    }

    return null;
  }

  function normalizeAmountToken(text = "") {
    let s = String(text).trim();
    if (!s) return { text: "", sign: 1 };

    s = s.replace(/\s+/g, "");
    s = s.replace(/^(IDR|RP\.?)/i, "");

    let sign = 1;
    if (/^\(.*\)$/.test(s)) {
      sign = -1;
      s = s.slice(1, -1);
    }
    if (s.endsWith("-")) {
      sign = -1;
      s = s.slice(0, -1);
    }
    if (s.endsWith("+")) {
      s = s.slice(0, -1);
    }

    s = s.replace(/(CR|DB|DR|KR)$/i, "");

    if (s.startsWith("-")) {
      sign = -1;
      s = s.slice(1);
    } else if (s.startsWith("+")) {
      s = s.slice(1);
    }

    return { text: s, sign };
  }

  function extractAmountTokensFromText(text = "") {
    const matches = String(text).match(/(?:IDR|RP\.?)?\s*\(?[+-]?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\)?(?:\s?(?:CR|DB|DR|KR))?[+-]?/gi) || [];
    return matches
      .map((it) => String(it).trim())
      .filter(Boolean)
      .filter((it) => isAmountText(it));
  }

  function looksLikeHeader(description = "") {
    const upper = String(description).toUpperCase();
    return (
      upper.includes("TANGGAL") ||
      upper.includes("DATE") ||
      upper.includes("KETERANGAN") ||
      upper.includes("DESCRIPTION") ||
      upper.includes("DEBET") ||
      upper.includes("KREDIT") ||
      upper.includes("SALDO")
    );
  }

  function clusterByX(values, tolerance = 0.7) {
    if (!values.length) return [];

    const sorted = [...values].sort((a, b) => a - b);
    const clusters = [{ values: [sorted[0]] }];

    for (let i = 1; i < sorted.length; i += 1) {
      const x = sorted[i];
      const cluster = clusters[clusters.length - 1];
      const center = cluster.values.reduce((sum, v) => sum + v, 0) / cluster.values.length;

      if (Math.abs(x - center) <= tolerance) {
        cluster.values.push(x);
      } else {
        clusters.push({ values: [x] });
      }
    }

    return clusters
      .map((cluster) => ({
        center: cluster.values.reduce((sum, v) => sum + v, 0) / cluster.values.length,
        count: cluster.values.length,
      }))
      .sort((a, b) => a.center - b.center);
  }

  function weightedCenter(clusters) {
    if (!clusters.length) return 0;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const cluster of clusters) {
      const weight = Math.max(1, cluster.count || 1);
      weightedSum += cluster.center * weight;
      totalWeight += weight;
    }

    return totalWeight === 0 ? clusters[clusters.length - 1].center : weightedSum / totalWeight;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  function near(value, target, tolerance) {
    return Math.abs(value - target) <= tolerance;
  }

  function formatRupiah(value) {
    if (!Number.isFinite(value)) return "";
    return value.toLocaleString("id-ID", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function quoteIfNeeded(value = "") {
    const s = String(value);
    return s.includes(",") ? `"${s}"` : s;
  }

  function fmt(value) {
    return value === null ? "-" : value.toFixed(2);
  }

  function groupLines(items, tolerance = 0.22) {
    const lines = [];
    for (const item of items) {
      const text = String(item.text || "").trim();
      if (!text) continue;

      const existing = lines.find((line) => Math.abs(line.y - item.y) <= tolerance);
      if (existing) {
        existing.items.push(item);
      } else {
        lines.push({ y: item.y, items: [item] });
      }
    }

    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);
    }

    lines.sort((a, b) => a.y - b.y);
    return lines;
  }

  async function parseTransactionsViaOcr(inputPdfPath) {
    if (!isCommandAvailable("qpdf") || !isCommandAvailable("sips")) {
      console.log("[MANDIRI] OCR fallback unavailable: requires qpdf + sips");
      return [];
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandiri-ocr-"));
    const worker = await createWorker("eng+ind");
    const rows = [];
    let currentDate = "";

    try {
      await worker.setParameters({ tessedit_pageseg_mode: "6" });
      const pageCount = getPdfPageCount(inputPdfPath);

      for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
        const pagePdfPath = path.join(tempRoot, `page-${pageNo}.pdf`);
        const pagePngPath = path.join(tempRoot, `page-${pageNo}.png`);
        renderPdfPageToPng(inputPdfPath, pageNo, pagePdfPath, pagePngPath);

        const ocrResult = await worker.recognize(pagePngPath);
        const parsed = parseOcrTextToRows(ocrResult?.data?.text || "", currentDate);
        currentDate = parsed.currentDate || currentDate;
        rows.push(...parsed.rows);
      }
    } catch (err) {
      console.error("[MANDIRI] OCR fallback failed:", err?.message || err);
      return [];
    } finally {
      try {
        await worker.terminate();
      } catch {
        // Ignore worker shutdown errors.
      }
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // Ignore temp cleanup errors.
      }
    }

    return rows;
  }

  function isCommandAvailable(command) {
    try {
      execFileSync("which", [command], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  function getPdfPageCount(inputPdfPath) {
    try {
      const output = execFileSync("qpdf", ["--show-npages", inputPdfPath], {
        encoding: "utf8",
      }).trim();
      const parsed = Number.parseInt(output, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    } catch {
      return 1;
    }
  }

  function renderPdfPageToPng(inputPdfPath, pageNumber, pagePdfPath, pagePngPath) {
    execFileSync("qpdf", [
      "--empty",
      "--pages",
      inputPdfPath,
      String(pageNumber),
      "--",
      pagePdfPath,
    ]);

    execFileSync("sips", ["-s", "format", "png", pagePdfPath, "--out", pagePngPath], {
      stdio: "ignore",
    });

    execFileSync(
      "sips",
      ["--resampleHeightWidth", "4000", "2800", pagePngPath, "--out", pagePngPath],
      { stdio: "ignore" }
    );
  }

  function parseOcrTextToRows(rawText, startingDate) {
    const lines = String(rawText || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const rows = [];
    let currentDate = startingDate || "";
    let pendingContext = "";
    let currentBlock = null;

    for (const line of lines) {
      if (looksLikeOcrNoise(line)) continue;
      const transactionStart = isLikelyOcrTransactionStart(line);

      const extractedDate = extractDateFromText(line);
      if (extractedDate?.normalized) {
        if (currentBlock && !transactionStart) {
          const flushedRow = parseOcrBlockToRow(currentBlock);
          if (flushedRow) rows.push(flushedRow);
          currentBlock = null;
        }
        currentDate = extractedDate.normalized;
        const trailing = extractTrailingOcrContext(line, extractedDate.raw);
        if (isMeaningfulOcrContext(trailing) && isOcrTransactionContext(trailing)) {
          pendingContext = mergeOcrContext(pendingContext, trailing);
        }
      }

      if (transactionStart) {
        const flushedRow = parseOcrBlockToRow(currentBlock);
        if (flushedRow) rows.push(flushedRow);

        currentBlock = {
          date: currentDate,
          context: pendingContext,
          lines: [line],
        };
        pendingContext = "";
        continue;
      }

      if (currentBlock) {
        if (looksLikeOcrFooter(line)) {
          const flushedRow = parseOcrBlockToRow(currentBlock);
          if (flushedRow) rows.push(flushedRow);
          currentBlock = null;
          continue;
        }

        if (currentBlock.lines.length < 3 && isUsefulOcrContinuation(line)) {
          currentBlock.lines.push(line);
        }
        continue;
      }

      if (isMeaningfulOcrContext(line) && isOcrTransactionContext(line)) {
        pendingContext = mergeOcrContext(pendingContext, line);
      }
    }

    const lastRow = parseOcrBlockToRow(currentBlock);
    if (lastRow) rows.push(lastRow);

    return { rows, currentDate };
  }

  function parseOcrBlockToRow(block) {
    if (!block) return null;
    if (!block.date) return null;
    if (!Array.isArray(block.lines) || block.lines.length === 0) return null;

    const firstLine = block.lines[0];
    const joined = normalizeDescription(block.lines.slice(0, 3).join(" "));
    if (!joined) return null;

    const amountAndSaldo = extractAmountAndSaldoFromOcrLine(firstLine) || extractAmountAndSaldoFromOcrLine(joined);
    if (!amountAndSaldo || !Number.isFinite(amountAndSaldo.amount)) return null;

    const timeMatch = joined.match(/\b\d{1,2}[:.]\d{2}(?::\d{2})?\b/);
    const notes = timeMatch ? String(timeMatch[0]).replace(/\./g, ":") : "";

    let description = joined;
    description = description
      .replace(/^\d{1,3}\s+/, "")
      .replace(/\b\d{1,2}\s*[./-]?\s*[A-Za-z]{3,9}(?:\s+\d{2,4})?\b/gi, "");

    if (notes) description = description.replace(timeMatch[0], "");
    if (amountAndSaldo.amountRaw) description = description.replace(amountAndSaldo.amountRaw, "");
    if (amountAndSaldo.saldoRaw) description = description.replace(amountAndSaldo.saldoRaw, "");

    if (block.context) {
      description = normalizeDescription(`${block.context} ${description}`);
    }

    let status = amountAndSaldo.amount < 0 ? "DEBIT" : amountAndSaldo.amount > 0 ? "CREDIT" : "";
    if (!amountAndSaldo.hasSign) {
      status = inferStatusFromDescription(description, notes, status);
    }
    if (!status) return null;

    description = cleanOcrDescription(description, status);
    if (!description) return null;
    if (looksLikeOcrFooter(description)) return null;
    if (!/[A-Za-z]{3,}/.test(description)) return null;

    const amount = Math.abs(amountAndSaldo.amount);
    if (!(amount > 0)) return null;
    if (amount < 100) return null;
    if (!amountAndSaldo.hasSign && !amountAndSaldo.hasSaldo) {
      const descUpper = description.toUpperCase();
      if (
        !descUpper.includes("TRANSFER") &&
        !descUpper.includes("BIAYA") &&
        !descUpper.includes("TOP-UP") &&
        !descUpper.includes("TOP UP") &&
        !descUpper.includes("QRIS") &&
        !descUpper.includes("BUNGA")
      ) {
        return null;
      }
    }

    const row = {
      date: block.date,
      description,
      notes,
      explicitStatus: status,
    };

    if (status === "DEBIT") row.debitAmount = amount;
    else row.creditAmount = amount;

    if (Number.isFinite(amountAndSaldo.saldo)) {
      row.saldoText = formatRupiah(Math.abs(amountAndSaldo.saldo));
    }

    return row;
  }

  function isLikelyOcrTransactionStart(line = "") {
    const amountAndSaldo = extractAmountAndSaldoFromOcrLine(line);
    if (!amountAndSaldo || !Number.isFinite(amountAndSaldo.amount)) return false;

    const hasIndexPrefix = /^\d{1,3}\b/.test(line);
    const hasSignedAmountHint = /[+~\-]\s*\d/.test(line);
    const hasKeyword = /\b(TRANSFER|TRF|BIAYA|TOP[- ]?UP|QRIS|TARIK|SETOR|BUNGA|PEMB)\b/i.test(line);

    return hasIndexPrefix || hasSignedAmountHint || amountAndSaldo.hasSign || hasKeyword;
  }

  function extractTrailingOcrContext(line = "", rawDate = "") {
    let text = String(line || "");
    if (rawDate) {
      text = text.replace(rawDate, " ");
    }
    return normalizeDescription(text.replace(/^[^A-Za-z0-9]+/, ""));
  }

  function isMeaningfulOcrContext(text = "") {
    const s = normalizeDescription(text);
    if (!s) return false;
    if (looksLikeOcrNoise(s) || looksLikeOcrFooter(s)) return false;
    if (!/[A-Za-z]/.test(s)) return false;
    if (s.length < 4) return false;
    return true;
  }

  function mergeOcrContext(existing = "", incoming = "") {
    const a = normalizeDescription(existing);
    const b = normalizeDescription(incoming);
    if (!a) return b;
    if (!b) return a;
    if (a.includes(b)) return a;
    if (b.includes(a)) return b;
    return normalizeDescription(`${a} ${b}`).slice(0, 140);
  }

  function cleanOcrDescription(input = "", status = "") {
    let value = normalizeDescription(input);
    if (!value) return "";

    value = value
      .replace(/^\d{1,3}\s+/, "")
      .replace(/^\d{1,2}[-.:]\d{2}(?::\d{2})?\s*(?:WIB|WIE|WB|WIN)?\s*/gi, "")
      .replace(/\b(?:WIB|WIE|WB|WIN)\b/gi, " ")
      .replace(/\bSANK\b/gi, "BANK")
      .replace(/\bTRAN(?:STAR|ATAR|TAR|SFER)\b/gi, "Transfer")
      .replace(/\bTRF\b/gi, "Transfer")
      .replace(/\bsdministras[iy]?\b/gi, "administrasi")
      .replace(/\bkarly\b/gi, "kartu")
      .replace(/\bMANDIR\b/gi, "MANDIRI")
      .replace(/\bKa\b/gi, "ke")
      .replace(/\bB1\b/gi, "BI")
      .replace(/\|/g, " ");

    value = value
      .replace(/\b\d{1,2}\s*[./-]\s*\d{1,2}(?:\s*[./-]\s*\d{2,4})?\b/g, " ")
      .replace(/\b\d{1,2}[:.]\d{2}(?::\d{2})?\b/g, " ")
      .replace(/[+~*-]?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?/g, " ")
      .replace(/\b\d+\.\d{2}\b/g, " ");

    const noiseTokenSet = new Set([
      "WIB", "WB", "WIE", "WIN", "UL", "AR", "AA", "AN", "ERE", "KO",
      "JAN", "FEB", "MAR", "APR", "MAY", "MEI", "JUN", "JUL", "AUG", "AGU",
      "SEP", "OCT", "OKT", "NOV", "DEC", "DES",
    ]);
    const shortAllowed = new Set(["KE", "DARI", "BI", "FT", "TO", "UP"]);
    const tokens = value
      .split(/\s+/)
      .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
      .filter(Boolean)
      .filter((token) => {
        const upperToken = token.toUpperCase();
        if (noiseTokenSet.has(upperToken)) return false;
        if (/^\d+$/.test(token)) return token.length >= 8;
        if (token.length <= 2 && !shortAllowed.has(upperToken)) return false;
        return true;
      });

    value = tokens.join(" ");

    const keywordMatch = value.match(/\b(BIAYA|TRANSFER|TOP[- ]?UP|BANK|BUNGA|ADMINISTRASI|QRIS|PEMBAYARAN|TARIK|SETOR)\b/i);
    if (keywordMatch && Number.isFinite(keywordMatch.index) && keywordMatch.index > 0 && keywordMatch.index < 15) {
      value = value.slice(keywordMatch.index).trim();
    }

    value = value
      .replace(/\b(?:ere|aa|an)\b$/i, "")
      .replace(/\bBANE\b/gi, "BANK")
      .replace(/\brekaning\b/gi, "rekening")
      .replace(/\ba=-?manay\b/gi, "e-money")
      .replace(/\be-?manay\b/gi, "e-money")
      .replace(/\bW\d{2,4}\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Remove duplicate adjacent tokens after OCR normalization.
    const dedupedTokens = [];
    for (const token of value.split(/\s+/)) {
      if (!token) continue;
      if (dedupedTokens.length > 0 && dedupedTokens[dedupedTokens.length - 1].toUpperCase() === token.toUpperCase()) {
        continue;
      }
      dedupedTokens.push(token);
    }
    value = dedupedTokens.join(" ");
    value = value.replace(
      /\b(Transfer\s+(?:ke|dari)\s+BANK\s+MANDIRI)(?:\s+\1)+/gi,
      "$1"
    );
    if (
      /TRANSFER DARI BANK MANDIRI/i.test(value) &&
      !/^Transfer\s+dari\s+BANK\s+MANDIRI/i.test(value) &&
      !/^Biaya/i.test(value)
    ) {
      value = `Transfer dari BANK MANDIRI ${value.replace(/Transfer\s+dari\s+BANK\s+MANDIRI/gi, "").trim()}`.trim();
    }
    if (
      /TRANSFER KE BANK MANDIRI/i.test(value) &&
      !/^Transfer\s+ke\s+BANK\s+MANDIRI/i.test(value) &&
      !/^Biaya/i.test(value)
    ) {
      value = `Transfer ke BANK MANDIRI ${value.replace(/Transfer\s+ke\s+BANK\s+MANDIRI/gi, "").trim()}`.trim();
    }
    value = value.replace(/\s+Transfer\s+dari\s+BANK\s+MANDIRI$/i, (full) => {
      return /^Biaya/i.test(value) ? "" : full;
    });
    if (/^Fee\s+\d{8,}$/i.test(value)) {
      value = "Fee";
    }

    const upper = value.toUpperCase();
    if (upper.includes("BIAYA") && upper.includes("BI FAST")) {
      return "Biaya transfer BI Fast";
    }
    if (/\bBRI\b/.test(upper) && !upper.includes("TRANSFER")) {
      return status === "DEBIT" ? "Transfer ke BRI" : "Transfer dari BRI";
    }

    if (value.length > 140) {
      value = `${value.slice(0, 140).trim()}...`;
    }

    return value;
  }

  function isUsefulOcrContinuation(line = "") {
    const text = normalizeDescription(line);
    if (!text) return false;
    if (!isMeaningfulOcrContext(text)) return false;
    if (/[+~\-]\s*\d/.test(text)) return false;
    if (isOcrTransactionContext(text)) return true;
    if (/^\d{1,2}[:.]\d{2}(?::\d{2})?/.test(text)) return true;
    return false;
  }

  function isOcrTransactionContext(text = "") {
    return /\b(TRANSFER|TRF|TOP[- ]?UP|BIAYA|BUNGA|BANK|QRIS|TARIK|SETOR|PAJAK|ADMIN)\b/i.test(String(text));
  }

  function looksLikeOcrNoise(line = "") {
    const upper = String(line || "").toUpperCase();
    return (
      upper.includes("NO DATE REMARKS") ||
      upper.includes("NO TANGGAL KETERANGAN") ||
      upper.includes("E-STATEMENT") ||
      upper.includes("TABUNGAN MANDIRI") ||
      upper.includes("ACCOUNT NUMBER") ||
      upper.includes("NOMOR REKENING") ||
      upper.includes("DANA MASUK") ||
      upper.includes("DANA KELUAR") ||
      upper.includes("SALDO AWAL") ||
      upper.includes("SALDO AKHIR") ||
      upper.includes("CLOSING BALANCE") ||
      upper.includes("BUNGA REKENING") ||
      upper.includes("SYARAT DAN KETENTUAN")
    );
  }

  function looksLikeOcrFooter(description = "") {
    const upper = String(description || "").toUpperCase();
    return (
      upper.includes("DOKUMEN ELEKTRONIK") ||
      upper.includes("TANDA TANGAN") ||
      upper.includes("TANGGUNG JAWAB NASABAH") ||
      upper.includes("SYARAT DAN KETENTUAN") ||
      upper.includes("LIVIN") ||
      upper.includes("PENGGUNAAN E-STATEMENT") ||
      upper.includes("FORMS OF USAGE")
    );
  }

  function extractAmountAndSaldoFromOcrLine(line = "") {
    const tokens = String(line || "").split(/\s+/).filter(Boolean);
    const candidates = [];

    for (let i = 0; i < tokens.length; i += 1) {
      let token = tokens[i];
      if (!token || token.includes(":")) continue;
      if (/^\d{4}$/.test(token)) continue;

      let normalized = normalizeOcrAmountToken(token);
      if (normalized.signed && normalized.text.replace(/\D/g, "").length < 4 && i + 1 < tokens.length) {
        const merged = `${token}${tokens[i + 1]}`;
        const mergedNormalized = normalizeOcrAmountToken(merged);
        if (mergedNormalized.text.replace(/\D/g, "").length >= 4) {
          token = merged;
          normalized = mergedNormalized;
          i += 1;
        }
      }

      const digitCount = normalized.text.replace(/\D/g, "").length;
      if (digitCount < 4) continue;

      // Skip long account-number-like tokens unless there is an explicit sign/punctuation.
      if (
        !normalized.signed &&
        !/[.,]/.test(normalized.text) &&
        digitCount > 9
      ) {
        continue;
      }

      const value = parseOcrAmountToken(token);
      if (!Number.isFinite(value)) continue;

      candidates.push({
        index: i,
        raw: token,
        value,
        signed: normalized.signed,
      });
    }

    if (candidates.length === 0) return null;

    let amountCandidate = null;
    const signedCandidates = candidates.filter((it) => it.signed);
    if (signedCandidates.length > 0) {
      amountCandidate = signedCandidates[signedCandidates.length - 1];
    } else if (candidates.length >= 2) {
      amountCandidate = candidates[candidates.length - 2];
    } else {
      amountCandidate = candidates[0];
    }

    let saldoCandidate = null;
    if (candidates.length >= 2) {
      const last = candidates[candidates.length - 1];
      if (last.index !== amountCandidate.index) {
        saldoCandidate = last;
      }
    }

    return {
      amount: amountCandidate.value,
      amountRaw: amountCandidate.raw,
      saldo: saldoCandidate ? saldoCandidate.value : null,
      saldoRaw: saldoCandidate ? saldoCandidate.raw : "",
      hasSign: amountCandidate.signed,
      hasSaldo: Boolean(saldoCandidate),
    };
  }

  function normalizeOcrAmountToken(value = "") {
    let token = String(value || "").trim();
    if (!token) return { text: "", signed: false };

    const signed = /^[+~-]/.test(token);
    token = token.replace(/[()]/g, "");
    token = token.replace(/^(IDR|RP\.?)/i, "");
    token = token.toUpperCase();

    const charMap = {
      O: "0",
      Q: "0",
      D: "0",
      I: "1",
      L: "1",
      "|": "1",
      S: "5",
      B: "8",
      G: "6",
      Z: "2",
      E: "8",
    };

    token = token
      .split("")
      .map((ch) => (charMap[ch] !== undefined ? charMap[ch] : ch))
      .join("");

    token = token.replace(/[^0-9+\-~.,]/g, "");
    return { text: token, signed };
  }

  function parseOcrAmountToken(value = "") {
    const normalized = normalizeOcrAmountToken(value);
    if (!normalized.text) return NaN;

    let sign = 1;
    let token = normalized.text;
    if (/^[~-]/.test(token)) {
      sign = -1;
      token = token.slice(1);
    } else if (token.startsWith("+")) {
      token = token.slice(1);
    }

    const digits = token.replace(/\D/g, "");
    if (digits.length < 3) return NaN;
    return sign * (Number.parseInt(digits, 10) / 100);
  }
}

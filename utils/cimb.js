import { PdfReader } from "pdfreader";

const MONTH_MAP = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

export function convertCimbPdfToCsv(pdfPath, fileName, callback) {
  let csvContent = "date,kategori,description,debit,credit,saldo\n";

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

      try {
        for (const page of pages) {
          processPage(page.page, page.items);
        }
        callback(null, csvContent);
      } catch (err) {
        callback(err);
      }
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
      console.log(`[CIMB] Skip page ${pageNo}: no transaction dates detected`);
      return;
    }

    const layout = detectLayout(items, dateStarts);
    if (!layout) {
      console.log(`[CIMB] Skip page ${pageNo}: layout not detected`);
      return;
    }

    console.log(
      `[CIMB] Page ${pageNo}: rows=${dateStarts.length}, dateX=${layout.dateX.toFixed(2)}, ` +
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
      const rowBottom = next ? next.y - 0.25 : start.y + 4.8;
      const rowItems = relevantItems.filter((it) => it.y >= rowTop && it.y < rowBottom);

      const row = { date: start.date };
      const descriptionParts = [];
      const valueLineY = start.y;

      for (const it of rowItems) {
        const text = String(it.text || "").trim();
        if (!text) continue;

        if (isDateComponent(text)) continue;

        const isValueLine = Math.abs(it.y - valueLineY) <= 0.45;

        if (near(it.x, layout.timeX, 1.0) && isTimeText(text)) {
          row.notes = text;
        } else if (it.x > layout.descriptionMinX && it.x < layout.descriptionMaxX) {
          descriptionParts.push(text);
        } else if (isValueLine && layout.saldoX !== null && near(it.x, layout.saldoX, 1.2) && isAmountText(text)) {
          row.saldoText = text;
        } else if (isValueLine && layout.debitX !== null && near(it.x, layout.debitX, 1.1) && isAmountText(text)) {
          const amt = Math.abs(parseNumber(text));
          if (amt > 0) {
            row.debitAmount = amt;
            row.valueText = text;
          }
        } else if (isValueLine && layout.creditX !== null && near(it.x, layout.creditX, 1.1) && isAmountText(text)) {
          const amt = Math.abs(parseNumber(text));
          if (amt > 0) {
            row.creditAmount = amt;
            row.valueText = text;
          }
        } else if (isValueLine && layout.amountX !== null && near(it.x, layout.amountX, 1.1) && isAmountText(text)) {
          row.valueText = text;
        }
      }

      row.description = normalizeDescription(descriptionParts.join(" "));
      addRowToCsv(row);
    }
  }

  function detectLayout(items, dateStarts) {
    if (!items.length || !dateStarts.length) return null;

    const dateX = median(dateStarts.map((d) => d.x));
    const dateYs = dateStarts.map((d) => d.y);
    const yMin = Math.max(0, Math.min(...dateYs) - 0.4);
    const yMax = Math.max(...dateYs) + 5.2;

    const bodyItems = items.filter((it) => it.y >= yMin && it.y <= yMax);
    const timeItems = bodyItems.filter((it) => isTimeText(it.text));
    const amountItems = bodyItems.filter((it) => isAmountText(it.text));

    const timeX = timeItems.length > 0 ? median(timeItems.map((it) => it.x)) : dateX + 0.6;
    const amountClusters = clusterByX(amountItems.map((it) => it.x), 0.65);

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
      saldoX = dateX + 29;
    }

    const firstAmountX = amountClusters.length > 0 ? amountClusters[0].center : (amountX || saldoX);
    const descriptionMinX = Math.max(dateX + 3.5, timeX + 1.6, 5.0);
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

    const dayTokens = sorted.filter((it) => isDayToken(it.text) && it.x < 5.0);
    if (dayTokens.length > 0) {
      for (const day of dayTokens) {
        const sameLine = sorted.filter((it) => Math.abs(it.y - day.y) <= 0.08);
        const month = sameLine.find((it) => isMonthToken(it.text) && it.x > day.x && it.x < day.x + 2.2);
        const year = sameLine.find((it) => isYearToken(it.text) && it.x > day.x && it.x < day.x + 3.8);

        if (month && year) {
          const normalized = normalizeDate(`${String(day.text).trim()} ${String(month.text).trim()} ${String(year.text).trim()}`);
          starts.push({ x: day.x, y: day.y, date: normalized });
        }
      }
    }

    if (starts.length >= 2) {
      return dedupeStarts(starts);
    }

    // Fallback for statements that keep date as one token.
    for (const it of sorted) {
      const text = String(it.text || "").trim();
      if (!text) continue;
      if (isDateText(text) && it.x < 6.0) {
        starts.push({ x: it.x, y: it.y, date: normalizeDate(text) });
      }
    }

    return dedupeStarts(starts);
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

  function addRowToCsv(row) {
    if (!row || !row.date) return;
    if (!row.description && !row.valueText && !row.debitAmount && !row.creditAmount) return;
    if (looksLikeHeader(row.description || "")) return;

    const debitAmount = Number.isFinite(row.debitAmount) ? row.debitAmount : null;
    const creditAmount = Number.isFinite(row.creditAmount) ? row.creditAmount : null;

    let status = "";
    let value = 0;

    if (debitAmount !== null && debitAmount > 0) {
      status = "DEBIT";
      value = debitAmount;
    } else if (creditAmount !== null && creditAmount > 0) {
      status = "CREDIT";
      value = creditAmount;
    } else if (row.valueText && isAmountText(row.valueText)) {
      const parsed = parseNumber(row.valueText);
      if (parsed !== 0) {
        status = parsed < 0 ? "DEBIT" : "CREDIT";
        value = Math.abs(parsed);
      }
    }

    if (!status || value <= 0) return;

    const formattedValue = formatRupiah(value);
    const debit = status === "DEBIT" ? formattedValue : "0";
    const credit = status === "CREDIT" ? formattedValue : "0";

    const saldoParsed = row.saldoText && isAmountText(row.saldoText) ? parseNumber(row.saldoText) : null;
    const saldo = saldoParsed === null ? "" : formatRupiah(Math.abs(saldoParsed));

    const kategori = detectKategori(row.description || "");

    const csvRow = [
      quoteIfNeeded(row.date || ""),
      quoteIfNeeded(kategori),
      quoteIfNeeded(row.description || ""),
      quoteIfNeeded(debit),
      quoteIfNeeded(credit),
      quoteIfNeeded(saldo),
    ].join(",");

    csvContent += csvRow + "\n";
  }

  function parseNumber(numStr) {
    if (!numStr) return 0;
    let s = String(numStr).trim().replace(/\s+/g, "");

    let sign = 1;
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
    return /^[+-]?\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})$/.test(String(text).trim());
  }

  function isTimeText(text = "") {
    return /^\d{2}:\d{2}(?::\d{2})?$/.test(String(text).trim());
  }

  function isDateText(text = "") {
    const t = String(text).trim();
    return (
      /^\d{2}\/\d{2}(?:\/\d{2,4})?$/.test(t) ||
      /^\d{2}-\d{2}(?:-\d{2,4})?$/.test(t) ||
      /^\d{2}\s+[A-Za-z]{3}(?:\s+\d{2,4})?$/.test(t) ||
      /^\d{2}\s+[A-Za-z]{3}\s+\d{4}$/.test(t)
    );
  }

  function isDayToken(text = "") {
    return /^\d{2}$/.test(String(text).trim());
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

    if (/^\d{2}[/-]\d{2}(?:[/-]\d{2,4})?$/.test(t)) {
      const [d, m] = t.split(/[/-]/);
      return `${d}/${m}`;
    }

    const parts = t.split(/\s+/);
    if (parts.length >= 2) {
      const day = parts[0];
      const monKey = parts[1].slice(0, 3).toLowerCase();
      const mm = MONTH_MAP[monKey];
      if (/^\d{2}$/.test(day) && mm) return `${day}/${mm}`;
    }

    return t;
  }

  function normalizeDescription(value = "") {
    return String(value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function detectKategori(description = "") {
    const upper = String(description).toUpperCase();
    const categories = [
      "OVERBOOKING",
      "TRANSFER",
      "TRF",
      "DEBIT CARD",
      "BILL PAYMENT",
      "DIRECT CREDIT",
      "INTEREST",
      "TAX",
      "QR",
      "TOP UP",
    ];

    for (const c of categories) {
      if (upper.includes(c)) return c;
    }
    return "";
  }

  function looksLikeHeader(description = "") {
    const upper = String(description).toUpperCase();
    return (
      upper.includes("TANGGAL DESKRIPSI") ||
      upper.includes("DESKRIPSI DEBIT KREDIT SALDO") ||
      upper === "TANGGAL" ||
      upper === "DESKRIPSI" ||
      upper === "SALDO"
    );
  }

  function clusterByX(values, tolerance = 0.65) {
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
      .map((c) => ({
        center: c.values.reduce((sum, v) => sum + v, 0) / c.values.length,
        count: c.values.length,
      }))
      .sort((a, b) => a.center - b.center);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
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

  function near(value, target, tolerance) {
    return Math.abs(value - target) <= tolerance;
  }

  function formatRupiah(value) {
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
}

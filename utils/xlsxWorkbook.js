import JSZip from "jszip";

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const NUMERIC_HEADER_TOKENS = new Set([
  "value",
  "amount",
  "debit",
  "debet",
  "credit",
  "kredit",
  "saldo",
  "balance",
  "jumlah",
  "nominal",
  "nilai",
]);

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnToLetters(index) {
  let value = index + 1;
  let letters = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }

  return letters;
}

function parseCsv(csvContent) {
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

      if (!(currentRow.length === 1 && currentRow[0] === "" && rows.length === 0)) {
        rows.push(currentRow);
      }
      currentRow = [];

      if (char === "\r" && nextChar === "\n") {
        i += 1;
      }
      continue;
    }

    currentValue += char;
  }

  currentRow.push(currentValue);
  if (!(currentRow.length === 1 && currentRow[0] === "")) {
    rows.push(currentRow);
  }

  return rows;
}

function normalizeHeaderToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNumericHeader(value) {
  const normalized = normalizeHeaderToken(value);
  if (!normalized) return false;
  if (NUMERIC_HEADER_TOKENS.has(normalized)) return true;

  for (const token of NUMERIC_HEADER_TOKENS) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`, "i");
    if (pattern.test(normalized)) {
      return true;
    }
  }

  return false;
}

function parseLocalizedNumber(rawValue) {
  const original = String(rawValue ?? "").trim();
  if (!original) return null;

  let sign = 1;
  let cleaned = original.replace(/\u00A0/g, " ").trim();

  if (/^\(.*\)$/.test(cleaned)) {
    sign = -1;
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (cleaned.includes("-")) {
    sign = -1;
  }

  cleaned = cleaned.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) {
      cleaned = cleaned.replace(/\./g, "").replace(/,/g, ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = cleaned.split(",");
    const decimalPart = parts[parts.length - 1] || "";
    if (decimalPart.length <= 2) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = cleaned.split(".");
    const decimalPart = parts[parts.length - 1] || "";
    if (parts.length > 2 || decimalPart.length === 3) {
      cleaned = cleaned.replace(/\./g, "");
    }
  }

  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;
  if (parsed === 0) return 0;
  return sign < 0 ? -Math.abs(parsed) : parsed;
}

function normalizeSheetName(sheetName, fallbackIndex) {
  const raw = String(sheetName || fallbackIndex);
  const invalidChars = /[\\/*?:[\]]/g;
  const cleaned = raw.replace(invalidChars, "_").trim();
  const bounded = (cleaned || String(fallbackIndex)).slice(0, 31);
  return bounded || String(fallbackIndex);
}

function makeUniqueSheetName(baseName, usedNames) {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  let counter = 2;
  let candidate = `${baseName}_${counter}`;
  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${baseName}_${counter}`;
  }

  usedNames.add(candidate);
  return candidate;
}

function buildWorksheetXml(rows) {
  const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
  const numericColumnIndexes = new Set(
    headerRow
      .map((headerValue, index) =>
        isNumericHeader(headerValue) ? index : -1
      )
      .filter((index) => index >= 0)
  );

  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, colIndex) => {
          const cellRef = `${columnToLetters(colIndex)}${rowIndex + 1}`;
          if (value === "") {
            return `<c r="${cellRef}"/>`;
          }

          if (rowIndex > 0 && numericColumnIndexes.has(colIndex)) {
            const parsedNumber = parseLocalizedNumber(value);
            if (parsedNumber !== null) {
              return `<c r="${cellRef}"><v>${parsedNumber}</v></c>`;
            }
          }

          const escapedValue = escapeXml(value);
          return `<c r="${cellRef}" t="inlineStr"><is><t xml:space="preserve">${escapedValue}</t></is></c>`;
        })
        .join("");

      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  return (
    `${XML_HEADER}` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowXml}</sheetData>` +
    `</worksheet>`
  );
}

function buildWorkbookXml(sheets) {
  const sheetXml = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
    )
    .join("");

  return (
    `${XML_HEADER}` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheetXml}</sheets>` +
    `</workbook>`
  );
}

function buildWorkbookRelsXml(sheetCount) {
  const relationships = [];

  for (let i = 1; i <= sheetCount; i += 1) {
    relationships.push(
      `<Relationship Id="rId${i}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` +
        `Target="worksheets/sheet${i}.xml"/>`
    );
  }

  relationships.push(
    `<Relationship Id="rId${sheetCount + 1}" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ` +
      `Target="styles.xml"/>`
  );

  return (
    `${XML_HEADER}` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `${relationships.join("")}` +
    `</Relationships>`
  );
}

function buildContentTypesXml(sheetCount) {
  const worksheetOverrides = [];
  for (let i = 1; i <= sheetCount; i += 1) {
    worksheetOverrides.push(
      `<Override PartName="/xl/worksheets/sheet${i}.xml" ` +
        `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    );
  }

  return (
    `${XML_HEADER}` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `${worksheetOverrides.join("")}` +
    `</Types>`
  );
}

function buildStylesXml() {
  return (
    `${XML_HEADER}` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`
  );
}

export async function buildWorkbookBuffer(sheetEntries) {
  const normalizedEntries = Array.isArray(sheetEntries) ? sheetEntries : [];
  if (normalizedEntries.length === 0) {
    throw new Error("Cannot build workbook without sheet data.");
  }

  const usedSheetNames = new Set();
  const sheets = normalizedEntries.map((entry, index) => {
    const parsedRows = parseCsv(entry.csvContent);
    const safeName = normalizeSheetName(entry.sheetName, index + 1);
    const uniqueName = makeUniqueSheetName(safeName, usedSheetNames);

    return {
      name: uniqueName,
      rows: parsedRows,
    };
  });

  const zip = new JSZip();
  zip.file("[Content_Types].xml", buildContentTypesXml(sheets.length));
  zip.file(
    "_rels/.rels",
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`
  );
  zip.file("xl/workbook.xml", buildWorkbookXml(sheets));
  zip.file("xl/_rels/workbook.xml.rels", buildWorkbookRelsXml(sheets.length));
  zip.file("xl/styles.xml", buildStylesXml());

  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, buildWorksheetXml(sheet.rows));
  });

  return zip.generateAsync({ type: "nodebuffer" });
}

export const workbookMimeType = XLSX_MIME;

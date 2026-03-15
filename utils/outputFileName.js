import path from "path";

const monthAliasToNumber = {
  jan: 1,
  januari: 1,
  feb: 2,
  febuari: 2,
  februari: 2,
  mar: 3,
  maret: 3,
  apr: 4,
  may: 5,
  mei: 5,
  jun: 6,
  juni: 6,
  jul: 7,
  juli: 7,
  agu: 8,
  agt: 8,
  ags: 8,
  agustus: 8,
  aug: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  oktober: 10,
  oct: 10,
  nov: 11,
  november: 11,
  des: 12,
  desember: 12,
  dec: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const monthMatcher =
  /(september|february|november|december|january|october|augustus|agustus|februari|desember|november|januari|oktober|september|febuari|maret|april|march|june|july|august|sept|mei|agu|agt|ags|des|okt|jan|feb|mar|apr|may|jun|juni|jul|juli|aug|sep|oct|nov|dec)/i;

function sanitizeBaseName(baseName) {
  const cleaned = baseName
    .replace(/[^\w-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return cleaned || "statement";
}

function stripSingleMatch(baseName, matchedText) {
  const escaped = matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return baseName.replace(new RegExp(escaped, "i"), "");
}

export function createMonthlyCsvFileName(originalFileName, fallbackIndex = 1) {
  const parsed = path.parse(originalFileName || "statement.pdf");
  const rawBaseName = parsed.name || "statement";

  const monthMatch = rawBaseName.match(monthMatcher);
  if (!monthMatch) {
    return `${sanitizeBaseName(rawBaseName)}_${fallbackIndex}.csv`;
  }

  const matchedToken = monthMatch[0].toLowerCase();
  const monthNumber = monthAliasToNumber[matchedToken] || fallbackIndex;
  const withoutMonth = stripSingleMatch(rawBaseName, monthMatch[0]);
  const normalizedBase = sanitizeBaseName(withoutMonth || rawBaseName);

  return `${normalizedBase}_${monthNumber}.csv`;
}

export function extractMonthIndexFromCsvFileName(csvFileName, fallbackIndex = 1) {
  // Expected shapes:
  //   <base>_<month>.csv
  //   <base>_<month>_<counter>.csv   (when filename is made unique)
  // Month token must be 1-2 digits so year tokens like 2024 are ignored.
  const match = String(csvFileName || "").match(/_(\d{1,2})(?:_\d+)?\.csv$/i);
  if (!match) return fallbackIndex;

  const monthIndex = Number(match[1]);
  if (!Number.isInteger(monthIndex) || monthIndex < 1 || monthIndex > 12) {
    return fallbackIndex;
  }

  return monthIndex;
}

const monthNamesByIndex = {
  1: "January",
  2: "February",
  3: "March",
  4: "April",
  5: "May",
  6: "June",
  7: "July",
  8: "August",
  9: "September",
  10: "October",
  11: "November",
  12: "December",
};

export function monthIndexToSheetName(monthIndex) {
  return monthNamesByIndex[monthIndex] || `Month_${monthIndex}`;
}

export function createWorkbookFileNameFromCsv(csvFileName) {
  const parsed = path.parse(csvFileName || "statements.csv");
  const rawBase = parsed.name.replace(/_\d+(?:_\d+)?$/, "");
  const normalizedBase = sanitizeBaseName(rawBase || "statements");
  return `${normalizedBase}.xlsx`;
}

export function makeUniqueFileName(fileName, usedNames) {
  if (!usedNames.has(fileName)) {
    usedNames.add(fileName);
    return fileName;
  }

  const parsed = path.parse(fileName);
  let counter = 2;
  let candidate = `${parsed.name}_${counter}${parsed.ext}`;

  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${parsed.name}_${counter}${parsed.ext}`;
  }

  usedNames.add(candidate);
  return candidate;
}

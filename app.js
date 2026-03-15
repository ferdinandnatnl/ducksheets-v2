console.log("Server starting...");
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { convertBcaPdfToCsv } from "./utils/bca.js";
import { convertPermataPdfToCsv } from "./utils/permata.js";
import { convertMandiriPdfToCsv } from "./utils/mandiri.js";
import { convertBriPdfToCsv } from "./utils/bri.js";
import { convertBluPdfToCsv } from "./utils/blu.js";
import { convertCimbPdfToCsv } from "./utils/cimb.js";
import {
  createMonthlyCsvFileName,
  makeUniqueFileName,
  extractMonthIndexFromCsvFileName,
  monthIndexToSheetName,
  createWorkbookFileNameFromCsv,
} from "./utils/outputFileName.js";
import { buildWorkbookBuffer, workbookMimeType } from "./utils/xlsxWorkbook.js";
import { cleanupUnlockedPdf, unlockPdfForParsing } from "./utils/pdfUnlock.js";
import { filterIncomeOnlyCsv } from "./utils/csvFilter.js";
import http from 'http';
import https from 'https';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const convertBca2PdfToCsv = convertBcaPdfToCsv;

function normalizeBank(rawValue) {
  if (!rawValue) return "";
  let value = String(rawValue).trim().toLowerCase();
  value = value.split("?")[0].split("#")[0];
  value = value.replace(/^bank[\s_-]*/i, "");
  value = value.replace(/[^a-z0-9]/g, "");
  if (value.includes("cimb") || value.includes("niaga")) return "cimb";
  return value;
}

function normalizeConversionMode(rawValue) {
  if (!rawValue) return "full";
  const value = String(Array.isArray(rawValue) ? rawValue[0] : rawValue)
    .trim()
    .toLowerCase();
  if (
    value === "income-only" ||
    value === "income" ||
    value === "penghasilan" ||
    value === "credit-only" ||
    value === "no-db" ||
    value === "nodb"
  ) {
    return "income-only";
  }
  return "full";
}

function normalizePdfPassword(rawValue) {
  if (rawValue === undefined || rawValue === null) return "";
  const primary = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  return String(primary);
}

function withModeWorkbookName(baseWorkbookName, mode) {
  if (mode !== "income-only") return baseWorkbookName;
  return String(baseWorkbookName || "statements.xlsx").replace(/\.xlsx$/i, "_penghasilan.xlsx");
}

// Middleware
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Setup multer for file uploads
const upload = multer({ dest: "uploads/" });

// API Routes
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is running' });
});

app.post("/api/:bank", upload.fields([
  { name: "pdfFiles", maxCount: 12 },
  { name: "pdfFile", maxCount: 12 },
]), async (req, res) => {
    const uploadedFiles = [
      ...(req.files?.pdfFiles || []),
      ...(req.files?.pdfFile || []),
    ];

    console.log("Received upload request for bank:", req.params.bank);
    console.log("Number of files:", uploadedFiles.length);

    if (uploadedFiles.length === 0) {
        return res.status(400).json({ error: "No files uploaded." });
    }
    if (uploadedFiles.length > 12) {
        return res.status(400).json({ error: "Maximum 12 PDF files per upload." });
    }

    const bank = normalizeBank(req.params.bank);
    const conversionMode = normalizeConversionMode(req.query?.mode);
    const pdfPassword = normalizePdfPassword(req.body?.pdfPassword);
    let convertFunction;
    switch (bank) {
        case "bca": convertFunction = convertBcaPdfToCsv; break;
        case "bca2": convertFunction = convertBca2PdfToCsv; break;
        case "permata": convertFunction = convertPermataPdfToCsv; break;
        case "mandiri": convertFunction = convertMandiriPdfToCsv; break;
        case "bri": convertFunction = convertBriPdfToCsv; break;
        case "blu": convertFunction = convertBluPdfToCsv; break;
        case "cimb": convertFunction = convertCimbPdfToCsv; break;
        default:
            console.log("Invalid bank selection:", bank);
            return res.status(400).json({ error: "Invalid bank selection." });
    }

    try {
        const csvOutputs = [];
        const usedOutputNames = new Set();
        for (const [index, file] of uploadedFiles.entries()) {
            console.log(`Processing file ${index + 1}/${uploadedFiles.length}: ${file.originalname || file.filename}`);
            const preparedPdf = await unlockPdfForParsing(file.path, { password: pdfPassword });

            if (preparedPdf.wasEncrypted && !preparedPdf.unlocked) {
                const unlockReason = preparedPdf.reason || "";
                if (unlockReason === "password_required") {
                    throw {
                        parserError: "This PDF is encrypted and needs a password. Fill in the PDF password and try again."
                    };
                }
                if (unlockReason === "invalid_password") {
                    throw {
                        parserError: "PDF password is incorrect. Please check the password and try again."
                    };
                }
                throw {
                    parserError: "This PDF is encrypted and could not be unlocked automatically. Please unlock it first and upload again."
                };
            }

            try {
                const csvContent = await new Promise((resolve, reject) => {
                    convertFunction(preparedPdf.filePath, file.filename, (err, content) => {
                        if (err) {
                            console.error("Error during conversion:", err);
                            reject(err);
                        } else {
                            resolve(content);
                        }
                    });
                });
                const finalCsvContent =
                    conversionMode === "income-only"
                        ? filterIncomeOnlyCsv(csvContent)
                        : csvContent;

                const suggestedCsvName = createMonthlyCsvFileName(file.originalname || file.filename, index + 1);
                const outputCsvName = makeUniqueFileName(suggestedCsvName, usedOutputNames);
                const monthIndex = extractMonthIndexFromCsvFileName(outputCsvName, index + 1);
                csvOutputs.push({ csvContent: finalCsvContent, csvFileName: outputCsvName, monthIndex });
            } finally {
                await cleanupUnlockedPdf(preparedPdf);
            }
        }

        const sortedSheets = [...csvOutputs].sort((a, b) => a.monthIndex - b.monthIndex);
        const workbookBuffer = await buildWorkbookBuffer(
            sortedSheets.map((item) => ({
                sheetName: monthIndexToSheetName(item.monthIndex),
                csvContent: item.csvContent,
            }))
        );
        const workbookName = withModeWorkbookName(
            createWorkbookFileNameFromCsv(sortedSheets[0]?.csvFileName || `${bank}_statements.csv`),
            conversionMode
        );
        res.setHeader("Content-Type", workbookMimeType);
        res.setHeader("Content-Disposition", `attachment; filename="${workbookName}"`);
        return res.status(200).send(workbookBuffer);
    } catch (err) {
        console.error("Error processing files:", err);
        const parserError = err?.parserError || err?.message || "";
        const isUnlockError =
            typeof parserError === "string" &&
            (
                parserError.toLowerCase().includes("unsupported encryption algorithm") ||
                parserError.toLowerCase().includes("encrypted and could not be unlocked") ||
                parserError.toLowerCase().includes("needs a password") ||
                parserError.toLowerCase().includes("password is incorrect")
            );

        if (isUnlockError) {
            return res.status(400).json({
                error: parserError || "This PDF uses an encryption type that is not supported. Please export/download an unencrypted PDF and try again."
            });
        }

        res.status(500).json({
            error: "Error processing files.",
            details: parserError || "Unknown error"
        });
    } finally {
        uploadedFiles.forEach(file => {
            try {
                fs.unlinkSync(file.path);
            } catch {
                // Ignore cleanup errors for temporary uploads.
            }
        });
    }
});

// Static file serving
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all route for SPA
app.get('*', (req, res) => {
  console.log('Catch-all route hit');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something broke!', details: err.message });
});

// Server creation
const httpServer = http.createServer(app);

let httpsServer;
if (fs.existsSync('/etc/letsencrypt/live/www.ducksheets.com/fullchain.pem') &&
    fs.existsSync('/etc/letsencrypt/live/www.ducksheets.com/privkey.pem')) {
    const privateKey = fs.readFileSync('/etc/letsencrypt/live/www.ducksheets.com/privkey.pem', 'utf8');
    const certificate = fs.readFileSync('/etc/letsencrypt/live/www.ducksheets.com/fullchain.pem', 'utf8');
    const credentials = { key: privateKey, cert: certificate };
    httpsServer = https.createServer(credentials, app);
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

export default app;

import multer from 'multer';
import { promises as fsPromises } from 'fs';
import { convertBcaPdfToCsv } from '../utils/bca.js';
import { convertBriPdfToCsv } from '../utils/bri.js';
import { convertMandiriPdfToCsv } from '../utils/mandiri.js';
import { convertPermataPdfToCsv } from '../utils/permata.js';
import { convertBluPdfToCsv } from '../utils/blu.js';
import { convertCimbPdfToCsv } from '../utils/cimb.js';
import {
  createMonthlyCsvFileName,
  makeUniqueFileName,
  extractMonthIndexFromCsvFileName,
  monthIndexToSheetName,
  createWorkbookFileNameFromCsv,
} from '../utils/outputFileName.js';
import { buildWorkbookBuffer, workbookMimeType } from '../utils/xlsxWorkbook.js';
import { cleanupUnlockedPdf, unlockPdfForParsing } from '../utils/pdfUnlock.js';
import { filterIncomeOnlyCsv } from '../utils/csvFilter.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

const upload = multer({ 
  dest: '/tmp/',
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});
const MAX_PDF_FILES = 12;

function normalizeBank(rawValue) {
  if (!rawValue) return '';
  const primary = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  let value = String(primary).trim().toLowerCase();
  value = value.split('?')[0].split('#')[0];
  value = value.replace(/^bank[\s_-]*/i, '');
  value = value.replace(/[^a-z0-9]/g, '');
  if (value.includes('cimb') || value.includes('niaga')) return 'cimb';
  return value;
}

function normalizeConversionMode(rawValue) {
  if (!rawValue) return 'full';
  const primary = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  const value = String(primary).trim().toLowerCase();
  if (
    value === 'income-only' ||
    value === 'income' ||
    value === 'penghasilan' ||
    value === 'credit-only' ||
    value === 'no-db' ||
    value === 'nodb'
  ) {
    return 'income-only';
  }
  return 'full';
}

function normalizePdfPassword(rawValue) {
  if (rawValue === undefined || rawValue === null) return '';
  const primary = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  return String(primary);
}

function withModeWorkbookName(baseWorkbookName, mode) {
  if (mode !== 'income-only') return baseWorkbookName;
  return String(baseWorkbookName || 'statements.xlsx').replace(/\.xlsx$/i, '_penghasilan.xlsx');
}

export default function handler(req, res) {
  console.log('Received request:', req.method, req.url);
  console.log('Query parameters:', req.query);

  const bank = normalizeBank(req.query?.bank) || normalizeBank(req.url.split('/').pop());
  const conversionMode = normalizeConversionMode(req.query?.mode);

  if (!bank) {
    return res.status(400).json({ error: 'Bank parameter is required' });
  }

  console.log(`Processing request for bank: ${bank}`);

  if (req.method === 'POST') {
    // Use multer to handle file upload
    upload.fields([
      { name: 'pdfFile', maxCount: MAX_PDF_FILES },
      { name: 'pdfFiles', maxCount: MAX_PDF_FILES },
    ])(req, res, async function (err) {
      if (err) {
        console.error('Multer error:', err);
        if (
          err?.code === 'LIMIT_FILE_COUNT' ||
          err?.code === 'LIMIT_UNEXPECTED_FILE'
        ) {
          return res.status(400).json({ error: `Maximum ${MAX_PDF_FILES} PDF files per upload.` });
        }
        return res.status(500).json({ error: err.message });
      }

      const uploadedFiles = [
        ...(req.files?.pdfFiles || []),
        ...(req.files?.pdfFile || []),
      ];

      if (uploadedFiles.length === 0) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }
      if (uploadedFiles.length > MAX_PDF_FILES) {
        return res.status(400).json({ error: `Maximum ${MAX_PDF_FILES} PDF files per upload.` });
      }

      // Select the appropriate conversion function based on the bank
      const pdfPassword = normalizePdfPassword(req.body?.pdfPassword);
      let convertFunction;
      switch (bank) {
        case 'bca':
          convertFunction = convertBcaPdfToCsv;
          break;
        case 'bri':
          convertFunction = convertBriPdfToCsv;
          break;
        case 'mandiri':
          convertFunction = convertMandiriPdfToCsv;
          break;
        case 'permata':
          convertFunction = convertPermataPdfToCsv;
          break;
        case 'blu':
          convertFunction = convertBluPdfToCsv;
          break;
        case 'cimb':
          convertFunction = convertCimbPdfToCsv;
          break;
        default:
          return res.status(400).json({ error: 'Invalid bank selection.' });
      }

      try {
        const conversionOutputs = [];
        const usedOutputNames = new Set();
        for (const [index, file] of uploadedFiles.entries()) {
          console.log(`Processing file ${index + 1}/${uploadedFiles.length}: ${file.originalname || file.filename}`);
          const preparedPdf = await unlockPdfForParsing(file.path, { password: pdfPassword });

          if (preparedPdf.wasEncrypted && !preparedPdf.unlocked) {
            const unlockReason = preparedPdf.reason || '';
            if (unlockReason === 'password_required') {
              throw {
                parserError: 'This PDF is encrypted and needs a password. Fill in the PDF password and try again.'
              };
            }
            if (unlockReason === 'invalid_password') {
              throw {
                parserError: 'PDF password is incorrect. Please check the password and try again.'
              };
            }
            throw {
              parserError: 'This PDF is encrypted and could not be unlocked automatically. Please unlock it first and upload again.'
            };
          }

          try {
            const csvContent = await new Promise((resolve, reject) => {
              convertFunction(preparedPdf.filePath, file.filename, (conversionError, content) => {
                if (conversionError) {
                  reject(conversionError);
                } else {
                  resolve(content);
                }
              });
            });
            const finalCsvContent =
              conversionMode === 'income-only'
                ? filterIncomeOnlyCsv(csvContent)
                : csvContent;

            const suggestedCsvName = createMonthlyCsvFileName(file.originalname || file.filename, index + 1);
            const outputCsvName = makeUniqueFileName(suggestedCsvName, usedOutputNames);
            conversionOutputs.push({
              csvContent: finalCsvContent,
              csvFileName: outputCsvName,
              monthIndex: extractMonthIndexFromCsvFileName(outputCsvName, index + 1),
            });
          } finally {
            await cleanupUnlockedPdf(preparedPdf);
          }
        }

        const sortedSheets = [...conversionOutputs].sort((a, b) => a.monthIndex - b.monthIndex);
        const workbookBuffer = await buildWorkbookBuffer(
          sortedSheets.map((item) => ({
            sheetName: monthIndexToSheetName(item.monthIndex),
            csvContent: item.csvContent,
          }))
        );
        const workbookName = withModeWorkbookName(
          createWorkbookFileNameFromCsv(sortedSheets[0]?.csvFileName || `${bank.toLowerCase()}_statements.csv`),
          conversionMode
        );
        res.setHeader('Content-Type', workbookMimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${workbookName}"`);
        return res.status(200).send(workbookBuffer);
      } catch (conversionError) {
        console.error('Error during conversion:', conversionError);
        const parserError = conversionError?.parserError || conversionError?.message || '';
        const isUnlockError =
          typeof parserError === 'string' &&
          (
            parserError.toLowerCase().includes('unsupported encryption algorithm') ||
            parserError.toLowerCase().includes('encrypted and could not be unlocked') ||
            parserError.toLowerCase().includes('needs a password') ||
            parserError.toLowerCase().includes('password is incorrect')
          );

        if (isUnlockError) {
          return res.status(400).json({
            error: parserError || 'This PDF uses an encryption type that is not supported. Please unlock it first and upload again.'
          });
        }

        return res.status(500).json({ error: 'Error during PDF to CSV conversion.' });
      } finally {
        await Promise.all(
          uploadedFiles.map(file => fsPromises.unlink(file.path).catch(() => {}))
        );
      }
    });
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

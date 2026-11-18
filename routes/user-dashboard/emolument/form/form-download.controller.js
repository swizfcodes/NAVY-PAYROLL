"Use strict";

const https = require("https");
const http  = require("http");
const formService = require("./form.service");
const documentsService = require("../documents/documents.service");
const BaseReportController = require("../../../../controllers/Reports/reportsFallbackController");
const companySettings = require("../../../../controllers/helpers/companySettings");
const path = require("path");

class FormDownloadController extends BaseReportController {
  async downloadFormPDF(req, res) {
    try {
      const serviceNo = req.downloadSvcNo || req.user_id;
      const result = await formService.loadForm(serviceNo);

      if (!result.success) {
        return res.status(result.code).json({ error: result.message });
      }

      const templatePath = path.join(
        __dirname,
        "../../../../templates/emolument-form.html",
      );

      const image = await companySettings.getSettingsFromFile(
        "./public/photos/logo.png",
      );

      // Embed the passport photos as base64 data URLs so Puppeteer needs no
      // requests of its own while rendering the PDF.
      const docs = result.data.documents || {};
      const [passportDataUrl, nokPassportDataUrl, altNokPassportDataUrl] =
        await Promise.all([
          photoDataUrl(docs.passport),
          photoDataUrl(docs.nokPassport),
          photoDataUrl(docs.altNokPassport),
        ]);

      const pdfBuffer = await this.generatePDFWithFallback(
        templatePath,
        {
          data: result.data,
          reportDate: new Date(),
          ...image,
          passportDataUrl,
          nokPassportDataUrl,
          altNokPassportDataUrl,
        },
        {
          format: "A4",
          landscape: false,
          marginTop: "0mm",
          marginBottom: "0mm",
          marginLeft: "0mm",
          marginRight: "0mm",
        },
      );

      const rawName =
        result.data.serviceNumber || result.data.serviceNo || "form";
      const rawPersonName =
        result.data.fullAccountName ||
        [result.data.Surname, result.data.OtherName]
          .filter(Boolean)
          .join("_") ||
        result.data.name ||
        "personnel";
      const rawYear =
        result.data.FormYear ||
        result.data.formYear ||
        new Date().getFullYear();
      const fileName = `${sanitizeFileName(rawName)}_${sanitizeFileName(rawPersonName)}_${sanitizeFileName(
        rawYear.toString(),
      )}_emolument_form.pdf`;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`,
      );
      res.send(pdfBuffer);
    } catch (error) {
      console.error("Emolument Form PDF generation error:", error);
      if (!res.headersSent) {
        return res.status(500).json({ success: false, error: error.message });
      }
    }
  }
}

// Photo as a data URL: read from the storage folder, or fetched from the old
// Cloudinary address for rows the copy script has not reached yet.
// Returns null when there is no photo so the template shows the placeholder.
function photoDataUrl(doc) {
  if (!doc) return Promise.resolve(null);
  if (doc.file_key) return documentsService.readAsDataUrl(doc);
  return fetchImageAsBase64(doc.url);
}

// Fetch a remote image URL and return a base64 data URI string.
// Returns null on any error so the template can fall back to the placeholder.
function fetchImageAsBase64(url) {
  if (!url || !/^https?:\/\//i.test(url)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const mime = res.headers["content-type"] || "image/jpeg";
          resolve(`data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`);
        });
      })
      .on("error", () => resolve(null));
  });
}

function sanitizeFileName(name) {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

module.exports = new FormDownloadController();

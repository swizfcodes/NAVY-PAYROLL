/**
 * FILE: routes/user-dashboard/emolument/admin/ship-users-template.js
 *
 * Builds the styled bulk-upload template (.xlsx) for ship users.
 * Requires: npm i exceljs
 *
 * Column order/headers match HEADER_ALIASES in admin.routes.js, and the
 * banner rows sit above the header row (parseXlsxBuffer scans the first
 * 10 rows for the real header, so this is safe).
 */

"use strict";

const ExcelJS = require("exceljs");

const LAST_DATA_ROW = 500;
const COLS = 4;

const THIN = { style: "thin", color: { argb: "FF000000" } };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };

const FONT = "Arial";

function boxRange(ws, fromRow, toRow, cols) {
  for (let r = fromRow; r <= toRow; r++)
    for (let c = 1; c <= cols; c++) ws.getCell(r, c).border = BOX;
}

async function buildShipUsersTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "E-Emolument";

  /* ───────── Sheet 1: Ship Users ───────── */
  const ws = wb.addWorksheet("Ship Users", {
    views: [{ state: "frozen", ySplit: 4 }],
  });
  ws.columns = [{ width: 16 }, { width: 18 }, { width: 24 }, { width: 30 }];

  ws.mergeCells("A1:D1");
  Object.assign(ws.getCell("A1"), { value: "NIGERIAN NAVY E-EMOLUMENT" });
  ws.getCell("A1").font = {
    name: FONT,
    bold: true,
    size: 14,
    color: { argb: "FFFFFFFF" },
  };
  ws.getCell("A1").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E78" },
  };
  ws.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 26;

  ws.mergeCells("A2:D2");
  ws.getCell("A2").value = "SHIP USERS UPLOAD";
  ws.getCell("A2").font = { name: FONT, bold: true, size: 12 };
  ws.getCell("A2").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD9D9D9" },
  };
  ws.getCell("A2").alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(2).height = 22;

  // Row 3 is a spacer.

  const headers = [
    "Service No.",
    "Role (FO/CPO)",
    "Scope Type (SHIP/COMMAND)",
    "Scope Value (Ship name or Command code)",
  ];
  headers.forEach((h, i) => {
    const cell = ws.getCell(4, i + 1);
    cell.value = h;
    cell.font = { name: FONT, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2E5C8A" },
    };
    cell.alignment = {
      horizontal: "center",
      vertical: "middle",
      wrapText: true,
    };
  });
  ws.getRow(4).height = 32;

  const samples = [
    ["NN/5012A", "FO", "SHIP", "NNS BEECROFT"],
    ["NN/3301B", "CPO", "COMMAND", "WNC"],
  ];
  samples.forEach((row, i) => {
    row.forEach((v, c) => {
      ws.getCell(5 + i, c + 1).value = v;
    });
  });

  // Fonts + alignment for every data row
  for (let r = 5; r <= LAST_DATA_ROW; r++) {
    for (let c = 1; c <= COLS; c++) {
      const cell = ws.getCell(r, c);
      cell.font = { name: FONT };
      cell.alignment = { vertical: "middle" };
    }
    ws.getCell(r, 2).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"FO,CPO"'],
      showErrorMessage: true,
      errorTitle: "Invalid role",
      error: "Role must be FO or CPO.",
    };
    ws.getCell(r, 3).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"SHIP,COMMAND"'],
      showErrorMessage: true,
      errorTitle: "Invalid scope type",
      error: "Scope type must be SHIP or COMMAND.",
    };
  }

  // Box every cell: banners, header, samples and all empty data rows
  boxRange(ws, 1, 2, COLS);
  boxRange(ws, 4, LAST_DATA_ROW, COLS);

  /* ───────── Sheet 2: Instructions ───────── */
  const ins = wb.addWorksheet("Instructions");
  ins.columns = [{ width: 90 }];

  ins.getCell("A1").value =
    "INSTRUCTIONS FOR FILLING THE SHIP USERS UPLOAD TEMPLATE";
  ins.getCell("A1").font = {
    name: FONT,
    bold: true,
    size: 12,
    color: { argb: "FFFFFFFF" },
  };
  ins.getCell("A1").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E78" },
  };
  ins.getCell("A1").alignment = { vertical: "middle" };
  ins.getRow(1).height = 24;

  const lines = [
    "1. Do not modify the header rows (rows 1-4).",
    "2. Fill data starting from row 5.",
    "3. Service No. must match an existing personnel record (e.g., NN/4940F).",
    "4. Role must be one of: FO (Financial Officer), CPO (Central Pay Officer).",
    "5. Scope Type must be SHIP for FO roles, or COMMAND for CPO roles.",
    "6. Scope Value must be the exact Ship name (for SHIP) or Command code (for COMMAND) as registered in the system.",
    "7. All fields are required.",
    "8. Do not leave blank rows between entries.",
  ];
  lines.forEach((t, i) => {
    const cell = ins.getCell(3 + i, 1);
    cell.value = t;
    cell.font = { name: FONT };
    cell.alignment = { wrapText: true, vertical: "middle" };
  });
  boxRange(ins, 1, 10, 1);

  return wb.xlsx.writeBuffer();
}

module.exports = { buildShipUsersTemplate };

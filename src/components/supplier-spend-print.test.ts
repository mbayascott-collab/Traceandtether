import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import SupplierSpendPrintDocument from "./SupplierSpendPrintDocument";
import type { SupplierReportCsvData } from "../../shared/supplier-report-csv";

const rowCount = 58;

function executable(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function findChromium(): string {
  const candidates = [process.env.CHROMIUM_PATH, "/repl/tools/bin/chromium", "chromium"].filter(Boolean) as string[];
  const command = candidates.find(executable);
  assert.ok(command, "Could not find Chromium. Set CHROMIUM_PATH to a Chromium executable.");
  return command;
}

function fixtureReport(): SupplierReportCsvData {
  const suppliers = Array.from({ length: rowCount }, (_, index) => {
    const id = String(index + 1).padStart(3, "0");
    return {
      name: `Fixture Supplier ${id}`, orders: 2, orderedGoodsZmw: "240.00", importCostsZmw: "30.00",
      paymentsZmw: "120.00", measuredDeliveryOrders: 2, onTimeOrders: 1, lateOrders: 1,
      missingExpectedDateOrders: 0, missingActualDateOrders: 0, incompleteDeliveryOrders: 0,
      overdueOpenOrders: 0, averageDeliveryVarianceDays: "1.5",
    };
  });

  return {
    period: { from: "2025-01-01", to: "2025-03-31" },
    monthlySpend: [
      {
        month: "2025-01", orderedGoodsZmw: "240.00", importCostsZmw: "30.00", paymentsZmw: "120.00",
        suppliers: [{ supplierId: 1, supplierName: "Fixture Supplier 001", orderedGoodsZmw: "240.00", importCostsZmw: "30.00" }],
      },
      {
        month: "2025-02", orderedGoodsZmw: "0.00", importCostsZmw: "10.00", paymentsZmw: "0.00",
        suppliers: [{ supplierId: 1, supplierName: "Fixture Supplier 001", orderedGoodsZmw: "0.00", importCostsZmw: "10.00" }],
      },
    ],
    shipments: [{
      supplierId: 1, supplierName: "Shipment Detail Vendor", orderNumber: "PO-PRINT-1", shipmentId: 51,
      shipmentReference: "SHIP-PRINT-51", status: "received", expectedAt: null, receivedAt: "2025-01-18",
    }],
    totals: {
      orderedGoodsZmw: "13920.00", importCostsZmw: "2325.00", unallocatedImportCostsZmw: "585.00",
      paymentsZmw: "6960.00", orders: rowCount * 2, onTimeOrders: rowCount, lateOrders: rowCount,
      overdueOpenOrders: 0, missingExpectedDateOrders: 0, missingActualDateOrders: 0,
      incompleteDeliveryOrders: 0, measuredDeliveryOrders: rowCount * 2,
    },
    suppliers,
  };
}

test("supplier spend PDF includes report totals and keeps long supplier tables readable", () => {
  const directory = mkdtempSync(join(tmpdir(), "supplier-spend-print-"));

  try {
    const pdfPath = join(directory, "supplier-spend.pdf");
    const textPath = join(directory, "supplier-spend.txt");
    const cssPath = resolve("src/index.css");
    const markup = renderToStaticMarkup(
      React.createElement(SupplierSpendPrintDocument, { report: fixtureReport() }),
    );
    const htmlPath = join(directory, "supplier-spend.html");
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="${pathToFileURL(cssPath).href}">
      <style>body { margin: 0; }</style></head><body>${markup}</body></html>`;
    writeFileSync(htmlPath, html);

    execFileSync(findChromium(), [
      "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href,
    ], { stdio: "pipe", timeout: 60_000 });

    const pdfInfo = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    const pageCount = Number(pdfInfo.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    assert.ok(pageCount > 1, `Expected a multi-page PDF, got ${pageCount} page(s).`);
    const pageSize = pdfInfo.match(/^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts\s+\(A4\)/m);
    assert.ok(pageSize && Number(pageSize[1]) > Number(pageSize[2]), "PDF pages should use landscape A4.");

    execFileSync("pdftotext", ["-layout", pdfPath, textPath], { stdio: "pipe" });
    const pages = readFileSync(textPath, "utf8").split("\f").map((page) => page.trim()).filter(Boolean);
    assert.equal(pages.length, pageCount, "Extracted PDF pages should match pdfinfo.");
    const normalize = (value: string) => value.replace(/\s+/g, " ").toLocaleLowerCase();
    const allText = normalize(pages.join("\n"));

    for (let index = 1; index <= rowCount; index += 1) {
      const name = `Fixture Supplier ${String(index).padStart(3, "0")}`;
      const expectedMentions = index === 1 ? 3 : 1;
      assert.equal(
        allText.split(normalize(name)).length - 1,
        expectedMentions,
        `Expected the supplier table and monthly breakdown to include ${name}.`,
      );
    }

    const supplierPages = pages.filter((page) =>
      normalize(page).includes("fixture supplier") && normalize(page).includes("average variance"),
    );
    assert.ok(supplierPages.length > 1, "Supplier rows should span multiple pages.");
    for (const page of supplierPages) {
      const text = normalize(page);
      assert.ok(text.includes("goods"), "Each supplier-table page should repeat its column headings.");
      assert.ok(text.includes("average variance"), "Each supplier-table page should include the final column heading.");
    }

    for (const requiredText of [
      "2025-01-01 to 2025-03-31",
      "ZMW 13,920.00",
      "ZMW 2,325.00",
      "ZMW 6,960.00",
      "ZMW 585.00 in import costs could not be assigned to a supplier",
      "Matched delivery dates",
      "Incomplete / open",
      "Average variance",
      "January 2025",
      "Monthly costs by supplier",
      "Allocated import costs",
      "PO-PRINT-1",
      "SHIP-PRINT-51",
    ]) {
      assert.ok(allText.includes(normalize(requiredText)), `PDF is missing "${requiredText}". Extracted text: ${allText.slice(0, 1800)}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

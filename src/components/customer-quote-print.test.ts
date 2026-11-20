import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import CustomerQuotePrintDocument from "./CustomerQuotePrintDocument";
import type { CustomerQuote } from "../lib/api";

const quoteNumber = "QT-PRINT-REGRESSION";
const rowCount = 70;
const unitPrice = "1234.50";
const expectedTotal = "ZMW 86,415.00";
const transparentPixel = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

function executable(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function findChromium(): string {
  const candidates = [process.env.CHROMIUM_PATH, "/repl/tools/bin/chromium", "chromium"].filter(Boolean) as string[];
  const command = candidates.find(executable);
  assert.ok(command, `Could not find Chromium. Set CHROMIUM_PATH to a Chromium executable.`);
  return command;
}

function fixtureQuote(): CustomerQuote {
  const lines = Array.from({ length: rowCount }, (_, index) => {
    const n = String(index + 1).padStart(3, "0");
    return {
      id: index + 1,
      productId: index + 1,
      productName: `Regression fixture item ${n}`,
      sku: `QA-${n}`,
      quantity: 1,
      unitPriceZmw: unitPrice,
      lineTotalZmw: unitPrice,
    };
  });

  return {
    id: 1,
    quoteNumber,
    customerId: 1,
    customerName: "Pagination Check Customer",
    customerEmail: null,
    status: "accepted",
    emailSendStatus: "not_sent",
    emailAttemptedAt: null,
    emailSentAt: null,
    emailSendError: null,
    emailDeliveryEventAt: null,
    createdAt: "2026-11-19T00:00:00.000Z",
    validUntil: "2026-12-19",
    deliveryAddress: "164 Mpundu Street, Lusaka, Zambia",
    notes: null,
    salesOrderId: null,
    salesOrderNumber: null,
    totalZmw: String((rowCount * Number(unitPrice)).toFixed(2)),
    lines,
  };
}

test("long customer quotes print every row, repeat table headings, and keep approval with the total", () => {
  const directory = mkdtempSync(join(tmpdir(), "customer-quote-print-"));

  try {
    const pdfPath = join(directory, "long-quote.pdf");
    const textPath = join(directory, "long-quote.txt");
    const cssPath = resolve("src/index.css");
    const css = readFileSync(cssPath, "utf8");
    const markup = renderToStaticMarkup(
      React.createElement(CustomerQuotePrintDocument, { quote: fixtureQuote(), logoSrc: transparentPixel }),
    );
    const htmlPath = join(directory, "quote.html");
    const html = `<!doctype html>
      <html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(cssPath).href}">
      <style>@page { size: A4; } body { margin: 0; }</style></head><body>${markup}</body></html>`;
    writeFileSync(htmlPath, html);

    const chromium = findChromium();
    execFileSync(chromium, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ], { stdio: "pipe", timeout: 60_000 });

    const pdfInfo = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    const pageCount = Number(pdfInfo.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    assert.ok(pageCount > 1, `Expected a multi-page A4 PDF, got ${pageCount} page(s).`);
    assert.match(pdfInfo, /^Page size:.*\(A4\)$/m, "Chromium output must be an A4-sized PDF.");

    execFileSync("pdftotext", ["-layout", pdfPath, textPath], { stdio: "pipe" });
    const pages = readFileSync(textPath, "utf8").split("\f").map((page) => page.trim()).filter(Boolean);
    assert.equal(pages.length, pageCount, "Extracted PDF pages should match pdfinfo.");
    const normalize = (value: string) => value.replace(/\s+/g, " ").toLocaleLowerCase();
    pages.forEach((page, index) => {
      assert.match(normalize(page), new RegExp(`page ${index + 1} of ${pageCount}`), `PDF page ${index + 1} should show its page number.`);
    });

    const allText = normalize(pages.join("\n"));
    for (let index = 1; index <= rowCount; index += 1) {
      const itemName = `Regression fixture item ${String(index).padStart(3, "0")}`;
      assert.equal(allText.split(normalize(itemName)).length - 1, 1, `Expected exactly one printed copy of ${itemName}.`);
    }

    const rowPages = pages.map((page, index) => ({ page, index })).filter(({ page }) => normalize(page).includes("regression fixture item"));
    assert.ok(rowPages.length > 1, "The long quote should place table rows on multiple pages.");
    for (const { page, index } of rowPages) {
      for (const heading of ["Product", "SKU", "Qty", "Unit price", "Amount"]) {
        assert.ok(normalize(page).includes(normalize(heading)), `Table heading "${heading}" is missing from PDF page ${index + 1}.`);
      }
    }

    const finalPage = normalize(pages.at(-1) ?? "");
    for (const requiredText of [
      "Total (ZMW)",
      expectedTotal,
      "Customer approval",
      "Name and signature",
      "Date",
      `Quote reference: ${quoteNumber}`,
    ]) {
      assert.ok(finalPage.includes(normalize(requiredText)), `Final PDF page is missing "${requiredText}".`);
    }

    assert.match(css, /@page\s*\{\s*size:\s*A4/i, "Print stylesheet must continue to declare A4 page size.");
    assert.match(css, /@page\s+customer-documents[\s\S]*?content:\s*"Page "\s*counter\(page\)\s*" of "\s*counter\(pages\)/i, "Customer quotes, invoices, and delivery notes need page number footers.");
    assert.match(css, /\.customer-quote-document-table thead\s*\{\s*display:\s*table-header-group/i, "Print stylesheet must repeat quote table headings.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

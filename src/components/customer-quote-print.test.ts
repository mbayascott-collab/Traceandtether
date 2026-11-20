import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
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

test("long quote names, addresses, and notes remain visible in the generated PDF", () => {
  const directory = mkdtempSync(join(tmpdir(), "customer-quote-long-text-"));
  const productName = `LONG-PRODUCT-${"A".repeat(110)}`;
  const sku = `LONG-SKU-${"B".repeat(90)}`;
  const address = `LONG-ADDRESS-${"C".repeat(120)}`;
  const notes = `LONG-NOTE-START ${"customer request detail ".repeat(240)} LONG-NOTE-END`;

  try {
    const quote = fixtureQuote();
    quote.deliveryAddress = address;
    quote.notes = notes;
    quote.lines = [
      { ...quote.lines[0]!, id: 1, productName, sku: "SKU-1", quantity: 1, lineTotalZmw: unitPrice },
      { ...quote.lines[0]!, id: 2, productName: "Other item", sku, quantity: 1, lineTotalZmw: unitPrice },
    ];
    quote.totalZmw = "2469.00";
    const cssPath = resolve("src/index.css");
    const htmlPath = join(directory, "long-text-quote.html");
    const pdfPath = join(directory, "long-text-quote.pdf");
    const textPath = join(directory, "long-text-quote.txt");
    const markup = renderToStaticMarkup(
      React.createElement(CustomerQuotePrintDocument, { quote, logoSrc: transparentPixel }),
    );
    writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="${pathToFileURL(cssPath).href}">
      <style>@page { size: A4; } body { margin: 0; }</style></head><body>${markup}</body></html>`);
    execFileSync(findChromium(), [
      "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href,
    ], { stdio: "pipe", timeout: 60_000 });
    execFileSync("pdftotext", ["-layout", pdfPath, textPath], { stdio: "pipe" });

    const extracted = readFileSync(textPath, "utf8");
    const compact = extracted.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const productText = compact.replace("sku1", "");
    const skuText = compact.replace("otheritem", "");
    for (const [value, text] of [
      [productName, productText],
      [sku, skuText],
      [address, compact],
      ["LONG-NOTE-START", compact],
      ["LONG-NOTE-END", compact],
    ]) {
      assert.ok(
        text!.includes(value.replace(/[^a-z0-9]/gi, "").toLowerCase()),
        `Generated PDF omitted long text: ${value.slice(0, 32)}. Extracted around product: ${productText.slice(Math.max(0, productText.indexOf("longproduct") - 20), productText.indexOf("longproduct") + 180)}.`,
      );
    }
    const pages = extracted.split("\f").map((page) => page.trim()).filter(Boolean);
    assert.ok(pages.length > 1, "Long quote notes should flow onto additional PDF pages.");
    const finalPage = pages.at(-1)!.replace(/\s+/g, " ").toLowerCase();
    for (const requiredText of ["Total (ZMW)", "Customer approval", "Name and signature", "Date"]) {
      assert.ok(finalPage.includes(requiredText.toLowerCase()), `Final page should keep ${requiredText} with the quote total.`);
    }
    const css = readFileSync(cssPath, "utf8");
    assert.match(css, /\.customer-quote-document-table td\s*\{[^}]*overflow-wrap:\s*anywhere/i);
    assert.match(css, /\.customer-quote-document-customer p\s*\{[^}]*overflow-wrap:\s*anywhere/i);
    assert.match(css, /\.customer-quote-document-notes p\s*\{[^}]*overflow-wrap:\s*anywhere/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("printing a quote from its row opens a preview for that selected quote", async () => {
  const token = randomUUID();
  const scriptName = `__customer-quote-print-${token}.tsx`;
  const scriptPath = resolve(scriptName);
  const buildDirectory = mkdtempSync(join(tmpdir(), "customer-quote-print-browser-"));

  const quote = {
    id: 802,
    quoteNumber: "QT-E2E-SELECTED",
    customerId: 1,
    customerName: "Selected Quote Customer",
    customerEmail: null,
    status: "draft",
    emailSendStatus: "not_sent",
    emailAttemptedAt: null,
    emailSentAt: null,
    emailSendError: null,
    emailDeliveryEventAt: null,
    createdAt: "2026-11-19T00:00:00.000Z",
    validUntil: null,
    deliveryAddress: null,
    notes: null,
    salesOrderId: null,
    salesOrderNumber: null,
    totalZmw: "75.00",
    lines: [{
      id: 802,
      productId: 802,
      productName: "Selected Quote Product",
      sku: "QT-E2E-PRODUCT",
      quantity: 3,
      unitPriceZmw: "25.00",
      lineTotalZmw: "75.00",
    }],
  };

  try {
    writeFileSync(scriptPath, `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import CustomerQuotesWorkspace from "./src/components/CustomerQuotesWorkspace.tsx";
      const quote = ${JSON.stringify(quote)};
      createRoot(document.getElementById("root")!).render(React.createElement(CustomerQuotesWorkspace));
      window.setTimeout(() => {
        const row = Array.from(document.querySelectorAll("tbody tr"))
          .find((item) => item.textContent?.includes("QT-E2E-SELECTED"));
        const printButton = Array.from(row?.querySelectorAll("button") ?? [])
          .find((button) => button.textContent?.trim() === "Print / Save PDF");
        if (!printButton) {
          document.body.dataset.printResult = "quote-row-or-print-button-missing";
          return;
        }
        printButton.click();
        window.setTimeout(() => {
          const article = document.querySelector("#customer-quote-print");
          document.body.dataset.printResult = [
            article?.querySelector("h1")?.textContent,
            article?.querySelector(".customer-quote-document-customer strong")?.textContent,
            article?.querySelector("tbody td")?.textContent
          ].join("|");
        }, 150);
      }, 350);
    `);
    await build({
      configFile: false,
      root: process.cwd(),
      plugins: [react()],
      build: {
        outDir: buildDirectory,
        emptyOutDir: true,
        assetsInlineLimit: 1024 * 1024,
        lib: { entry: scriptPath, name: "CustomerQuotePrintTest", formats: ["iife"], fileName: "quote-print-test.js" },
      },
    });
    const htmlPath = join(buildDirectory, "index.html");
    writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <div id="root"></div>
      <script>
        const responses = {
          "/api/customers": { customers: [] },
          "/api/products": { products: [], total: 0, page: 1, pageSize: 100 },
          "/api/customer-quotes": { quotes: [${JSON.stringify(quote)}] },
          "/api/customer-quote-email-notices": { events: [] }
        };
        window.fetch = async (input) => {
          const value = typeof input === "string" ? input : input.url;
          const url = new URL(value, location.href);
          return new Response(JSON.stringify(responses[url.pathname] ?? {}), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        };
        window.setInterval = (() => 0);
      </script>
      <script src="./quote-print-test.js"></script>
      </body></html>`);
    const dom = execFileSync(findChromium(), [
      "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-background-networking", "--disable-gcm", "--disable-default-apps", "--no-first-run",
      "--virtual-time-budget=1800", "--dump-dom", pathToFileURL(htmlPath).href,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    assert.match(dom, /data-print-result="QT-E2E-SELECTED\|Selected Quote Customer\|Selected Quote Product"/);
  } finally {
    rmSync(buildDirectory, { recursive: true, force: true });
    rmSync(scriptPath, { force: true });
  }
});

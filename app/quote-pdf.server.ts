// Quote PDF (pdfkit, built-in Helvetica): simple single-column layout with a clear line-item table,
// which document-capture tools such as ApprovalMax Capture read reliably.
import PDFDocument from "pdfkit";
import { SUPPLIER, QUOTE_VALID_DAYS, auDate, type Quote } from "../src/orders/quote.ts";

const money = (n: number) => "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RED = "#e40046";

export function quotePdf(q: Quote): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Quote ${q.number}`, Author: SUPPLIER.name } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 40;
    const right = doc.page.width - 40;
    const width = right - left;

    // Header: supplier on the left, QUOTE + numbers on the right.
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#000").text(SUPPLIER.name, left, 40);
    doc.font("Helvetica").fontSize(9).fillColor("#333");
    doc.text(`ABN ${SUPPLIER.abn}`);
    for (const l of SUPPLIER.address) doc.text(l);
    doc.text(`Phone ${SUPPLIER.phone}`);
    doc.text(SUPPLIER.email);

    doc.font("Helvetica-Bold").fontSize(22).fillColor(RED).text("QUOTE", left, 40, { width, align: "right" });
    doc.font("Helvetica").fontSize(9).fillColor("#000");
    const meta: [string, string][] = [
      ["Quote number", q.number],
      ["Quote date", auDate(q.date)],
      ["Valid until", auDate(q.validUntil)],
    ];
    let y = 70;
    for (const [k, v] of meta) {
      doc.font("Helvetica").text(`${k}:`, right - 200, y, { width: 90, align: "right" });
      doc.font("Helvetica-Bold").text(v, right - 105, y, { width: 105, align: "right" });
      y += 13;
    }

    // Customer and delivery.
    y = Math.max(doc.y, 130) + 14;
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#ccc").stroke();
    y += 10;
    const col = width / 2;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#555").text("QUOTE FOR", left, y);
    doc.text("DELIVER TO", left + col, y);
    doc.font("Helvetica").fontSize(10).fillColor("#000");
    doc.text(q.companyName, left, y + 13, { width: col - 10 });
    doc.text(`Customer code: ${q.customerCode}`, { width: col - 10 });
    doc.text(`Prepared for: ${q.preparedFor}`, { width: col - 10 });
    const leftEnd = doc.y;
    doc.font("Helvetica-Bold").text(q.siteName, left + col, y + 13, { width: col });
    doc.font("Helvetica");
    for (const l of q.deliveryAddress) doc.text(l, { width: col });
    y = Math.max(leftEnd, doc.y) + 16;

    // Line items.
    const cols = [
      { h: "Item code", w: 85, a: "left" as const },
      { h: "Description", w: width - 85 - 45 - 80 - 85, a: "left" as const },
      { h: "Qty", w: 45, a: "right" as const },
      { h: "Unit ex GST", w: 80, a: "right" as const },
      { h: "Amount ex GST", w: 85, a: "right" as const },
    ];
    const row = (cells: string[], bold: boolean) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor("#000");
      let x = left;
      let h = 0;
      cells.forEach((c, i) => {
        h = Math.max(h, doc.heightOfString(c, { width: cols[i]!.w - 6 }));
      });
      if (y + h + 8 > doc.page.height - 90) {
        doc.addPage();
        y = 40;
      }
      cells.forEach((c, i) => {
        doc.text(c, x + 3, y + 4, { width: cols[i]!.w - 6, align: cols[i]!.a });
        x += cols[i]!.w;
      });
      y += h + 8;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(bold ? "#999" : "#e5e5e5").stroke();
    };
    doc.rect(left, y, width, 18).fill("#f2f2f2");
    row(cols.map((c) => c.h), true);
    for (const l of q.lines) row([l.sku, l.description, String(l.quantity), money(l.unitExGst), money(l.lineExGst)], false);

    // Totals.
    y += 10;
    const totals: [string, string, boolean][] = [
      ["Subtotal ex GST", money(q.subtotalExGst), false],
      ["GST", money(q.gst), false],
      ["Total inc GST", money(q.totalIncGst), true],
    ];
    for (const [k, v, b] of totals) {
      doc.font(b ? "Helvetica-Bold" : "Helvetica").fontSize(b ? 11 : 10).fillColor("#000");
      doc.text(k, right - 260, y, { width: 150, align: "right" });
      doc.text(v, right - 105, y, { width: 105, align: "right" });
      y += b ? 16 : 14;
    }

    // Terms.
    y += 18;
    doc.font("Helvetica").fontSize(8.5).fillColor("#444").text(
      `Prices are in AUD and exclude GST unless shown. This quote is valid for ${QUOTE_VALID_DAYS} days, until ${auDate(q.validUntil)}. ` +
        `Please quote ${q.number} on your purchase order. Orders are charged to your account and invoiced on your usual terms. ` +
        `Delivery charges, if any, are not included.`,
      left,
      y,
      { width },
    );
    doc.end();
  });
}

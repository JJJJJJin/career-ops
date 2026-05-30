const { chromium } = require('playwright');

async function generatePDF(htmlPath, pdfPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
    printBackground: true,
  });
  await browser.close();
  console.log('OK: ' + pdfPath);
}

(async () => {
  await generatePDF('/home/jin/.openclaw/workspace/Catapult_AI_Engineer_Resume_EN.html', '/home/jin/.openclaw/workspace/Catapult_AI_Engineer_Resume_EN.pdf');
  await generatePDF('/home/jin/.openclaw/workspace/Catapult_AI_Engineer_Resume_CN.html', '/home/jin/.openclaw/workspace/Catapult_AI_Engineer_Resume_CN.pdf');
  console.log('Done');
})();

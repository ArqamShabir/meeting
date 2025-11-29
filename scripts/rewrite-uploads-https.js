// Rewrite floor-templates.json upload URLs from http://<host>/uploads to https://<host>/uploads
// Usage: npm run migrate:uploads -- [host]   (default host: meeting.multishells.com)

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TEMPLATE_PATH = path.join(DATA_DIR, 'floor-templates.json');
const host = process.argv[2] || 'meeting.multishells.com';

const replaceHttpWithHttps = (url) => {
  if (typeof url !== 'string') return url;
  const pattern = new RegExp(`^http://${host.replace(/\./g, '\\.')}/uploads/`, 'i');
  if (pattern.test(url)) {
    return url.replace(/^http:/i, 'https:');
  }
  return url;
};

const main = () => {
  let templates;
  try {
    templates = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));
  } catch (err) {
    console.error('Could not read floor-templates.json:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(templates)) {
    console.error('floor-templates.json is not an array');
    process.exit(1);
  }

  let changed = 0;
  const updated = templates.map((t) => {
    const next = { ...t };
    const newUrl = replaceHttpWithHttps(t.backgroundImageUrl);
    if (newUrl !== t.backgroundImageUrl) {
      next.backgroundImageUrl = newUrl;
      changed += 1;
    }
    return next;
  });

  if (!changed) {
    console.log('No http://uploads URLs found for host', host);
    return;
  }

  fs.writeFileSync(TEMPLATE_PATH, JSON.stringify(updated, null, 2));
  console.log(`Updated ${changed} template URL(s) to https://${host}/uploads/...`);
};

main();

// `node --test scripts/schema`: Node 24 loads a folder argument as a module, so this file
// runs every suite in test/ (the glob form and a bare `node --test` here don't use it).
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const dir = path.join(__dirname, 'test');
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(path.join(dir, name)).href).catch((err) => { console.error(err); process.exitCode = 1; });
}

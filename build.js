'use strict';

// Produce one self-contained serviceFile: TizenBrew evaluates downloaded
// service scripts in its own VM and does not resolve our relative modules.
var fs = require('fs');
var path = require('path');
var root = __dirname;
var source = fs.readFileSync(path.join(root, 'src', 'service.js'), 'utf8');
var browser = fs.readFileSync(path.join(root, 'src', 'browser-router.js'), 'utf8');
var marker = '/*__BROWSER_ROUTER__*/';
if (source.split(marker).length !== 2) throw new Error('Missing browser marker');
var result = source.replace(marker, JSON.stringify(browser));
var output = path.join(root, 'dist');
if (!fs.existsSync(output)) fs.mkdirSync(output);
fs.writeFileSync(path.join(output, 'service.js'), result, 'utf8');
console.log('Built dist/service.js');

'use strict';

// Produce one self-contained serviceFile and two HTML pages. TizenBrew
// evaluates downloaded service scripts in its own VM and does not resolve
// our relative modules.
var fs = require('fs');
var path = require('path');
var root = __dirname;
var source = fs.readFileSync(path.join(root, 'src', 'service.js'), 'utf8');
var browser = fs.readFileSync(path.join(root, 'src', 'browser-router.js'), 'utf8');
var remote = fs.readFileSync(path.join(root, 'src', 'remote-navigation.js'), 'utf8');
var bootstrap = fs.readFileSync(path.join(root, 'bootstrap.template.html'), 'utf8');
var settings = fs.readFileSync(path.join(root, 'settings-page.template.html'), 'utf8');
function insertOnce(text, marker, replacement) {
  if (text.split(marker).length !== 2) throw new Error('Missing/duplicate marker: ' + marker);
  return text.replace(marker, replacement);
}
if (/<\/script/i.test(remote)) throw new Error('Remote script cannot contain </script');
bootstrap = insertOnce(bootstrap, '/*__REMOTE_NAVIGATION__*/', remote);
settings = insertOnce(settings, '/*__REMOTE_NAVIGATION__*/', remote);
var result = insertOnce(source, '/*__BROWSER_ROUTER__*/', JSON.stringify(browser));
result = insertOnce(result, '/*__SETTINGS_PAGE__*/', JSON.stringify(settings));
var output = path.join(root, 'dist');
if (!fs.existsSync(output)) fs.mkdirSync(output);
fs.writeFileSync(path.join(output, 'service.js'), result, 'utf8');
fs.writeFileSync(path.join(root, 'bootstrap.html'), bootstrap, 'utf8');
console.log('Built dist/service.js and bootstrap.html');

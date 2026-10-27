'use strict';

// Self-contained Node 4 compatible source. build.js embeds the browser script
// and emits dist/service.js for TizenBrew's serviceFile VM.
var http = require('http');
var https = require('https');
var net = require('net');
var tls = require('tls');
var url = require('url');
var zlib = require('zlib');
var crypto = require('crypto');
var BROWSER_ROUTER = /*__BROWSER_ROUTER__*/;
var DEFAULT_PORT = 8113;
var DEFAULT_SETTINGS_PORT = 8114;
var MAX_TEXT = 16 * 1024 * 1024;

// Node 4.4.3 in older TizenBrew lacks Buffer.from/alloc and WHATWG URL.
// Modern Node takes the non-deprecated branches; TV keeps the legacy branch.
function bytes(value, encoding) {
  return typeof Buffer.from === 'function' ?
    Buffer.from(value, encoding) : new Buffer(value, encoding);
}

function emptyBytes() {
  return typeof Buffer.alloc === 'function' ? Buffer.alloc(0) : new Buffer(0);
}

function parseUrl(value) {
  var parsed;
  if (typeof URL !== 'function') return url.parse(value);
  try {
    parsed = new URL(value, 'http://127.0.0.1');
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      auth: parsed.username || parsed.password ? true : null,
      pathname: parsed.pathname,
      search: parsed.search,
      path: parsed.pathname + parsed.search
    };
  } catch (ignored) {
    return { protocol: null, hostname: null, port: null,
      auth: null, pathname: '', search: '', path: '' };
  }
}

var DOMAINS = [
  'youtube.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com',
  'gstatic.com', 'googleapis.com', 'youtube-nocookie.com',
  'clients1.google.com', 'yt3.googleusercontent.com'
];

function allowedHost(host) {
  var value = String(host || '').toLowerCase();
  var i;
  if (!/^[a-z0-9.-]+$/.test(value) || value.length > 253) return false;
  for (i = 0; i < DOMAINS.length; i += 1) {
    if (value === DOMAINS[i] ||
        value.slice(-(DOMAINS[i].length + 1)) === '.' + DOMAINS[i]) {
      return true;
    }
  }
  return false;
}

function safeError(code) {
  var error = new Error(code);
  error.code = code;
  return error;
}

function validateProxy(value) {
  var proxy;
  if (!value || value.enabled !== true) return null;
  proxy = {
    type: String(value.type || '').toLowerCase(),
    host: String(value.host || '').trim(),
    port: Number(value.port),
    username: String(value.username || ''),
    password: String(value.password || '')
  };
  if (proxy.type !== 'http' && proxy.type !== 'socks5') {
    throw safeError('INVALID_PROXY_TYPE');
  }
  if (!/^[a-zA-Z0-9.:-]+$/.test(proxy.host) ||
      proxy.host.length > 253 || proxy.host.indexOf(':') >= 0) {
    throw safeError('INVALID_PROXY_HOST');
  }
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
    throw safeError('INVALID_PROXY_PORT');
  }
  if (Buffer.byteLength(proxy.username, 'utf8') > 255 ||
      Buffer.byteLength(proxy.password, 'utf8') > 255) {
    throw safeError('PROXY_CREDENTIALS_TOO_LONG');
  }
  if (proxy.password && !proxy.username) {
    throw safeError('PROXY_USERNAME_REQUIRED');
  }
  return proxy;
}

function connectProxySocket(proxy, callback) {
  var socket = net.connect(proxy.port, proxy.host);
  var finished = false;
  function finish(error, connected) {
    if (finished) return;
    finished = true;
    socket.removeListener('error', onError);
    socket.removeListener('timeout', onTimeout);
    socket.removeListener('close', onClose);
    if (error) socket.destroy();
    else socket.setTimeout(0);
    callback(error, connected);
  }
  function onError() { finish(safeError('PROXY_CONNECT_FAILED')); }
  function onTimeout() { finish(safeError('PROXY_TIMEOUT')); }
  function onClose() { finish(safeError('PROXY_EOF')); }
  socket.setTimeout(10000);
  socket.once('error', onError);
  socket.once('timeout', onTimeout);
  socket.once('close', onClose);
  socket.once('connect', function () { finish(null, socket); });
}

function openHttpTunnel(proxy, targetHost, targetPort, callback) {
  connectProxySocket(proxy, function (error, socket) {
    var data = emptyBytes();
    var authority;
    var request;
    var done = false;
    if (error) return callback(error);
    authority = targetHost + ':' + targetPort;
    request = 'CONNECT ' + authority + ' HTTP/1.1\r\n' +
      'Host: ' + authority + '\r\n';
    if (proxy.username) {
      request += 'Proxy-Authorization: Basic ' +
        bytes(proxy.username + ':' + proxy.password, 'utf8')
          .toString('base64') + '\r\n';
    }
    request += '\r\n';
    function finish(failure) {
      if (done) return;
      done = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onEnd);
      if (failure) {
        socket.destroy();
        callback(failure);
      } else {
        socket.pause();
        socket.setTimeout(0);
        if (data.length) socket.unshift(data);
        callback(null, socket);
      }
    }
    function onError() { finish(safeError('HTTP_PROXY_FAILED')); }
    function onTimeout() { finish(safeError('HTTP_PROXY_TIMEOUT')); }
    function onEnd() { finish(safeError('HTTP_PROXY_EOF')); }
    function onData(chunk) {
      var end;
      var head;
      var status;
      data = Buffer.concat([data, chunk]);
      if (data.length > 16384) return finish(safeError('HTTP_PROXY_HEADER_TOO_LARGE'));
      end = data.indexOf('\r\n\r\n');
      if (end < 0) return;
      head = data.slice(0, end).toString('latin1');
      data = data.slice(end + 4);
      status = /^HTTP\/1\.[01] ([0-9]{3})\b/.exec(head);
      if (status && Number(status[1]) === 407) {
        return finish(safeError('HTTP_PROXY_AUTH_REJECTED'));
      }
      if (!status || Number(status[1]) < 200 || Number(status[1]) > 299) {
        return finish(safeError('HTTP_PROXY_CONNECT_REJECTED'));
      }
      finish(null);
    }
    socket.setTimeout(10000);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.write(request);
  });
}

function openSocksTunnel(proxy, targetHost, targetPort, callback) {
  connectProxySocket(proxy, function (error, socket) {
    var buffer = emptyBytes();
    var wanted = 0;
    var reader = null;
    var done = false;
    var username;
    var password;
    var hostBytes;
    if (error) return callback(error);
    username = bytes(proxy.username, 'utf8');
    password = bytes(proxy.password, 'utf8');
    hostBytes = bytes(targetHost, 'ascii');
    if (hostBytes.length > 255) return finish(safeError('SOCKS_HOST_TOO_LONG'));

    function finish(failure) {
      if (done) return;
      done = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onEnd);
      if (failure) {
        socket.destroy();
        callback(failure);
      } else {
        socket.pause();
        socket.setTimeout(0);
        if (buffer.length) socket.unshift(buffer);
        callback(null, socket);
      }
    }
    function onError() { finish(safeError('SOCKS_FAILED')); }
    function onTimeout() { finish(safeError('SOCKS_TIMEOUT')); }
    function onEnd() { finish(safeError('SOCKS_EOF')); }
    function read(count, next) {
      wanted = count;
      reader = next;
      pump();
    }
    function pump() {
      var part;
      var next;
      if (!reader || buffer.length < wanted || done) return;
      part = buffer.slice(0, wanted);
      buffer = buffer.slice(wanted);
      next = reader;
      reader = null;
      next(part);
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65536) return finish(safeError('SOCKS_REPLY_TOO_LARGE'));
      pump();
    }
    function sendConnect() {
      var packet = Buffer.concat([
        bytes([5, 1, 0, 3, hostBytes.length]),
        hostBytes,
        bytes([(targetPort >> 8) & 255, targetPort & 255])
      ]);
      socket.write(packet);
      read(4, function (reply) {
        if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) {
          return finish(safeError('SOCKS_CONNECT_REJECTED'));
        }
        if (reply[3] === 1) return read(6, function () { finish(null); });
        if (reply[3] === 4) return read(18, function () { finish(null); });
        if (reply[3] === 3) {
          return read(1, function (length) {
            read(length[0] + 2, function () { finish(null); });
          });
        }
        finish(safeError('SOCKS_BAD_ADDRESS'));
      });
    }
    socket.setTimeout(10000);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.write(bytes(username.length ? [5, 1, 2] : [5, 1, 0]));
    read(2, function (choice) {
      if (choice[0] !== 5) return finish(safeError('SOCKS_BAD_VERSION'));
      if (username.length) {
        if (choice[1] !== 2) return finish(safeError('SOCKS_AUTH_REQUIRED'));
        socket.write(Buffer.concat([
          bytes([1, username.length]), username,
          bytes([password.length]), password
        ]));
        return read(2, function (auth) {
          if (auth[0] !== 1 || auth[1] !== 0) {
            return finish(safeError('SOCKS_AUTH_FAILED'));
          }
          sendConnect();
        });
      }
      if (choice[1] !== 0) return finish(safeError('SOCKS_NOAUTH_REJECTED'));
      sendConnect();
    });
  });
}

function openTunnel(proxy, targetHost, targetPort, callback) {
  if (!proxy) return callback(safeError('PROXY_NOT_CONFIGURED'));
  if (proxy.type === 'http') {
    openHttpTunnel(proxy, targetHost, targetPort, callback);
  } else if (proxy.type === 'socks5') {
    openSocksTunnel(proxy, targetHost, targetPort, callback);
  } else {
    callback(safeError('INVALID_PROXY_TYPE'));
  }
}

function openVerifiedTls(socket, hostname, ca, callback) {
  var options = { socket: socket, servername: hostname, rejectUnauthorized: true };
  var secure;
  var done = false;
  if (ca) options.ca = ca; // Test CA injection; verification remains enabled.
  secure = tls.connect(options);
  function finish(error) {
    if (done) return;
    done = true;
    // Keep the one-shot listener after secureConnect until ClientRequest has
    // attached its own error handler on a later tick (Node 4 behavior).
    if (error) secure.removeListener('error', onError);
    secure.removeListener('timeout', onTimeout);
    secure.removeListener('close', onClose);
    secure.setTimeout(0);
    if (error) secure.destroy();
    callback(error, error ? null : secure);
  }
  function onError() { finish(safeError('TLS_VERIFICATION_FAILED')); }
  function onTimeout() { finish(safeError('TLS_HANDSHAKE_TIMEOUT')); }
  function onClose() { finish(safeError('TLS_EOF')); }
  secure.setTimeout(10000);
  secure.once('error', onError);
  secure.once('timeout', onTimeout);
  secure.once('close', onClose);
  secure.once('secureConnect', function () {
    if (!secure.authorized) return finish(safeError('TLS_VERIFICATION_FAILED'));
    finish(null);
  });
}

function openOriginRequest(proxy, target, method, headers, ca, onResponse, onError) {
  var parsed = parseUrl(target);
  var host = parsed.hostname;
  var request;
  var cancelled = false;
  var socket = null;
  var wrapper = {
    writeFrom: function (incoming) {
      wrapper.incoming = incoming;
      if (request) incoming.pipe(request);
    },
    abort: function () {
      cancelled = true;
      if (request) request.abort();
      if (socket) socket.destroy();
    }
  };
  if (parsed.protocol !== 'https:' || !allowedHost(host) ||
      (parsed.port && parsed.port !== '443') || parsed.auth) {
    process.nextTick(function () { onError(safeError('TARGET_NOT_ALLOWED')); });
    return wrapper;
  }
  openTunnel(proxy, host, 443, function (error, tunnel) {
    if (error) return onError(error);
    if (cancelled) return tunnel.destroy();
    socket = tunnel;
    openVerifiedTls(tunnel, host, ca, function (tlsError, secure) {
      if (tlsError) return onError(tlsError);
      if (cancelled) return secure.destroy();
      socket = secure;
      secure.setTimeout(120000, function () {
        secure.destroy(safeError('ORIGIN_IDLE_TIMEOUT'));
      });
      request = https.request({
        protocol: 'https:', hostname: host, port: 443,
        path: parsed.path || '/', method: method, headers: headers,
        agent: null, createConnection: function () { return secure; }
      }, onResponse);
      request.once('error', function () { onError(safeError('ORIGIN_REQUEST_FAILED')); });
      if (wrapper.incoming) wrapper.incoming.pipe(request);
      else request.end();
    });
  });
  return wrapper;
}

function routeTarget(pathname, rawUrl) {
  var match;
  var targetHost;
  var parsed = parseUrl(rawUrl);
  if (pathname.indexOf('/p/') === 0) {
    match = /^\/p\/([a-zA-Z0-9.-]+)(\/.*)?$/.exec(pathname);
    if (!match || !allowedHost(match[1])) return null;
    targetHost = match[1].toLowerCase();
    return 'https://' + targetHost + (match[2] || '/') +
      (parsed.search || '');
  }
  if (pathname === '/health' || pathname === '/client.js' ||
      pathname === '/api/config' || pathname === '/api/test') return null;
  return 'https://www.youtube.com' + pathname + (parsed.search || '');
}

function localUrl(target, port) {
  var parsed = parseUrl(target);
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      !allowedHost(parsed.hostname) ||
      (parsed.port && parsed.port !== '443') || parsed.auth) return null;
  return 'http://127.0.0.1:' + port + '/p/' +
    parsed.hostname.toLowerCase() + (parsed.path || '/');
}

function rewriteText(value, port) {
  var base = 'http://127.0.0.1:' + port + '/p/';
  var text = value.replace(/https?:\/\/([a-zA-Z0-9.-]+)/g,
    function (all, host) {
      return allowedHost(host) ? base + host.toLowerCase() : all;
    });
  text = text.replace(/https?:\\\/\\\/([a-zA-Z0-9.-]+)/g,
    function (all, host) {
      return allowedHost(host) ?
        'http:\\/\\/127.0.0.1:' + port + '\\/p\\/' + host.toLowerCase() : all;
    });
  text = text.replace(/(["'(])\/\/([a-zA-Z0-9.-]+)(?=\/)/g,
    function (all, quote, host) {
      return allowedHost(host) ? quote + base + host.toLowerCase() : all;
    });
  return text;
}

function copyRequestHeaders(incoming, targetHost) {
  var result = {};
  var forbidden = {
    host: true, connection: true, 'proxy-connection': true,
    'proxy-authorization': true, 'transfer-encoding': true,
    'accept-encoding': true, origin: true, referer: true,
    cookie: true, authorization: true
  };
  Object.keys(incoming).forEach(function (key) {
    if (!forbidden[key]) result[key] = incoming[key];
  });
  result.host = targetHost;
  result.origin = 'https://www.youtube.com';
  result.referer = 'https://www.youtube.com/tv';
  result['accept-encoding'] = 'identity';
  result.connection = 'close';
  return result;
}

function sendJson(response, status, value, extraHeaders) {
  var body = JSON.stringify(value);
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  };
  if (extraHeaders) Object.keys(extraHeaders).forEach(function (key) {
    headers[key] = extraHeaders[key];
  });
  response.writeHead(status, headers);
  response.end(body);
}

function decodeLimited(input, encoding, callback) {
  var decoder;
  var chunks = [];
  var length = 0;
  var finished = false;
  if (encoding === 'identity') return callback(null, input);
  if (encoding === 'gzip') decoder = zlib.createGunzip();
  else if (encoding === 'deflate') decoder = zlib.createInflate();
  else return callback(safeError('UNSUPPORTED_ENCODING'));
  function finish(error, body) {
    if (finished) return;
    finished = true;
    callback(error, body);
  }
  decoder.on('data', function (chunk) {
    if (finished) return;
    length += chunk.length;
    if (length > MAX_TEXT) {
      finish(safeError('DECODED_TEXT_TOO_LARGE'));
      decoder.close(); // zlib streams have close() on Node 4, not destroy().
      return;
    }
    chunks.push(chunk);
  });
  decoder.once('error', function () {
    finish(safeError('TEXT_DECODE_FAILED'));
  });
  decoder.once('end', function () {
    finish(null, Buffer.concat(chunks));
  });
  decoder.end(input);
}

function readJson(request, callback) {
  var chunks = [];
  var size = 0;
  var finished = false;
  request.on('data', function (chunk) {
    if (finished) return;
    size += chunk.length;
    if (size > 4096) {
      finished = true;
      callback(safeError('CONFIG_TOO_LARGE'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', function () {
    if (finished) return;
    finished = true;
    try { callback(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (ignored) { callback(safeError('INVALID_JSON')); }
  });
  request.on('error', function () {
    if (!finished) {
      finished = true;
      callback(safeError('CONFIG_READ_FAILED'));
    }
  });
}

function settingsHtml(token, configured, stats, relayPort) {
  var status = configured ? 'Прокси включён в памяти сервиса.' :
    'Прокси не настроен. YouTube не будет открыт напрямую.';
  return '<!doctype html><html lang="ru"><meta charset="utf-8">' +
    '<title>YouTube Proxy</title><style>body{background:#111;color:#eee;' +
    'font:24px sans-serif;margin:5vw;max-width:48em}input,select,button{' +
    'font:inherit;margin:8px;padding:10px}label{display:block}small{color:#aaa}' +
    '</style><h1>YouTube Proxy — прототип</h1><p id="state">' + status +
    '</p><p>Туннелей: ' + stats.tunnels + ', ответов 206: ' +
    stats.partialResponses + ', ошибок: ' + stats.upstreamErrors +
    ', заблокировано: ' + stats.blockedRequests + '</p>' +
    '<p>googlevideo: запросов ' + stats.videoRequests +
    ', Range ' + stats.videoRangeRequests + ', ответов 206 ' +
    stats.videoPartialResponses + ', байтов ' + stats.videoBytes +
    ' <button onclick="location.reload()">Обновить</button></p>' +
    '<p><small>Пока не входите в аккаунт. ' +
    'Реквизиты хранятся только в памяти, до остановки TizenBrew.</small></p>' +
    '<p><small>HTTP CONNECT Basic и SOCKS5 с паролем не шифруют ' +
    'реквизиты на участке до внешнего прокси.</small></p>' +
    '<label>Тип <select id="type"><option value="http">HTTP CONNECT' +
    '</option><option value="socks5">SOCKS5</option></select></label>' +
    '<label>Адрес <input id="host" autocomplete="off"></label>' +
    '<label>Порт <input id="port" type="number" min="1" max="65535"></label>' +
    '<label>Логин <input id="username" autocomplete="off" ' +
    'autocapitalize="none" spellcheck="false"></label>' +
    '<label>Пароль <input id="password" type="password" ' +
    'autocomplete="off" autocapitalize="none" ' +
    'spellcheck="false"></label>' +
    '<p><button id="enable">Включить</button><button id="disable">Выключить' +
    '</button><button id="test">Проверить</button></p>' +
    '<p><a href="http://127.0.0.1:' + relayPort +
    '/tv">Открыть YouTube TV</a></p>' +
    '<script>(function(){var token=' + JSON.stringify(token) +
    ';function post(path,payload){var x=new XMLHttpRequest();x.open("POST",path,true);' +
    'x.setRequestHeader("Content-Type","application/json");' +
    'x.setRequestHeader("X-Prototype-Token",token);x.onload=function(){' +
    'document.getElementById("state").textContent=x.responseText;' +
    'document.getElementById("password").value="";};' +
    'x.onerror=function(){document.getElementById("state").textContent=' +
    '"Ошибка соединения";};x.send(JSON.stringify(payload));}' +
    'document.getElementById("enable").onclick=function(){post("/api/config",' +
    '{enabled:true,type:document.getElementById("type").value,' +
    'host:document.getElementById("host").value,port:document.getElementById("port").value,' +
    'username:document.getElementById("username").value,' +
    'password:document.getElementById("password").value});};' +
    'document.getElementById("disable").onclick=function(){post("/api/config",{enabled:false});};' +
    'document.getElementById("test").onclick=function(){post("/api/test",{});};' +
    '}());</script></html>';
}

function createService(options) {
  options = options || {};
  var port = options.port || DEFAULT_PORT;
  var settingsPort = options.settingsPort || DEFAULT_SETTINGS_PORT;
  var state = {
    proxy: options.proxy ? validateProxy(options.proxy) : null,
    token: crypto.randomBytes(24).toString('hex'),
    stats: { tunnels: 0, partialResponses: 0, rangeRequests: 0,
      videoRequests: 0, videoRangeRequests: 0, videoPartialResponses: 0,
      videoBytes: 0, blockedRequests: 0, upstreamErrors: 0 }
  };
  var server;
  var settingsServer;

  function authorized(request) {
    return request.headers['x-prototype-token'] === state.token &&
      (!request.headers.origin ||
       request.headers.origin === 'http://127.0.0.1:' + settingsPort);
  }

  function relay(request, response, target) {
    var parsed = parseUrl(target);
    var host = parsed.hostname;
    var isVideoHost = host === 'googlevideo.com' ||
      String(host || '').slice(-16) === '.googlevideo.com';
    var header = copyRequestHeaders(request.headers, host);
    var responseStarted = false;
    var transport;
    if (!state.proxy) {
      state.stats.blockedRequests += 1;
      return sendJson(response, 503, { error: 'PROXY_NOT_CONFIGURED' });
    }
    if (request.headers.range) state.stats.rangeRequests += 1;
    if (isVideoHost) {
      state.stats.videoRequests += 1;
      if (request.headers.range) state.stats.videoRangeRequests += 1;
    }
    transport = openOriginRequest(state.proxy, target, request.method,
      header, options.ca, function (upstream) {
        var contentType = String(upstream.headers['content-type'] || '');
        var isText = /^(text\/|application\/(javascript|json|x-javascript|xml)|image\/svg\+xml)/i
          .test(contentType);
        var headers = {};
        var chunks = [];
        var length = 0;
        var location;
        var upstreamEnded = false;
        function failStream() {
          if (upstreamEnded || response.destroyed) return;
          state.stats.upstreamErrors += 1;
          if (!responseStarted && !response.headersSent) {
            responseStarted = true;
            sendJson(response, 502, { error: 'ORIGIN_STREAM_FAILED' });
          } else response.destroy();
        }
        upstream.once('end', function () { upstreamEnded = true; });
        upstream.once('error', failStream);
        upstream.once('aborted', failStream);
        upstream.once('close', failStream);
        Object.keys(upstream.headers).forEach(function (key) {
          if (key !== 'connection' && key !== 'transfer-encoding' &&
              key !== 'set-cookie' && key !== 'content-security-policy' &&
              key !== 'content-security-policy-report-only' &&
              key !== 'x-frame-options' && key !== 'alt-svc' &&
              key !== 'link' && key !== 'refresh' &&
              key !== 'report-to' && key !== 'nel' &&
              key !== 'strict-transport-security') {
            headers[key] = upstream.headers[key];
          }
        });
        if (/text\/html/i.test(contentType)) {
          // The document must fail closed if any URL escaped our rewrites.
          // No external browser resource is authorized by this CSP.
          headers['content-security-policy'] =
            "default-src 'self' data: blob:; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
            "style-src 'self' 'unsafe-inline' data: blob:; " +
            "img-src 'self' data: blob:; media-src 'self' data: blob:; " +
            "connect-src 'self'; font-src 'self' data:; frame-src 'self'";
        }
        location = headers.location;
        if (location && (/^https?:\/\//i.test(location) ||
            location.indexOf('//') === 0)) {
          if (location.indexOf('//') === 0) location = 'https:' + location;
          location = localUrl(location, port);
          if (!location) {
            upstreamEnded = true;
            responseStarted = true;
            upstream.destroy();
            return sendJson(response, 502, { error: 'REDIRECT_NOT_ALLOWED' });
          }
          headers.location = location;
        }
        if (upstream.statusCode === 206) {
          state.stats.partialResponses += 1;
          if (isVideoHost) state.stats.videoPartialResponses += 1;
        }
        if (!isText || request.method === 'HEAD' ||
            upstream.statusCode === 206 || upstream.statusCode === 416 ||
            upstream.statusCode === 204 || upstream.statusCode === 304) {
          responseStarted = true;
          response.writeHead(upstream.statusCode, headers);
          if (isVideoHost && !isText &&
              (upstream.statusCode === 200 || upstream.statusCode === 206)) {
            upstream.on('data', function (chunk) {
              state.stats.videoBytes += chunk.length;
            });
          }
          upstream.pipe(response);
          return;
        }
        upstream.on('data', function (chunk) {
          length += chunk.length;
          if (length > MAX_TEXT) {
            upstreamEnded = true;
            responseStarted = true;
            upstream.destroy();
            sendJson(response, 502, { error: 'TEXT_RESPONSE_TOO_LARGE' });
            return;
          }
          chunks.push(chunk);
        });
        upstream.on('end', function () {
          var encoded = Buffer.concat(chunks);
          var encoding = String(upstream.headers['content-encoding'] || 'identity');
          function finish(error, decoded) {
            var body;
            var text;
            if (responseStarted) return;
            if (error) {
              responseStarted = true;
              return sendJson(response, 502,
                { error: error.code || 'TEXT_DECODE_FAILED' });
            }
            text = rewriteText(decoded.toString('utf8'), port);
            if (/text\/html/i.test(contentType)) {
              if (/<head\b[^>]*>/i.test(text)) {
                text = text.replace(/<head\b[^>]*>/i, function (match) {
                  return match + '<script src="/client.js"></script>';
                });
              } else {
                text = '<script src="/client.js"></script>' + text;
              }
            }
            body = bytes(text, 'utf8');
            delete headers['content-encoding'];
            delete headers.etag;
            headers['content-length'] = body.length;
            headers['cache-control'] = 'no-store';
            responseStarted = true;
            response.writeHead(upstream.statusCode, headers);
            response.end(body);
          }
          decodeLimited(encoded, encoding, finish);
        });
      }, function (error) {
        state.stats.upstreamErrors += 1;
        if (!responseStarted && !response.headersSent) {
          responseStarted = true;
          sendJson(response, 502, { error: error.code || 'UPSTREAM_FAILED' });
        } else response.destroy();
      });
    state.stats.tunnels += 1;
    transport.writeFrom(request);
    response.on('close', function () { transport.abort(); });
  }

  server = http.createServer(function (request, response) {
    var parsed = parseUrl(request.url || '/');
    var pathname = parsed.pathname || '/';
    var target;
    var host = String(request.headers.host || '').toLowerCase();
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) {
      return sendJson(response, 400, { error: 'LOCAL_HOST_REQUIRED' });
    }
    if (pathname === '/health' && request.method === 'GET') {
      return sendJson(response, 200, {
        ready: true, configured: !!state.proxy, stats: state.stats
      }, { 'Access-Control-Allow-Origin': 'http://127.0.0.1:8081' });
    }
    if (pathname === '/' && request.method === 'GET') {
      response.writeHead(302, {
        Location: 'http://127.0.0.1:' + settingsPort + '/',
        'Cache-Control': 'no-store'
      });
      return response.end();
    }
    if (pathname === '/client.js' && request.method === 'GET') {
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(BROWSER_ROUTER),
        'Cache-Control': 'no-store'
      });
      return response.end(BROWSER_ROUTER);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' &&
        request.method !== 'POST') {
      return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    target = routeTarget(pathname, request.url);
    if (!target) return sendJson(response, 404, { error: 'ROUTE_NOT_FOUND' });
    relay(request, response, target);
  });
  settingsServer = http.createServer(function (request, response) {
    var parsed = parseUrl(request.url || '/');
    var pathname = parsed.pathname || '/';
    var html;
    var host = String(request.headers.host || '').toLowerCase();
    var target;
    if (host !== '127.0.0.1:' + settingsPort &&
        host !== 'localhost:' + settingsPort) {
      return sendJson(response, 400, { error: 'LOCAL_HOST_REQUIRED' });
    }
    if (pathname === '/' && request.method === 'GET') {
      html = settingsHtml(state.token, !!state.proxy, state.stats, port);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; " +
          "script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
          "connect-src 'self'"
      });
      return response.end(html);
    }
    if (pathname === '/api/config' && request.method === 'POST') {
      if (!authorized(request)) return sendJson(response, 403, { error: 'FORBIDDEN' });
      return readJson(request, function (error, body) {
        if (error) return sendJson(response, 400, { error: error.code });
        try { state.proxy = validateProxy(body); }
        catch (failure) { return sendJson(response, 400, { error: failure.code }); }
        sendJson(response, 200, { enabled: !!state.proxy });
      });
    }
    if (pathname === '/api/test' && request.method === 'POST') {
      if (!authorized(request)) return sendJson(response, 403, { error: 'FORBIDDEN' });
      if (!state.proxy) return sendJson(response, 503,
        { error: 'PROXY_NOT_CONFIGURED' });
      target = openOriginRequest(state.proxy,
        'https://www.youtube.com/generate_204', 'HEAD',
        { host: 'www.youtube.com', connection: 'close' }, options.ca,
        function (upstream) {
          upstream.resume();
          sendJson(response, 200, { reachable: true, status: upstream.statusCode });
        }, function (failure) {
          sendJson(response, 502, { reachable: false, error: failure.code });
        });
      return target;
    }
    sendJson(response, 404, { error: 'ROUTE_NOT_FOUND' });
  });
  server.on('error', function (error) {
    state.startError = error.code || 'RELAY_LISTEN_FAILED';
  });
  settingsServer.on('error', function (error) {
    state.startError = error.code || 'SETTINGS_LISTEN_FAILED';
  });
  return {
    server: server,
    settingsServer: settingsServer,
    state: state,
    listen: function (callback) {
      settingsServer.listen(settingsPort, '127.0.0.1', function () {
        server.listen(port, '127.0.0.1', callback);
      });
    },
    close: function (callback) {
      server.close(function () { settingsServer.close(callback); });
    }
  };
}

module.exports = {
  createService: createService,
  validateProxy: validateProxy,
  openTunnel: openTunnel,
  openVerifiedTls: openVerifiedTls,
  openOriginRequest: openOriginRequest,
  allowedHost: allowedHost,
  rewriteText: rewriteText,
  routeTarget: routeTarget,
  localUrl: localUrl
};

// TizenBrew evaluates serviceFile with a fresh {exports:{}} module object and
// does not call any exported hook. Local tests require() this file, so do not
// start the listener in that case.
if (!module.parent) {
  module.exports.instance = createService();
  module.exports.instance.listen();
}

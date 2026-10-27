(function () {
  'use strict';

  // Runs on the local YouTube page. The server also rewrites URL literals in
  // text responses; this catches URLs built dynamically by page JavaScript.
  var localBase = 'http://127.0.0.1:8113';
  var originalFetch = window.fetch;
  var allowed = [
    'youtube.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com',
    'gstatic.com', 'googleapis.com', 'youtube-nocookie.com',
    'clients1.google.com', 'yt3.googleusercontent.com'
  ];

  function allowedHost(host) {
    host = String(host || '').toLowerCase();
    for (var i = 0; i < allowed.length; i += 1) {
      if (host === allowed[i] ||
          host.slice(-(allowed[i].length + 1)) === '.' + allowed[i]) {
        return true;
      }
    }
    return false;
  }

  function route(value) {
    var text = String(value);
    var parser;
    if (text.indexOf('https://') !== 0 &&
        text.indexOf('http://') !== 0 && text.indexOf('//') !== 0) {
      return text;
    }
    parser = document.createElement('a');
    parser.href = text.indexOf('//') === 0 ? 'https:' + text : text;
    if (parser.protocol === 'http:' && parser.hostname === '127.0.0.1' &&
        parser.port === '8113') return text;
    if ((parser.protocol !== 'https:' && parser.protocol !== 'http:') ||
        !allowedHost(parser.hostname)) return null;
    return localBase + '/p/' + parser.hostname.toLowerCase() +
      (parser.pathname || '/') + parser.search + parser.hash;
  }

  function copyRequestOptions(input, init) {
    var options = {
      method: (init && init.method) || input.method,
      headers: (init && init.headers) || input.headers,
      credentials: (init && init.credentials) || input.credentials,
      mode: (init && init.mode) || input.mode,
      cache: (init && init.cache) || input.cache,
      redirect: (init && init.redirect) || input.redirect
    };
    return options;
  }

  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var target = route(input instanceof Request ? input.url : input);
      var method;
      var options;
      if (target === null) {
        return Promise.reject(new Error('EXTERNAL_URL_BLOCKED'));
      }
      if (!(input instanceof Request)) {
        return originalFetch.call(this, target, init);
      }
      if (target === input.url) return originalFetch.call(this, input, init);

      options = copyRequestOptions(input, init);
      method = String(options.method || 'GET').toUpperCase();
      if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
        options.body = init.body;
        return originalFetch.call(this, target, options);
      }
      if (method === 'GET' || method === 'HEAD') {
        return originalFetch.call(this, target, options);
      }
      if (input.bodyUsed) {
        return Promise.reject(new TypeError('Request body already consumed'));
      }

      // Chromium M63 on Tizen can expose Request.body as undefined even when
      // the request contains bytes. clone().arrayBuffer() preserves them.
      return input.clone().arrayBuffer().then(function (buffer) {
        if (buffer.byteLength > 0) options.body = buffer;
        return originalFetch.call(window, target, options);
      });
    };
  }

  if (window.XMLHttpRequest) {
    var originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, async, user, pass) {
      var target = route(url);
      if (target === null) throw new Error('EXTERNAL_URL_BLOCKED');
      return originalOpen.call(this, method, target, async, user, pass);
    };
  }

  var originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var lower = String(name).toLowerCase();
    if (lower === 'src' || lower === 'poster') {
      value = route(value);
      if (value === null) value = 'about:blank';
    }
    return originalSetAttribute.call(this, name, value);
  };

  function patchSourceProperty(type) {
    if (!type || !type.prototype) return;
    var original = Object.getOwnPropertyDescriptor(type.prototype, 'src');
    if (!original || !original.configurable || !original.set) return;
    Object.defineProperty(type.prototype, 'src', {
      configurable: true,
      enumerable: original.enumerable,
      get: original.get,
      set: function (value) {
        var target = route(value);
        original.set.call(this, target === null ? 'about:blank' : target);
      }
    });
  }
  patchSourceProperty(window.HTMLImageElement);
  patchSourceProperty(window.HTMLScriptElement);
  patchSourceProperty(window.HTMLMediaElement);
  patchSourceProperty(window.HTMLSourceElement);
}());

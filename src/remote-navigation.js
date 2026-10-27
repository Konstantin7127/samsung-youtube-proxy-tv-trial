(function (global) {
  'use strict';

  // ES5 only: the 2019 TV uses an older Chromium engine. Nothing entered in
  // text fields is copied into diagnostics or a persistent store.
  function createRemoteNavigation(options) {
    var ids = options.ids;
    var items = [];
    var index = 0;
    var count = 0;
    var seconds = 0;
    var editing = null;
    var lastKey = '—';
    var lastEvent = null;
    var i;

    function element(id) { return document.getElementById(id); }
    function text(id, value) {
      var target = element(id);
      if (target) target.textContent = value;
    }
    function keyName(code) {
      if (code === 37) return 'Влево';
      if (code === 38) return 'Вверх';
      if (code === 39) return 'Вправо';
      if (code === 40) return 'Вниз';
      if (code === 13) return 'OK';
      if (code === 10009 || code === 27) return 'Back';
      if (code === 65376) return 'IME: готово';
      if (code === 65385) return 'IME: отмена';
      return 'Другая/IME'; // Never show characters typed into credentials.
    }
    function showFocus() {
      text('focus-status', editing ? 'Ввод: ' + editing.getAttribute('data-label') :
        'Выбрано: ' + (items[index].getAttribute('data-label') || ids[index]));
    }
    function select(next) {
      if (next < 0) next = items.length - 1;
      if (next >= items.length) next = 0;
      index = next;
      for (var j = 0; j < items.length; j += 1) {
        if (j === index) {
          items[j].classList.add('selected');
          items[j].setAttribute('aria-current', 'true');
        } else {
          items[j].classList.remove('selected');
          items[j].removeAttribute('aria-current');
        }
      }
      if (!editing) items[index].focus();
      showFocus();
    }
    function beginEdit(id) {
      var field = element(id);
      if (!field) return;
      editing = field;
      field.focus(); // Samsung IME opens when an input receives focus.
      if (document.activeElement !== field) {
        editing = null;
        text('input-status', 'Фокус поля не получен; клавиатура недоступна.');
        select(index);
      } else {
        text('input-status', 'Поле активно. Завершите ввод кнопкой «Готово» или Back.');
        showFocus();
      }
    }
    function finishEdit() {
      if (!editing) return;
      var field = editing;
      editing = null;
      field.blur();
      text('input-status', 'Ввод завершён. Значения не показаны в диагностике.');
      global.setTimeout(function () { select(index); }, 0);
    }
    function keydown(event) {
      if (lastEvent === event) return; // window capture + body bubble see one key.
      lastEvent = event;
      var code = event.keyCode || event.which;
      count += 1;
      lastKey = keyName(code);
      text('key-status', 'keydown: ' + count + '; последняя: ' + lastKey);
      text('no-key-status', 'События кнопок поступают в страницу.');

      // Give Samsung IME its own arrows and character keys. Never log values.
      if (editing) {
        if (code === 65376 || code === 65385) {
          global.setTimeout(finishEdit, 0);
        } else if (code === 10009 || code === 27) {
          finishEdit();
          event.preventDefault();
        }
        return;
      }
      if (code === 38 || code === 40) {
        select(index + (code === 38 ? -1 : 1));
      } else if (code === 37 || code === 39) {
        if (!options.onHorizontal || !options.onHorizontal(ids[index], code === 37 ? -1 : 1)) {
          select(index + (code === 37 ? -1 : 1));
        }
      } else if (code === 13) {
        items[index].click();
      } else if (code === 10009 || code === 27) {
        options.onBack();
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }

    for (i = 0; i < ids.length; i += 1) {
      (function (itemIndex) {
        var item = element(ids[itemIndex]);
        if (!item) throw new Error('Missing navigation item: ' + ids[itemIndex]);
        items.push(item);
        item.addEventListener('focus', function () {
          if (!editing) select(itemIndex);
        });
        item.addEventListener('click', function () {
          if (editing) return;
          select(itemIndex);
          options.onActivate(ids[itemIndex], api);
        });
      }(i));
    }

    var api = { select: select, beginEdit: beginEdit, finishEdit: finishEdit,
      getCount: function () { return count; } };
    if (options.inputIds) {
      for (i = 0; i < options.inputIds.length; i += 1) {
        (function (field) {
          if (!field) throw new Error('Missing input field');
          field.addEventListener('blur', function () {
            if (editing !== field) return;
            editing = null;
            text('input-status', 'Ввод закрыт. Значения не показаны в диагностике.');
            global.setTimeout(function () { select(index); }, 0);
          });
        }(element(options.inputIds[i])));
      }
    }
    text('script-status', 'JavaScript работает: 0 с');
    text('key-status', 'keydown: 0; последняя: —');
    text('no-key-status', 'Нажмите стрелку. Если счётчик останется 0, keydown не поступает.');
    select(0);
    global.addEventListener('keydown', keydown, true);
    if (document.body) document.body.addEventListener('keydown', keydown, false);
    global.setInterval(function () {
      seconds += 1;
      text('script-status', 'JavaScript работает: ' + seconds + ' с');
      if (count === 0 && seconds >= 8) {
        text('no-key-status', 'Событий пока нет. Если стрелку уже нажимали, keydown не поступает.');
      }
    }, 1000);
    global.addEventListener('error', function () {
      text('script-status', 'Ошибка JavaScript на странице (без деталей и реквизитов).');
    });
    return api;
  }

  global.createRemoteNavigation = createRemoteNavigation;
}(window));

// Polls the local cic daemon for commands and runs them in tabs this extension opened.
const DAEMON = 'http://127.0.0.1:18765';
const GROUP_TITLE = 'cic';
const attached = new Set();
const network = new Map(); // tabId -> [{ id, method, url, status, type }]
const consoleLog = new Map(); // tabId -> [{ level, text }]
const dialogs = new Map(); // tabId -> { type, message } of an open alert/confirm/prompt

const cdp = (tabId, method, params = {}) =>
  chrome.debugger.sendCommand({ tabId }, method, params);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const capped = (list, max = 500) => list.length > max && list.splice(0, list.length - max);

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  network.set(tabId, []);
  consoleLog.set(tabId, []);
  for (const domain of ['Network', 'Page', 'Runtime', 'Log']) await cdp(tabId, `${domain}.enable`);
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  const net = network.get(tabId);
  const logs = consoleLog.get(tabId);
  if (!net || !logs) return;
  switch (method) {
    case 'Network.requestWillBeSent':
      net.push({ id: params.requestId, method: params.request.method, url: params.request.url, type: params.type });
      capped(net);
      break;
    case 'Network.responseReceived': {
      const entry = net.find((r) => r.id === params.requestId);
      if (entry) entry.status = params.response.status;
      break;
    }
    case 'Network.loadingFailed': {
      const entry = net.find((r) => r.id === params.requestId);
      if (entry) entry.failed = params.blockedReason ?? (params.canceled ? 'canceled' : params.errorText);
      break;
    }
    case 'Runtime.consoleAPICalled':
      logs.push({
        level: params.type,
        text: params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
      });
      capped(logs);
      break;
    case 'Runtime.exceptionThrown':
      logs.push({ level: 'exception', text: params.exceptionDetails.exception?.description ?? params.exceptionDetails.text });
      capped(logs);
      break;
    case 'Log.entryAdded':
      logs.push({ level: params.entry.level, text: `${params.entry.source}: ${params.entry.text}` });
      capped(logs);
      break;
    case 'Page.javascriptDialogOpening':
      dialogs.set(tabId, { type: params.type, message: params.message });
      break;
    case 'Page.javascriptDialogClosed':
      dialogs.delete(tabId);
      break;
  }
});

/** Only tabs in the cic group are ours to drive. */
async function ownTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('tab must be a tab id (see `cic tabs`)');
  const tab = await chrome.tabs.get(tabId);
  const group = tab.groupId >= 0 ? await chrome.tabGroups.get(tab.groupId) : null;
  if (group?.title !== GROUP_TITLE) throw new Error(`tab ${tabId} is not in the "${GROUP_TITLE}" group`);
  await attach(tabId);
  return tab;
}

async function evaluate(tabId, expression) {
  const { result, exceptionDetails } = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function waitForLoad(tabId) {
  for (let i = 0; i < 150; i++) {
    if (dialogs.has(tabId)) return;
    if ((await evaluate(tabId, 'document.readyState').catch(() => '')) === 'complete') return;
    await sleep(200);
  }
}

/** `@e12` (a ref from `snapshot`) or a CSS selector, as a selector. */
const toSelector = (target) =>
  /^@e\d+$/.test(target) ? `[data-cic-ref="${target.slice(1)}"]` : target;

/** The viewport centre of an element, scrolled into view. */
async function centre(tabId, target) {
  const selector = JSON.stringify(toSelector(target));
  return evaluate(
    tabId,
    `(() => { const el = document.querySelector(${selector});
      if (!el) throw new Error('no element for ' + ${JSON.stringify(target)});
      el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
}

const point = async (tabId, { target, x, y }) => (target ? centre(tabId, target) : { x, y });

const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const NAMED_KEYS = {
  enter: ['Enter', 13, '\r'], tab: ['Tab', 9], escape: ['Escape', 27], esc: ['Escape', 27],
  backspace: ['Backspace', 8], delete: ['Delete', 46], space: [' ', 32, ' '],
  arrowup: ['ArrowUp', 38], arrowdown: ['ArrowDown', 40], arrowleft: ['ArrowLeft', 37],
  arrowright: ['ArrowRight', 39], up: ['ArrowUp', 38], down: ['ArrowDown', 40],
  left: ['ArrowLeft', 37], right: ['ArrowRight', 39], home: ['Home', 36], end: ['End', 35],
  pageup: ['PageUp', 33], pagedown: ['PageDown', 34],
};

/** One key or combo, e.g. `Enter`, `cmd+a`, `shift+Tab`. */
function keyEvent(combo) {
  const parts = combo.split('+');
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIERS[m.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier ${m}`);
    modifiers |= bit;
  }
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) {
    const [key, code, text] = named;
    return { key, code: key, windowsVirtualKeyCode: code, modifiers, ...(text && !modifiers && { text }) };
  }
  if (name.length === 1) {
    const upper = name.toUpperCase();
    return {
      key: name,
      code: /[a-z]/i.test(name) ? `Key${upper}` : name,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      modifiers,
      ...(!(modifiers & ~8) && { text: name }),
    };
  }
  if (/^f\d{1,2}$/i.test(name)) {
    const n = Number(name.slice(1));
    return { key: `F${n}`, code: `F${n}`, windowsVirtualKeyCode: 111 + n, modifiers };
  }
  throw new Error(`unknown key ${name}`);
}

async function pressKey(tabId, combo) {
  const event = keyEvent(combo);
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: event.text ? 'keyDown' : 'rawKeyDown', ...event });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

async function clickAt(tabId, { x, y }, button = 'left', clickCount = 1) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let n = 1; n <= clickCount; n++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: n });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: n });
  }
}

// Marks interactive and landmark elements with data-cic-ref and lists them, like read_page.
const SNAPSHOT = (all, filter) => `(() => {
  const ALL = ${all}; const FILTER = ${JSON.stringify(filter ?? '').toLowerCase()};
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=option],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const LANDMARK = 'h1,h2,h3,h4,[role=dialog],[role=alert],table,th,label,img[alt]';
  let n = Number(document.body.dataset.cicNext || 0);
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
    el.getAttribute('placeholder') || (el.labels && el.labels[0] && el.labels[0].innerText) ||
    el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const role = (el) => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' })[el.tagName] ||
    (el.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button' })[el.type] || 'textbox' : el.tagName.toLowerCase());
  const lines = [];
  for (const el of document.querySelectorAll(ALL ? INTERACTIVE + ',' + LANDMARK : INTERACTIVE)) {
    if (!visible(el)) continue;
    const label = name(el);
    if (FILTER && !(label.toLowerCase().includes(FILTER) || role(el).includes(FILTER))) continue;
    if (!el.dataset.cicRef) el.dataset.cicRef = 'e' + (++n);
    const r = el.getBoundingClientRect();
    const state = [el.disabled && 'disabled', el.checked && 'checked', el.getAttribute('aria-expanded') === 'true' && 'expanded',
      el.getAttribute('aria-selected') === 'true' && 'selected', 'value' in el && el.value && el.tagName !== 'BUTTON' && 'value=' + JSON.stringify(String(el.value).slice(0, 40))].filter(Boolean);
    lines.push('@' + el.dataset.cicRef + ' ' + role(el) + ' "' + label + '"' + (state.length ? ' [' + state.join(', ') + ']' : '') +
      ' (' + Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2) + ')');
  }
  document.body.dataset.cicNext = n;
  return lines.join('\\n') || '(nothing matched)';
})()`;

async function screenshot(tabId, clip) {
  await chrome.tabs.update(tabId, { active: true });
  const view = await evaluate(tabId, '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
  // CSS-pixel sized, so a point on the image is the point `click` takes.
  const area = clip ?? { x: 0, y: 0, width: view.w, height: view.h };
  const scale = (clip ? Math.max(1, Math.min(4, 800 / Math.max(area.width, area.height))) : 1) / view.dpr;
  const { data } = await cdp(tabId, 'Page.captureScreenshot', {
    format: 'png',
    clip: { ...area, scale: scale * view.dpr },
  });
  return { png: data, width: Math.round(area.width * scale * view.dpr), height: Math.round(area.height * scale * view.dpr), zoom: scale * view.dpr };
}

const commands = {
  async tabs() {
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
    const tabs = (await Promise.all(groups.map((g) => chrome.tabs.query({ groupId: g.id })))).flat();
    return tabs.map(({ id, url, title, active }) => ({ id, url, title, active }));
  },
  async open({ url }) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE });
    const groupId = await chrome.tabs.group({ tabIds: tab.id, ...(group && { groupId: group.id }) });
    if (!group) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple' });
    await attach(tab.id);
    await cdp(tab.id, 'Page.navigate', { url });
    await waitForLoad(tab.id);
    return { id: tab.id, url: await evaluate(tab.id, 'location.href') };
  },
  async navigate({ tab, url }) {
    await ownTab(tab);
    if (url === 'back' || url === 'forward') {
      await evaluate(tab, `history.${url}()`);
      await sleep(300);
    } else if (url === 'reload') {
      await cdp(tab, 'Page.reload');
    } else {
      await cdp(tab, 'Page.navigate', { url });
    }
    await waitForLoad(tab);
    return { url: await evaluate(tab, 'location.href') };
  },
  async screenshot({ tab, region }) {
    await ownTab(tab);
    const clip = region && { x: region[0], y: region[1], width: region[2] - region[0], height: region[3] - region[1] };
    return screenshot(tab, clip);
  },
  async snapshot({ tab, all, filter }) {
    await ownTab(tab);
    return evaluate(tab, SNAPSHOT(Boolean(all), filter));
  },
  async eval({ tab, js }) {
    await ownTab(tab);
    return evaluate(tab, js);
  },
  async text({ tab }) {
    await ownTab(tab);
    return evaluate(tab, 'document.body.innerText');
  },
  async click({ tab, target, x, y, button = 'left', count = 1 }) {
    await ownTab(tab);
    const at = await point(tab, { target, x, y });
    await clickAt(tab, at, button, count);
    return at;
  },
  async hover({ tab, target, x, y }) {
    await ownTab(tab);
    const at = await point(tab, { target, x, y });
    await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
    return at;
  },
  async drag({ tab, from, to }) {
    await ownTab(tab);
    const a = await point(tab, from);
    const b = await point(tab, to);
    await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...a });
    await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...a, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 10; i++) {
      await cdp(tab, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: a.x + ((b.x - a.x) * i) / 10, y: a.y + ((b.y - a.y) * i) / 10, button: 'left', buttons: 1,
      });
    }
    await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...b, button: 'left', clickCount: 1 });
    return { from: a, to: b };
  },
  async scroll({ tab, direction = 'down', amount = 3, target }) {
    await ownTab(tab);
    if (target && !direction) return centre(tab, target);
    const at = target ? await centre(tab, target) : await evaluate(tab, '({ x: innerWidth / 2, y: innerHeight / 2 })');
    const px = 100 * amount;
    const delta = { up: [0, -px], down: [0, px], left: [-px, 0], right: [px, 0] }[direction];
    if (!delta) throw new Error('direction is up, down, left or right');
    await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...at, deltaX: delta[0], deltaY: delta[1] });
    await sleep(300);
    return evaluate(tab, '({ scrollX, scrollY })');
  },
  async scrollto({ tab, target }) {
    await ownTab(tab);
    return centre(tab, target);
  },
  async type({ tab, text }) {
    await ownTab(tab);
    await cdp(tab, 'Input.insertText', { text });
    return { typed: text.length };
  },
  async key({ tab, keys, repeat = 1 }) {
    await ownTab(tab);
    for (let i = 0; i < repeat; i++) for (const combo of keys) await pressKey(tab, combo);
    return { keys, repeat };
  },
  async fill({ tab, target, value }) {
    await ownTab(tab);
    const selector = JSON.stringify(toSelector(target));
    return evaluate(
      tab,
      `(() => { const el = document.querySelector(${selector});
        if (!el) throw new Error('no element for ' + ${JSON.stringify(target)});
        const value = ${JSON.stringify(value)};
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked !== (value === 'true')) el.click();
          return { checked: el.checked };
        }
        if (el.tagName === 'SELECT') {
          const option = [...el.options].find(o => o.value === value || o.text.trim() === value);
          if (!option) throw new Error('no option ' + value);
          el.value = option.value;
        } else {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: el.value }; })()`,
    );
  },
  async upload({ tab, target, files }) {
    await ownTab(tab);
    const { root } = await cdp(tab, 'DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp(tab, 'DOM.querySelector', { nodeId: root.nodeId, selector: toSelector(target) });
    if (!nodeId) throw new Error(`no element for ${target}`);
    await cdp(tab, 'DOM.setFileInputFiles', { nodeId, files });
    return { files };
  },
  async wait({ tab, target, ms }) {
    await ownTab(tab);
    if (ms) {
      await sleep(ms);
      return { waited: ms };
    }
    const selector = JSON.stringify(toSelector(target));
    for (let i = 0; i < 150; i++) {
      if (await evaluate(tab, `!!document.querySelector(${selector})`)) return { found: target };
      await sleep(200);
    }
    throw new Error(`${target} did not appear in 30s`);
  },
  async network({ tab, filter, clear }) {
    await ownTab(tab);
    const log = network.get(tab) ?? [];
    const rows = log.filter((r) => !filter || r.url.includes(filter));
    if (clear) network.set(tab, []);
    return rows.map(({ method, url, status, failed, type }) => ({ method, url, status, failed, type }));
  },
  async body({ tab, filter }) {
    await ownTab(tab);
    // A URL ending in the filter beats one that only contains it (`host/` vs `host/favicon.ico`).
    const done = (network.get(tab) ?? []).filter((r) => r.url.includes(filter) && r.status && r.method !== 'OPTIONS');
    const entry = done.filter((r) => r.url.split('?')[0].endsWith(filter)).pop() ?? done.pop();
    if (!entry) throw new Error(`no finished request matching ${filter}`);
    const { body, base64Encoded } = await cdp(tab, 'Network.getResponseBody', { requestId: entry.id });
    return { url: entry.url, status: entry.status, body: base64Encoded ? `(base64, ${body.length} chars)` : body };
  },
  async console({ tab, filter, clear }) {
    await ownTab(tab);
    const log = consoleLog.get(tab) ?? [];
    const pattern = filter ? new RegExp(filter, 'i') : null;
    const rows = log.filter((r) => !pattern || pattern.test(r.text));
    if (clear) consoleLog.set(tab, []);
    return rows;
  },
  async dialog({ tab, action, text }) {
    await ownTab(tab);
    const open = dialogs.get(tab);
    if (!action) return open ?? null;
    if (!open) throw new Error('no dialog is open');
    await cdp(tab, 'Page.handleJavaScriptDialog', { accept: action === 'accept', ...(text && { promptText: text }) });
    return { [action]: open };
  },
  async resize({ tab, width, height }) {
    const { windowId } = await ownTab(tab);
    await chrome.windows.update(windowId, { width, height, state: 'normal' });
    return evaluate(tab, '({ innerWidth, innerHeight })');
  },
  async close({ tab }) {
    await ownTab(tab);
    await chrome.tabs.remove(tab);
    return { closed: tab };
  },
  async version() {
    return { extension: chrome.runtime.getManifest().version };
  },
  async reload() {
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: true };
  },
};

async function run({ cmd, args }) {
  const handler = commands[cmd];
  if (!handler) throw new Error(`unknown command ${cmd}`);
  return handler(args ?? {});
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      chrome.runtime.getPlatformInfo(); // keeps the service worker awake between commands
      let job;
      try {
        const res = await fetch(`${DAEMON}/next`);
        if (res.status === 204) continue;
        job = await res.json();
      } catch {
        await sleep(2000); // daemon not running yet
        continue;
      }
      let reply;
      try {
        reply = { id: job.id, ok: true, value: await run(job) };
      } catch (error) {
        reply = { id: job.id, ok: false, error: String(error?.message ?? error) };
      }
      await fetch(`${DAEMON}/result`, { method: 'POST', body: JSON.stringify(reply) }).catch(() => {});
    }
  } finally {
    polling = false;
  }
}

chrome.alarms.create('cic-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(poll);
chrome.runtime.onStartup.addListener(poll);
chrome.runtime.onInstalled.addListener(poll);
poll();

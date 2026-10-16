// mini webpack-5 runtime loader for dumped qcact modules (runs official sign code in Node)
const fs = require('fs');
const path = require('path');

// --- environment shims (only what the sign modules touch) ---
const fakeWindow = {};
global.window = fakeWindow;
global.self = fakeWindow;
global.navigator = { userAgent: 'UA_PLACEHOLDER' };
global.location = { href: 'https://cloud.tencent.com/act/pro/featured-202607', pathname: '/act/pro/featured-202607', hostname: 'cloud.tencent.com', protocol: 'https:', search: '', hash: '' };
global.document = {
  cookie: '',
  createElement: () => ({ setAttribute() {}, style: {}, appendChild() {}, removeChild() {}, getElementsByTagName: () => [], children: [], childNodes: [] }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { clientWidth: 1920, appendChild() {}, removeChild() {} },
  documentElement: { clientWidth: 1920 },
  addEventListener() {}, removeEventListener() {},
  createEvent: () => ({ initEvent() {} }),
  location: global.location,
  head: { appendChild() {} }
};
global.history = { replaceState() {}, pushState() {}, go() {}, back() {} };
global.CustomEvent = class CustomEvent { constructor(type, opts) { this.type = type; Object.assign(this, opts && opts.detail); } };
global.getComputedStyle = () => ({ getPropertyValue: () => '' });
global.screen = {};

const moduleSources = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime', 'modules.json'), 'utf8'));

function __webpack_require__(moduleId) {
  const cached = __webpack_require__.c[moduleId];
  if (cached !== undefined) return cached.exports;
  const module = __webpack_require__.c[moduleId] = { id: moduleId, loaded: false, exports: {} };
  const src = __webpack_require__.m[moduleId];
  if (!src) throw new Error('module not found: ' + moduleId);
  const wrapper = new Function('module', 'exports', '__webpack_require__', 'return (' + src + ');');
  const factory = wrapper(); // wrapper returns the actual module factory
  factory.call(module.exports, module, module.exports, __webpack_require__);
  module.loaded = true;
  return module.exports;
}
__webpack_require__.m = moduleSources;
__webpack_require__.c = {};
__webpack_require__.d = (exports, definition) => {
  for (const key in definition) {
    if (__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
      Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
    }
  }
};
__webpack_require__.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
__webpack_require__.r = (exports) => {
  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
  Object.defineProperty(exports, '__esModule', { value: true });
};
__webpack_require__.n = (module) => {
  const getter = module && module.__esModule ? () => module['default'] : () => module;
  __webpack_require__.d(getter, { a: getter });
  return getter;
};
__webpack_require__.g = (() => { if (typeof globalThis !== 'undefined') return globalThis; return typeof self !== 'undefined' ? self : this; })();
__webpack_require__.nmd = (module) => {
  module.paths = [];
  if (!module.children) module.children = [];
  return module;
};

async function signDss({ method, path: pathname, params, data, ua, skey, time }) {
  const yo = __webpack_require__(8579);
  const header = await yo.dm.he();
  const value = await yo.dm.ge([method, , pathname, , params, , data, , , ua, skey], time);
  return { header, value };
}

module.exports = { signDss, __webpack_require__ };

if (require.main === module) {
  const ua = process.env.UA || 'UA_PLACEHOLDER';
  const time = Number(process.env.TS || Date.now());
  const expected = process.env.EXPECT_SIG;
  signDss({
    method: 'post',
    path: '/dianshi/do-goods',
    params: { activity_id: 164461404341040 },
    data: { activity_id: 164461404341040, goods: [], preview: 0 },
    ua, skey: 'skey_test_123', time
  }).then(r => {
    console.log('header:', r.header);
    console.log('value:', JSON.stringify(r.value));
    if (expected) console.log('MATCH:', r.value[0] === expected ? 'YES' : 'NO (expected ' + expected + ')');
  }).catch(e => { console.error('SIGN ERROR:', e); process.exit(1); });
}


/* 把 #subbar 从 #page-yue（会被 display:none）里挪到 body 直属，两页共用才不会跟着隐藏 */
const fs = require('fs');
const P = 'C:/Users/Leo/WorkBuddy/相亲合拍率/match/public/index.html';
let s = fs.readFileSync(P, 'utf8');

const START = '  <div class="subbar hide" id="subbar">';
const END = '      <div class="subttl" id="subTitle"></div>\n    </div>\n  </div>\n';
const i = s.indexOf(START), j = s.indexOf(END);
if (i < 0 || j < 0) { console.error('FAIL 找不到 subbar 块'); process.exit(1); }
const block = s.slice(i, j + END.length);

s = s.slice(0, i) + s.slice(j + END.length);          // 摘出来
s = s.replace('<body>\n<div class="wrap">', '<body>\n' + block + '\n<div class="wrap">');
s = s.replace(/<div class="wrap">\n\n(  <header id="yueHead")/, '<div class="wrap">\n$1'); // 清掉留下的空行

fs.writeFileSync(P, s, 'utf8');

/* 自检 */
const t = fs.readFileSync(P, 'utf8');
const pb = t.indexOf('<body>'), pw = t.indexOf('<div class="wrap">'), ps = t.indexOf('id="subbar"');
console.log('body@' + pb + '  subbar@' + ps + '  wrap@' + pw);
console.log('subbar 在 wrap 之前 =', ps < pw, '（必须 true）');
console.log('subbar 块数 =', (t.match(/id="subbar"/g) || []).length);
console.log('长度', t.length);

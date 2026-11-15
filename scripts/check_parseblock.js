/* 单独验证解析块是否泄漏内部字段。 */
const fs = require('fs'), path = require('path');
const PUB = path.join(__dirname, '..', 'match', 'public');
const cache = {};
function mkEl() { return { innerHTML:'', textContent:'', style:{},
  classList:{toggle(){},add(){},remove(){},contains(){return false}},
  querySelectorAll:()=>[], querySelector:()=>null }; }
global.document = { getElementById: id => (cache[id] || (cache[id] = mkEl())) };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.window = { scrollTo(){} };
global.fetch = async () => ({ json: async () => ({ ok:true }) });
eval(fs.readFileSync(path.join(PUB,'questions.js'),'utf8') + '\n' +
     fs.readFileSync(path.join(PUB,'app.js'),'utf8'));

const dirty = { age:28, income:25, house:2, marital:-1, looks:4, gates:['house'],
  range:{ ageMin:26, ageMax:34, hMin:173, hMax:null, incomeMin:undefined },
  notes:['已购房且首付由父母出资 → 家庭支持力记 1'],
  unknown:['职业','confidence'],
  romanceExp:1, personality:4.5, edu:5,
  selfLevel:'中高', mismatch:true, confidence:'high' };

const h = parseBlock(dirty, '测试');
console.log('--- parseBlock 输出 ---');
console.log(h);
console.log('\n--- 泄漏检查 ---');
['selfLevel','自评档位','mismatch','confidence'].forEach(w => {
  console.log(`  ${w}: ${h.includes(w) ? '❌ 泄漏' : '✓ 未出现'}`);
});
console.log('\nPARSE_HIDDEN =', [...(typeof PARSE_HIDDEN !== 'undefined' ? PARSE_HIDDEN : [])]);

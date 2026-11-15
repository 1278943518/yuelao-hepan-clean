/* 生成两个「定格」截图页：星盘结果页 / 月老档案页（给无头 Edge 截图用） */
const fs = require('fs');
const src = 'C:/Users/Leo/WorkBuddy/相亲合拍率/match-combo/public/combo.html';
const base = fs.readFileSync(src, 'utf8');

function make(file, body) {
  const h = base.replace(/<\/body>\s*<\/html>\s*$/,
    '<script>\n(function(){\n' + body + '\n})();\n</script>\n</body>\n</html>\n');
  fs.writeFileSync('C:/Users/Leo/WorkBuddy/相亲合拍率/match-combo/public/' + file, h);
  console.log('written', file, h.length);
}

make('shot_xing_result.html', `
  switchTab('xing');
  window.XP.fillSample();
  document.getElementById('xp-runBtn').click();
`);

make('shot_yue_form.html', `
  switchTab('yue');
  setTimeout(function(){ try { openForm('me'); } catch(e){} }, 50);
`);

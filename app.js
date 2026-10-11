const $=s=>document.querySelector(s), cats={餐饮:['正餐','饮料','咖啡','零食','外卖'],购物:['服饰','美妆','日用品','数码','其他'],交通:['公交地铁','打车','火车','飞机'],娱乐:['电影','游戏','演出','旅游'],教育:['书籍','课程','软件','AI服务'],居住:['房租','水电','生活服务'],医疗:['药品','医疗服务'],其他:['待确认','其他']};
let file=null,records=[],review=[],exportRows=[],modelAccepted=0,modelFailed=false,modelStatus='未调用';
const apiInput=$('#apiUrl'),runtimeNotice=$('#runtimeNotice');if(location.protocol==='file:'){apiInput.value='http://127.0.0.1:8787/api/classify';runtimeNotice.textContent='本地文件页面将把待分类交易 POST 到本机模型服务。请先启动 node server.mjs 并在服务端配置 LLM_API_KEY；如服务未运行，结果会显示连接失败。';runtimeNotice.classList.remove('hidden')}else apiInput.value=new URL('/api/classify',location.href).href;
$('#file').onchange=e=>{file=e.target.files[0];$('#fileName').textContent=file?.name||'';$('#importBtn').disabled=!file};
$('#importBtn').onclick=async()=>{try{const rows=await parseFile(file);records=normalize(rows);if(!records.length)throw Error('没有找到交易明细，请确认选择的是微信支付账单。');const before=records.length;let ids=new Set();records=records.filter(r=>{let k=r.id||[r.date,r.merchant,r.item,r.amount,r.direction].join('|');if(ids.has(k))return false;ids.add(k);return true});await classify();renderSummary(before);$('#summaryView').classList.remove('hidden');$('#importView').classList.add('hidden')}catch(e){alert(e.message||'解析失败')}};
async function parseFile(f){if(/\.xlsx?$|\.xlsm$/i.test(f.name)){if(!window.XLSX)throw Error('表格解析组件未加载，请联网后重试。');let wb=XLSX.read(await f.arrayBuffer(),{type:'array'});return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:''})}let text=await f.text();if(text.includes('�'))text=new TextDecoder('gb18030').decode(await f.arrayBuffer());return csvRows(text)}
function csvRows(s){let out=[],row=[],v='',q=false;for(let i=0;i<s.length;i++){let c=s[i];if(q){if(c==='"'&&s[i+1]==='"'){v+='"';i++}else if(c==='"')q=false;else v+=c}else if(c==='"')q=true;else if(c===','){row.push(v);v=''}else if(c==='\n'){row.push(v.replace(/\r$/,''));out.push(row);row=[];v=''}else v+=c}if(v||row.length){row.push(v);out.push(row)}return out}
function normalize(raw){let hi=raw.findIndex(r=>r.includes('交易时间')&&r.includes('交易类型')&&r.some(x=>String(x).includes('金额')));if(hi<0)throw Error('未找到微信账单表头（交易时间、交易类型、金额）。');let headers=raw[hi].map(x=>String(x).trim().replace('金额（元）','金额(元)'));return raw.slice(hi+1).filter(r=>r.some(x=>String(x).trim())).map(r=>{let x={};headers.forEach((h,i)=>x[h]=String(r[i]??'').trim());return {date:x['交易时间']||'',type:x['交易类型']||'',merchant:x['交易对方']||'',item:x['商品']||'',direction:x['收/支']||'',amount:Math.abs(Number((x['金额(元)']||'0').replace(/[￥¥,元]/g,'')))||0,status:x['当前状态']||'',id:x['交易单号']||'',note:x['备注']||'',raw:x}}).filter(x=>x.date&&x.amount)}
async function classify(){
 review=[];exportRows=[];modelAccepted=0;modelFailed=false;modelStatus='未调用';let candidates=[];
 const ownAccount=$('#account').value||'微信支付';
 for(const r of records){
  const sourceText=Object.values(r.raw||{}).join(' '),allText=[r.type,r.direction,r.merchant,r.item,r.status,r.note,sourceText].join(' ');
  const isRefund=/退款/.test(allText),isTransfer=/转账|红包|信用卡还款/.test(allText),isIncome=r.direction==='收入';
  // Special transaction types are converted locally and never sent to the model.
  if(isRefund){exportRows.push(toExport(r,{category:'其他',subcategory:'其他'},'收入',ownAccount,''));continue}
  if(isTransfer){
   const counterparty=r.merchant||r.item||'对方';
   const incoming=isIncome||r.direction==='收入';
   exportRows.push(toExport(r,{category:'',subcategory:''},'转账',incoming?counterparty:ownAccount,incoming?ownAccount:counterparty));continue;
  }
  if(isIncome){exportRows.push(toExport(r,{category:'其他',subcategory:'其他'},'收入',ownAccount,''));continue}
  let guess=keyword(allText);if(guess)exportRows.push(toExport(r,guess,'支出',ownAccount,''));else candidates.push(r)
 }
 if($('#useAI').checked&&candidates.length){
  const url=$('#apiUrl').value.trim();
  if(!url){modelStatus='未调用（未设置模型地址）';review.push(...candidates.map(r=>({...r,category:'其他',subcategory:'待确认',reason:modelStatus+'；请手动分类'})))}
  else{
   for(let i=0;i<candidates.length;i+=30){
    try{
     const batch=candidates.slice(i,i+30),res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({transactions:batch.map((r,j)=>({index:j,merchant:r.merchant,item:r.item,type:r.type,amount:r.amount,note:r.note}))})});
     if(!res.ok)throw Error('模型服务返回 '+res.status);
     const data=await res.json(),results=data.results||[];
     batch.forEach((r,j)=>{const c=results.find(z=>z.index===j)||{};if(!cats[c.category]?.includes(c.subcategory)||Number(c.confidence)<.60||c.needsReview===true)review.push({...r,category:cats[c.category]?c.category:'其他',subcategory:cats[c.category]?.includes(c.subcategory)?c.subcategory:'待确认',reason:c.reason||'模型把握不足，请确认'});else{exportRows.push(toExport(r,c,'支出',ownAccount,''));modelAccepted++}})
    }catch(e){modelFailed=true;candidates.slice(i,i+30).forEach(r=>review.push({...r,category:'其他',subcategory:'待确认',reason:'模型分类失败：'+e.message}))}
   }
   modelStatus=modelFailed?'请求失败（查看待确认原因）':'调用成功';
  }
 }else if(candidates.length){modelStatus='未启用';review.push(...candidates.map(r=>({...r,category:'其他',subcategory:'待确认',reason:'需要手动选择分类'})))}
}
function keyword(s){let rules=[['蜜雪冰城','餐饮','饮料'],['霸王茶姬','餐饮','饮料'],['喜茶','餐饮','饮料'],['瑞幸','餐饮','咖啡'],['星巴克','餐饮','咖啡'],['咖啡','餐饮','咖啡'],['食堂','餐饮','正餐'],['地铁','交通','公交地铁'],['公交','交通','公交地铁'],['打车','交通','打车'],['电影','娱乐','电影'],['药店','医疗','药品'],['DeepSeek','教育','AI服务']];for(let [k,a,b] of rules)if(s.toLowerCase().includes(k.toLowerCase()))return {category:a,subcategory:b,confidence:1};return null}
function toExport(r,c,type='支出',account1=$('#account').value||'微信支付',account2=''){const source=Object.entries(r.raw||{}).filter(([,v])=>String(v||'').trim()).map(([k,v])=>`${k}=${v}`).join(' | ');return {日期:dateForIcost(r.date),类型:type,金额:Number(r.amount.toFixed(2)),一级分类:c.category||'',二级分类:c.subcategory||'',账户1:account1,账户2,备注:source||[r.merchant,r.item,r.note,r.id].filter(Boolean).join(' | '),货币:'CNY',标签:''}}
function dateForIcost(s){let v=String(s||'').trim().replaceAll('/','-');return v}
function renderSummary(original){let auto=exportRows.length;$('#summaryView').innerHTML=`<h2>本次账单</h2><div class="stats"><div class="stat"><b>${records.length}</b><span>有效记录</span></div><div class="stat"><b>${auto}</b><span>可导出</span></div><div class="stat"><b>${review.length}</b><span>待确认</span></div></div><p class="muted">本文件去除重复 ${original-records.length} 笔；退款、转账及收入已保留原始字段并直接转换为 iCost 格式，不调用模型。模型自动分类 ${modelAccepted} 笔；${modelStatus}。页面版本 v5。</p><div class="row"><button class="secondary" id="reviewBtn">审核 ${review.length} 笔</button><button class="primary" id="exportBtn">检查并导出</button></div>`;$('#reviewBtn').onclick=()=>renderReview();$('#exportBtn').onclick=()=>renderExport()}
function renderReview(){let i=0;$('#reviewView').classList.remove('hidden');function draw(){if(i>=review.length){$('#reviewView').innerHTML='<h2>待确认已处理</h2><p>现在可以检查并导出。</p><button class="primary" id="done">继续</button>';$('#done').onclick=()=>renderExport();return}let r=review[i];$('#reviewView').innerHTML=`<div class="row"><h2>待确认 ${i+1}/${review.length}</h2><span class="badge">需确认</span></div><div class="transaction"><strong>${esc(r.merchant||'未知商户')}</strong><span class="amount">¥${r.amount.toFixed(2)}</span><p class="muted">${esc(r.date)}<br>${esc(r.item||r.type)}<br>${esc(r.reason)}</p></div><div class="chips">${Object.entries(cats).flatMap(([a,subs])=>subs.filter(b=>b!=='待确认').map(b=>`<button data-a="${a}" data-b="${b}">${a} · ${b}</button>`)).join('')}</div><button class="secondary" id="skip">暂不分类</button>`;$('#reviewView').querySelectorAll('[data-a]').forEach(b=>b.onclick=()=>{exportRows.push(toExport(r,{category:b.dataset.a,subcategory:b.dataset.b}));review.splice(i,1);draw()});$('#skip').onclick=()=>{i++;draw()}}draw()}
function renderExport(){const total=exportRows.filter(r=>r.类型==='支出').reduce((n,r)=>n+Number(r.金额),0);$('#exportView').classList.remove('hidden');$('#exportView').innerHTML=`<h2>导出预览</h2><div class="stats"><div class="stat"><b>${exportRows.length}</b><span>导出记录</span></div><div class="stat"><b>¥${total.toFixed(2)}</b><span>支出合计</span></div><div class="stat"><b>${review.length}</b><span>仍待确认</span></div></div>${review.length?'<div class="notice">仍有未分类记录，它们不会进入 iCost 导入文件。</div>':''}<p class="muted">导出列顺序已按你给的模板：日期、类型、金额、一级分类、二级分类、账户1、账户2、备注、货币、标签。</p><button class="primary" id="download">下载 iCost CSV</button><button class="secondary" id="more">返回审核</button>`;$('#download').onclick=()=>downloadCsv(exportRows,'icost_import_v5.csv');$('#more').onclick=()=>renderReview()}
function downloadCsv(rows,name){if(!rows.length){alert('没有记录');return}let cols=Object.keys(rows[0]),csv='\ufeff'+[cols,...rows.map(r=>cols.map(k=>r[k]??''))].map(a=>a.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n'),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url)}function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
